import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  type BackupBatchReceipt,
  BackupBatchReceiptSchema,
  type BackupBatchState,
  type BackupDb,
  type BackupManifest,
  type BackupObservation,
  type BackupSource,
  BackupSourceSchema,
  type PublishBackupBatch,
  PublishBackupBatchSchema,
  type StartBackupBatch,
  StartBackupBatchSchema,
  ZhaoyeError,
} from '@zhaoye/contracts';
import { ensureDir, hashBytes, ioError, isMissing, writeAtomic } from './atomic-fs.js';
import { openDataRoot } from './data-root.js';
import {
  backupManifestPath,
  copyBackupArtifacts,
  fileDigest,
  readBackupManifest,
} from './internal/backup-artifacts.js';
import { listBackupBatches, readBackupRecords, searchBackupRows } from './internal/backup-query.js';
import { BACKUP_SCHEMA, BACKUP_SCHEMA_VERSION } from './internal/backup-schema.js';

interface BatchRow {
  batch_id: string;
  source_id: string;
  scope_key: string;
  status: 'running' | 'complete' | 'partial' | 'failed';
  capture_mode: 'live' | 'historical';
  source_format: string;
  converter_version: string;
  captured_at: string | null;
  captured_at_kind: string | null;
  raw_manifest: string | null;
  raw_sha256: string | null;
  receipt_json: string | null;
}

const databasePath = (root: string) => join(root, 'backup', 'zhaoye.db');
const canonicalJson = (value: unknown) =>
  JSON.stringify(value, (_, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : item,
  );

function parseInput<T>(
  schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } },
  input: unknown,
): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ZhaoyeError('INVALID_INPUT', '备份请求不符合契约');
  return result.data;
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = work();
    try {
      db.exec('COMMIT');
    } catch (error) {
      throw new ZhaoyeError('COMMIT_UNKNOWN', '备份提交结果需要核对', { cause: String(error) });
    }
    return value;
  } catch (error) {
    // The original failure remains the useful diagnostic if SQLite already rolled back.
    try {
      db.exec('ROLLBACK');
    } catch {
      // Best effort.
    }
    throw error;
  }
}

function readTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN');
  try {
    return work();
  } finally {
    db.exec('ROLLBACK');
  }
}

function sqliteError(error: unknown, path: string): ZhaoyeError {
  const code = (error as { errcode?: number } | null)?.errcode;
  if (code !== undefined && [11, 26].includes(code & 255))
    return new ZhaoyeError('CORRUPT_DATA', 'SQLite 备份库损坏', { path });
  if (code !== undefined && [5, 6].includes(code & 255))
    return new ZhaoyeError('LOCKED', 'SQLite 备份库正忙', { path });
  return ioError(error, path);
}

async function openSqlite(path: string, mode: 'read' | 'write' | 'create') {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, {
    readOnly: mode === 'read',
    enableForeignKeyConstraints: true,
  });
  try {
    db.exec('PRAGMA busy_timeout=3000; PRAGMA trusted_schema=OFF;');
    const checkSchema = () => {
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      if (version === 0 && mode === 'create') {
        const objects = db
          .prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
          .get();
        if (!objects) {
          db.exec(BACKUP_SCHEMA);
          db.prepare("INSERT INTO meta VALUES ('format','zhaoye-backup')").run();
          db.exec(`PRAGMA user_version=${BACKUP_SCHEMA_VERSION}`);
          return;
        }
      }
      if (version !== BACKUP_SCHEMA_VERSION)
        throw new ZhaoyeError('SCHEMA_MIGRATION_REQUIRED', '备份库版本不受支持', { path, version });
      const format = db.prepare("SELECT value FROM meta WHERE key='format'").get()?.value;
      if (format !== 'zhaoye-backup')
        throw new ZhaoyeError('CORRUPT_DATA', '备份库格式标记缺失', { path });
    };
    if (mode === 'create') transaction(db, checkSchema);
    else checkSchema();
    if (mode !== 'read' && db.prepare('PRAGMA journal_mode=WAL').get()?.journal_mode !== 'wal')
      throw new ZhaoyeError('STORAGE_FAILURE', '无法启用备份库 WAL', { path });
    return db;
  } catch (error) {
    db.close();
    throw sqliteError(error, path);
  }
}

function completeBatch(db: DatabaseSync, sourceId: string, scopeKey: string): string | null {
  const head = db
    .prepare('SELECT batch_id FROM backup_scope_heads WHERE source_id=? AND scope_key=?')
    .get(sourceId, scopeKey);
  return (head?.batch_id as string | undefined) ?? null;
}

function findBatch(db: DatabaseSync, id: string): BatchRow {
  const row = db
    .prepare(`
    SELECT b.*, o.receipt_json
    FROM import_batches b JOIN backup_operations o USING(batch_id)
    WHERE b.batch_id=?
  `)
    .get(id) as unknown as BatchRow | undefined;
  if (!row) throw new ZhaoyeError('NOT_FOUND', '找不到备份批次', { batchId: id });
  return row;
}

function terminalReceipt(row: BatchRow): BackupBatchReceipt {
  try {
    const receipt = BackupBatchReceiptSchema.parse(JSON.parse(row.receipt_json ?? 'null'));
    if (
      receipt.batchId === row.batch_id &&
      receipt.status === row.status &&
      receipt.sourceId === row.source_id &&
      receipt.scopeKey === row.scope_key &&
      receipt.capturedAt === row.captured_at &&
      receipt.rawSha256 === row.raw_sha256
    )
      return receipt;
  } catch {
    // Missing and invalid receipts are reported the same way.
  }
  throw new ZhaoyeError('CORRUPT_DATA', '备份批次回执不一致', { batchId: row.batch_id });
}

function saveReceipt(db: DatabaseSync, receipt: BackupBatchReceipt) {
  db.prepare('UPDATE backup_operations SET receipt_json=? WHERE batch_id=?').run(
    JSON.stringify(receipt),
    receipt.batchId,
  );
}

function observeRecords(
  db: DatabaseSync,
  batch: BatchRow,
  records: BackupObservation[],
  now: string,
) {
  const addRecord = db.prepare(`
    INSERT INTO source_records VALUES (?, ?, ?, ?)
    ON CONFLICT(source_id, native_id) DO NOTHING
  `);
  const selectRecord = db.prepare(
    'SELECT record_id FROM source_records WHERE source_id=? AND native_id=?',
  );
  const selectVersion = db.prepare(
    'SELECT version_id, kind, title, body FROM record_versions WHERE record_id=? AND content_hash=?',
  );
  const addVersion = db.prepare('INSERT INTO record_versions VALUES (?, ?, ?, ?, ?, ?, ?)');
  const indexVersion = db.prepare(
    'INSERT INTO record_fts(title, body, version_id) VALUES (?, ?, ?)',
  );
  const observe = db.prepare('INSERT INTO batch_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  let newVersions = 0;
  for (const row of records) {
    addRecord.run(randomUUID(), batch.source_id, row.nativeId, now);
    const recordId = selectRecord.get(batch.source_id, row.nativeId)?.record_id as string;
    let versionId: string | null = null;
    if (row.content) {
      const { kind, title, body } = row.content;
      const hash = hashBytes(canonicalJson(row.content));
      const old = selectVersion.get(recordId, hash);
      if (old) {
        if (old.kind !== kind || old.title !== title || old.body !== body)
          throw new ZhaoyeError('INTEGRITY_FAILED', '相同版本摘要对应不同内容');
        versionId = old.version_id as string;
      } else {
        versionId = randomUUID();
        addVersion.run(versionId, recordId, kind, title, body, hash, now);
        indexVersion.run(title, body, versionId);
        newVersions++;
      }
    }
    observe.run(
      batch.batch_id,
      batch.source_id,
      recordId,
      versionId,
      row.projectId,
      Number(row.searchAllowed),
      row.visibility,
      row.reason,
      row.sourceUpdatedAt,
      row.rawRef,
      canonicalJson(row.metadata),
    );
  }
  return newVersions;
}

function recordAbsences(db: DatabaseSync, batchId: string, previous: string): number {
  return Number(
    db
      .prepare(`
    INSERT INTO batch_records
    SELECT ?, old.source_id, old.record_id, old.version_id, old.project_id, 0,
      CASE WHEN old.visibility='deleted' THEN 'deleted' ELSE 'unavailable' END,
      CASE WHEN old.visibility='deleted' THEN old.visibility_reason ELSE 'source_absent' END,
      old.source_updated_at, NULL, old.metadata_json
    FROM batch_records old
    WHERE old.batch_id=? AND NOT EXISTS (
      SELECT 1 FROM batch_records seen WHERE seen.batch_id=? AND seen.record_id=old.record_id
    )
  `)
      .run(batchId, previous, batchId).changes,
  );
}

async function verifyDatabase(root: string, db: DatabaseSync): Promise<BackupManifest[]> {
  db.exec('BEGIN');
  try {
    const failure = (message: string) => new ZhaoyeError('INTEGRITY_FAILED', message);
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok')
      throw failure('备份库 integrity_check 未通过');
    if (db.prepare('PRAGMA foreign_key_check').get()) throw failure('备份库外键校验未通过');
    const verifyIndexes = db
      .prepare(`
      SELECT 1 FROM record_versions v
      LEFT JOIN record_fts f ON v.version_id=f.version_id
      GROUP BY v.version_id HAVING count(f.version_id) <> 1 OR min(f.title) <> v.title OR min(f.body) <> v.body
      UNION ALL
      SELECT 1 FROM record_fts f WHERE NOT EXISTS (
        SELECT 1 FROM record_versions v WHERE v.version_id=f.version_id
      )
      LIMIT 1
    `)
      .get();
    if (verifyIndexes) throw failure('FTS 索引与内容版本不一致');
    for (const version of db
      .prepare('SELECT kind, title, body, content_hash FROM record_versions')
      .iterate()) {
      const { kind, title, body, content_hash: hash } = version;
      if (hashBytes(canonicalJson({ kind, title, body })) !== hash)
        throw failure('备份库内容版本摘要不一致');
    }
    const batches = db
      .prepare(`
      SELECT b.*, o.receipt_json,
        (SELECT count(*) FROM batch_records r WHERE r.batch_id=b.batch_id) AS observations
      FROM import_batches b LEFT JOIN backup_operations o USING(batch_id)
      WHERE b.status IN ('complete','partial') ORDER BY b.batch_id
    `)
      .all() as unknown as Array<
      BatchRow & {
        observations: number;
        accepted_count: number;
        read_count: number;
        rejected_count: number;
      }
    >;
    const manifests: BackupManifest[] = [];
    for (const batch of batches) {
      const receipt = terminalReceipt(batch);
      if (
        batch.accepted_count !== receipt.recordCount ||
        batch.observations !== receipt.recordCount + receipt.absentCount ||
        batch.read_count !== receipt.readCount ||
        batch.rejected_count !== receipt.rejectedCount
      )
        throw failure('批次记录数与回执不一致');
      const manifest = await readBackupManifest(root, batch.batch_id);
      if (
        batch.raw_manifest !== backupManifestPath(batch.batch_id) ||
        batch.raw_sha256 !== manifest.artifact.sha256 ||
        batch.captured_at !== manifest.capturedAt ||
        batch.captured_at_kind !== manifest.capturedAtKind ||
        (batch.status === 'complete' && manifest.declaredCoverage !== 'complete') ||
        !matchesBatch(manifest, batch)
      )
        throw failure('批次清单与备份库不一致');
      manifests.push(manifest);
    }
    return manifests;
  } finally {
    db.exec('ROLLBACK');
  }
}

function matchesBatch(manifest: BackupManifest, batch: BatchRow): boolean {
  return (
    manifest.sourceId === batch.source_id &&
    manifest.scopeKey === batch.scope_key &&
    manifest.format === batch.source_format &&
    manifest.converterVersion === batch.converter_version
  );
}

async function withReadDb<T>(root: string, work: (db: DatabaseSync) => Promise<T>): Promise<T> {
  const path = databasePath(root);
  try {
    const db = await openSqlite(path, 'read');
    try {
      return await work(db);
    } finally {
      db.close();
    }
  } catch (error) {
    throw sqliteError(error, path);
  }
}

/** Opens a backup bundle in place to validate recoverability without touching the live data root. */
export async function verifyBackupSnapshot(destination: string): Promise<void> {
  const root = resolve(destination);
  try {
    const manifestPath = join(root, 'manifest.json');
    if (
      !(await lstat(manifestPath)).isFile() ||
      !(await lstat(join(root, 'backup'))).isDirectory() ||
      !(await lstat(databasePath(root))).isFile()
    )
      throw new ZhaoyeError('INTEGRITY_FAILED', '备份包路径结构无效');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      format?: string;
      database?: { sha256?: string; bytes?: number };
      batchIds?: string[];
    };
    if (manifest.format !== 'zhaoye-backup-snapshot/v1' || !Array.isArray(manifest.batchIds))
      throw new ZhaoyeError('INTEGRITY_FAILED', '备份包清单格式无效');
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try {
        await lstat(databasePath(root) + suffix);
        throw new ZhaoyeError('INTEGRITY_FAILED', '备份包含有未纳入摘要的 SQLite 辅助文件');
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    const digest = await fileDigest(databasePath(root));
    if (digest.sha256 !== manifest.database?.sha256 || digest.bytes !== manifest.database.bytes)
      throw new ZhaoyeError('INTEGRITY_FAILED', '备份包数据库摘要不一致');
    const verified = await withReadDb(root, (db) => verifyDatabase(root, db));
    if (
      JSON.stringify(verified.map((entry) => entry.batchId)) !== JSON.stringify(manifest.batchIds)
    )
      throw new ZhaoyeError('INTEGRITY_FAILED', '备份包批次覆盖不一致');
  } catch (error) {
    if (error instanceof ZhaoyeError) throw error;
    throw new ZhaoyeError('INTEGRITY_FAILED', '备份包缺失或无法读取', { path: root });
  }
}

export async function openBackupDb(
  dataRoot: string,
  { mode = 'read' }: { mode?: 'read' | 'write' | 'create' } = {},
): Promise<BackupDb> {
  const data = await openDataRoot(dataRoot);
  const root = await realpath(data.root);
  const path = databasePath(root);
  try {
    if (mode === 'create') await ensureDir(dirname(path));
    if (!(await lstat(dirname(path))).isDirectory())
      throw new ZhaoyeError('CORRUPT_DATA', '备份库目录不合法', { path });
    try {
      if (!(await lstat(path)).isFile())
        throw new ZhaoyeError('CORRUPT_DATA', '备份库必须是普通文件', { path });
    } catch (error) {
      if (mode !== 'create' || !isMissing(error)) throw error;
    }
  } catch (error) {
    if (isMissing(error)) throw new ZhaoyeError('NOT_FOUND', '备份库尚未初始化', { path });
    throw sqliteError(error, path);
  }
  const db = await openSqlite(path, mode).catch((error) => {
    throw sqliteError(error, path);
  });
  let closed = false;
  let publishing = 0;
  const run = <T>(work: () => T): T => {
    if (closed) throw new ZhaoyeError('CONFLICT', '备份库已关闭');
    try {
      return work();
    } catch (error) {
      throw sqliteError(error, path);
    }
  };
  const write = <T>(work: () => T) =>
    run(() => {
      if (mode === 'read') throw new ZhaoyeError('UNAUTHORIZED', '备份库以只读模式打开');
      return transaction(db, work);
    });

  function registerSource(input: BackupSource) {
    const source = parseInput(BackupSourceSchema, input);
    write(() => {
      const found = db
        .prepare('SELECT source_kind, scope_id FROM backup_sources WHERE source_id=?')
        .get(source.sourceId);
      if (found && (found.source_kind !== source.kind || found.scope_id !== source.scopeId))
        throw new ZhaoyeError('CONFLICT', '备份来源的类型或范围不能重新绑定');
      db.prepare(`
        INSERT INTO backup_sources VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET display_name=excluded.display_name, policy_json=excluded.policy_json
      `).run(
        source.sourceId,
        source.kind,
        source.scopeId,
        source.displayName,
        canonicalJson(source.policy),
        new Date().toISOString(),
      );
    });
  }

  function startBatch(input: StartBackupBatch): BackupBatchState {
    const request = parseInput(StartBackupBatchSchema, input);
    const fingerprint = hashBytes(canonicalJson(request));
    return write(() => {
      const source = db
        .prepare('SELECT scope_id FROM backup_sources WHERE source_id=?')
        .get(request.sourceId);
      if (!source) throw new ZhaoyeError('NOT_FOUND', '备份来源未注册');
      if (source.scope_id !== request.scopeId)
        throw new ZhaoyeError('OUT_OF_SCOPE', '备份来源超出当前范围');
      const previous = db
        .prepare('SELECT * FROM backup_operations WHERE scope_id=? AND operation_id=?')
        .get(request.scopeId, request.operationId);
      if (previous) {
        if (previous.adapter_id !== request.adapterId)
          throw new ZhaoyeError('UNAUTHORIZED', '备份操作属于其他适配器');
        if (previous.request_fingerprint !== fingerprint)
          throw new ZhaoyeError('CONFLICT', '备份操作参数与原请求不同');
        const batch = findBatch(db, previous.batch_id as string);
        return batch.status === 'running'
          ? { batchId: batch.batch_id, status: 'running', created: false }
          : terminalReceipt(batch);
      }
      const scope = canonicalJson(request.scope);
      const registeredScope = db
        .prepare('SELECT scope_json FROM import_batches WHERE source_id=? AND scope_key=? LIMIT 1')
        .get(request.sourceId, request.scopeKey);
      if (registeredScope && registeredScope.scope_json !== scope)
        throw new ZhaoyeError('CONFLICT', '备份范围标识已绑定到不同范围');
      if (
        request.mode === 'live' &&
        db
          .prepare(`
        SELECT 1 FROM import_batches WHERE source_id=? AND status='running' AND capture_mode='live'
      `)
          .get(request.sourceId)
      )
        throw new ZhaoyeError('LOCKED', '同一来源已有实时采集运行');
      const batchId = randomUUID();
      db.prepare(`
        INSERT INTO import_batches(batch_id,source_id,scope_key,scope_json,status,capture_mode,started_at,source_format,converter_version)
        VALUES (?,?,?,?,'running',?,?,?,?)
      `).run(
        batchId,
        request.sourceId,
        request.scopeKey,
        scope,
        request.mode,
        new Date().toISOString(),
        request.format,
        request.converterVersion,
      );
      db.prepare('INSERT INTO backup_operations VALUES (?, ?, ?, ?, ?, NULL)').run(
        request.scopeId,
        request.operationId,
        request.adapterId,
        fingerprint,
        batchId,
      );
      return { batchId, status: 'running', created: true };
    });
  }

  async function publishBatch(input: PublishBackupBatch): Promise<BackupBatchReceipt> {
    const publication = parseInput(PublishBackupBatchSchema, input);
    const { batchId, status, records, readCount, rejectedCount } = publication;
    if (
      records.length + rejectedCount > readCount ||
      (status === 'complete' && rejectedCount !== 0) ||
      (status === 'partial' && records.length === 0) ||
      new Set(records.map((row) => row.nativeId)).size !== records.length
    )
      throw new ZhaoyeError('INVALID_INPUT', '批次计数、完整状态或记录 ID 不一致');
    const pending = run(() => findBatch(db, batchId));
    if (pending.status !== 'running') return terminalReceipt(pending);
    if (mode === 'read') throw new ZhaoyeError('UNAUTHORIZED', '备份库以只读模式打开');
    publishing++;
    try {
      const manifest = await readBackupManifest(root, batchId);
      if (!matchesBatch(manifest, pending))
        throw new ZhaoyeError('INTEGRITY_FAILED', '原件格式或范围与导入请求不一致', { batchId });
      if (status === 'complete' && manifest.declaredCoverage !== 'complete')
        throw new ZhaoyeError('IMPORT_INCOMPLETE', '部分覆盖的原件不能发布为完整批次', { batchId });
      return write(() => {
        const batch = findBatch(db, batchId);
        if (batch.status !== 'running') return terminalReceipt(batch);
        const previous = completeBatch(db, batch.source_id, batch.scope_key);
        const advancesHead = status === 'complete' && batch.capture_mode === 'live';
        const now = new Date().toISOString();
        const newVersionCount = observeRecords(db, batch, records, now);
        const absentCount = advancesHead && previous ? recordAbsences(db, batchId, previous) : 0;
        db.prepare(`
          UPDATE import_batches
          SET status=?, captured_at=?, captured_at_kind=?, finished_at=?, raw_manifest=?, raw_sha256=?,
            read_count=?, accepted_count=?, rejected_count=?,
            capture_seq=CASE WHEN capture_mode='live' THEN (
              SELECT coalesce(max(capture_seq),0)+1 FROM import_batches WHERE source_id=?
            ) END
          WHERE batch_id=?
        `).run(
          status,
          manifest.capturedAt,
          manifest.capturedAtKind,
          now,
          backupManifestPath(batchId),
          manifest.artifact.sha256,
          readCount,
          records.length,
          rejectedCount,
          batch.source_id,
          batchId,
        );
        if (advancesHead)
          db.prepare(`
          INSERT INTO backup_scope_heads(source_id,scope_key,batch_id) VALUES (?,?,?)
          ON CONFLICT(source_id,scope_key) DO UPDATE SET batch_id=excluded.batch_id
        `).run(batch.source_id, batch.scope_key, batchId);
        const receipt: BackupBatchReceipt = {
          batchId,
          status,
          sourceId: batch.source_id,
          scopeKey: batch.scope_key,
          capturedAt: manifest.capturedAt,
          rawSha256: manifest.artifact.sha256,
          readCount,
          rejectedCount,
          recordCount: records.length,
          newVersionCount,
          absentCount,
          previousCompleteBatchId: previous,
        };
        saveReceipt(db, receipt);
        return receipt;
      });
    } finally {
      publishing--;
    }
  }

  function failRunningBatch(batch: BatchRow, reason: string): BackupBatchReceipt {
    if (batch.status !== 'running') return terminalReceipt(batch);
    db.prepare(
      "UPDATE import_batches SET status='failed', finished_at=?, detail_json=? WHERE batch_id=?",
    ).run(new Date().toISOString(), JSON.stringify({ reason }), batch.batch_id);
    const receipt: BackupBatchReceipt = {
      batchId: batch.batch_id,
      status: 'failed',
      sourceId: batch.source_id,
      scopeKey: batch.scope_key,
      capturedAt: null,
      rawSha256: null,
      readCount: 0,
      rejectedCount: 0,
      recordCount: 0,
      newVersionCount: 0,
      absentCount: 0,
      previousCompleteBatchId: completeBatch(db, batch.source_id, batch.scope_key),
    };
    saveReceipt(db, receipt);
    return receipt;
  }

  return {
    registerSource,
    getSource: (sourceId) =>
      run(() => {
        const row = db.prepare('SELECT * FROM backup_sources WHERE source_id=?').get(sourceId);
        if (!row) return null;
        try {
          return BackupSourceSchema.parse({
            sourceId: row.source_id,
            kind: row.source_kind,
            scopeId: row.scope_id,
            displayName: row.display_name,
            policy: JSON.parse(row.policy_json as string),
          });
        } catch {
          throw new ZhaoyeError('CORRUPT_DATA', '备份来源配置损坏');
        }
      }),
    startBatch,
    publishBatch,
    failBatch: (batchId, reason) => write(() => failRunningBatch(findBatch(db, batchId), reason)),
    // The application runs recovery only after it has acquired exclusive presence.
    recoverInterruptedBatches: () =>
      write(() => {
        if (publishing) throw new ZhaoyeError('LOCKED', '仍有备份批次正在发布');
        const rows = db.prepare("SELECT batch_id FROM import_batches WHERE status='running'").all();
        for (const row of rows)
          failRunningBatch(findBatch(db, row.batch_id as string), 'interrupted');
        return rows.length;
      }),
    getCompleteBatch: (sourceId, scopeKey) => run(() => completeBatch(db, sourceId, scopeKey)),
    listBatches: (access) => run(() => listBackupBatches(db, access)),
    readRecords: (access, recordId) =>
      run(() => readTransaction(db, () => readBackupRecords(db, access, recordId))),
    search: (access, input) =>
      run(() => readTransaction(db, () => searchBackupRows(db, access, input))),
    rebuildIndex: () =>
      write(() =>
        db.exec(`
      DELETE FROM record_fts;
      INSERT INTO record_fts(title, body, version_id) SELECT title, body, version_id FROM record_versions;
    `),
      ),
    verify: async () => {
      run(() => undefined);
      await withReadDb(root, (reader) => verifyDatabase(root, reader));
    },
    snapshotTo: async (destination) => {
      run(() => undefined);
      const target = resolve(destination);
      try {
        // A new directory reserves the path. The manifest is published last.
        await mkdir(target);
        await mkdir(join(target, 'backup'));
        await withReadDb(root, async (reader) => {
          const { backup, DatabaseSync } = await import('node:sqlite');
          await backup(reader, databasePath(target));
          const packageDb = new DatabaseSync(databasePath(target));
          try {
            if (packageDb.prepare('PRAGMA journal_mode=DELETE').get()?.journal_mode !== 'delete')
              throw new ZhaoyeError('STORAGE_FAILURE', '无法生成独立的 SQLite 快照');
          } finally {
            packageDb.close();
          }
        });
        const manifests = await withReadDb(target, async (reader) => {
          const artifacts = await verifyDatabase(root, reader);
          for (const manifest of artifacts) await copyBackupArtifacts(root, target, manifest);
          return verifyDatabase(target, reader);
        });
        await writeAtomic(
          join(target, 'manifest.json'),
          JSON.stringify({
            format: 'zhaoye-backup-snapshot/v1',
            database: await fileDigest(databasePath(target)),
            batchIds: manifests.map((manifest) => manifest.batchId),
          }),
        );
      } catch (error) {
        throw sqliteError(error, target);
      }
    },
    close: () => {
      if (closed) return;
      if (publishing) throw new ZhaoyeError('LOCKED', '仍有备份批次正在发布');
      run(() => db.close());
      closed = true;
    },
  };
}
