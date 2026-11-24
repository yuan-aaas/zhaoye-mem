import { lstat, mkdir, open, realpath, rename } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  type BackupDetail,
  type BackupManifest,
  BackupManifestSchema,
  type BackupObservation,
  type PublishBackupBatch,
  ZhaoyeError,
} from '@zhaoye/contracts';
import { ioError, writeAtomic } from './atomic-fs.js';
import { fileDigest } from './internal/backup-artifacts.js';

export async function resolveMnemeFile(
  root: string,
  path: string,
  historical = false,
): Promise<string> {
  try {
    const file = await realpath(path);
    const backupRoot = join(await realpath(root), 'backup');
    const local = relative(backupRoot, file);
    const inBackup = !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`);
    if (
      inBackup &&
      (!historical || local.split(sep)[0] !== 'exports' || basename(file) !== 'source.sqlite')
    )
      throw new ZhaoyeError('INVALID_INPUT', '输入文件与照夜备份目录冲突');
    if (!(await lstat(file)).isFile())
      throw new ZhaoyeError('INVALID_INPUT', '需要 SQLite 普通文件');
    return file;
  } catch (error) {
    if (error instanceof ZhaoyeError) throw error;
    throw new ZhaoyeError('SOURCE_UNAVAILABLE', 'Mneme 文件不可用');
  }
}

export async function captureMnemeFile(input: {
  root: string;
  file: string;
  whole: boolean;
  batch: Pick<BackupManifest, 'batchId' | 'sourceId' | 'scopeKey' | 'format' | 'converterVersion'>;
  required: readonly string[];
  optional: readonly string[];
  convert: (row: Record<string, unknown>) => BackupObservation | 'excluded' | 'invalid';
}): Promise<PublishBackupBatch> {
  const { root, file, batch, whole } = input;
  if (!BackupManifestSchema.shape.batchId.safeParse(batch.batchId).success)
    throw new ZhaoyeError('INVALID_INPUT', '批次 ID 无效');
  const { DatabaseSync, backup } = await import('node:sqlite');
  const captureStartedAt = new Date().toISOString();
  const backupRoot = join(await realpath(root), 'backup');
  for (const path of [join(backupRoot, '.staging'), join(backupRoot, 'exports')]) {
    await mkdir(path, { recursive: true });
    if (!(await lstat(path)).isDirectory())
      throw new ZhaoyeError('STORAGE_FAILURE', '备份目录无效');
  }
  const staging = join(backupRoot, '.staging', batch.batchId);
  await mkdir(staging);
  const name = whole ? 'source.sqlite' : 'source.ndjson';
  const artifactPath = join(staging, name);
  const read = (path: string) => {
    const db = new DatabaseSync(path, { readOnly: true, timeout: 3000 });
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
    return db;
  };
  let source: DatabaseSync | undefined;
  try {
    source = read(file);
    if (whole) {
      await backup(source, artifactPath);
      source.close();
      source = undefined;
      const copy = new DatabaseSync(artifactPath);
      try {
        if (copy.prepare('PRAGMA journal_mode=DELETE').get()?.journal_mode !== 'delete')
          throw new ZhaoyeError('STORAGE_FAILURE', '无法生成独立 Mneme 快照');
      } finally {
        copy.close();
      }
      source = read(artifactPath);
    }
    source.exec('BEGIN');
    if (
      source.prepare("SELECT type FROM sqlite_schema WHERE name='memories'").get()?.type !== 'table'
    )
      throw new ZhaoyeError('SCHEMA_MIGRATION_REQUIRED', '源库缺少 Mneme memories 表');
    const available = new Set(
      source
        .prepare("PRAGMA table_info('memories')")
        .all()
        .map((col) => col.name),
    );
    const missing = input.required.filter((column) => !available.has(column));
    if (missing.length)
      throw new ZhaoyeError('SCHEMA_MIGRATION_REQUIRED', 'Mneme 缺少读取或判断授权范围所需的字段', {
        missingColumns: missing,
      });
    const columns = [
      ...new Set([...input.required, ...input.optional.filter((column) => available.has(column))]),
    ];
    if (columns.some((column) => !/^[a-z_]+$/.test(column)))
      throw new ZhaoyeError('INVALID_INPUT', 'Mneme 字段选择无效');
    const projection = columns.map((column) => `"${column}"`).join(', ');
    const rows = source.prepare(`
      SELECT ${projection} FROM memories
      WHERE id IN (SELECT id FROM memories GROUP BY id HAVING count(*)=1)
    `);
    const duplicates = Number(
      source
        .prepare(`
      SELECT coalesce(sum(n),0) AS n FROM (SELECT count(*) n FROM memories GROUP BY id HAVING count(*)>1 OR id IS NULL)
    `)
        .get()?.n,
    );
    const records: BackupObservation[] = [];
    let readCount = duplicates;
    let rejectedCount = duplicates;
    const output = whole ? undefined : await open(artifactPath, 'wx');
    try {
      await output?.writeFile('{"format":"mneme-scoped/v1"}\n');
      for (const row of rows.iterate()) {
        readCount++;
        const result = input.convert(row);
        if (result === 'excluded') continue;
        if (result === 'invalid') {
          rejectedCount++;
          continue;
        }
        records.push(result);
        await output?.writeFile(`${JSON.stringify(row)}\n`);
      }
      await output?.sync();
    } finally {
      await output?.close();
    }
    source.exec('COMMIT');
    source.close();
    source = undefined;
    if (rejectedCount > 0 && records.length === 0)
      throw new ZhaoyeError('IMPORT_INCOMPLETE', '没有可发布的 Mneme 记录');
    const status = rejectedCount ? 'partial' : 'complete';
    const capturedAt = new Date().toISOString();
    const manifest: BackupManifest = {
      ...batch,
      captureStartedAt,
      capturedAt,
      capturedAtKind: 'local',
      declaredCoverage: status,
      artifact: { name, ...(await fileDigest(artifactPath)) },
    };
    await writeAtomic(join(staging, 'manifest.json'), JSON.stringify(manifest));
    await rename(staging, join(backupRoot, 'exports', batch.batchId));
    return { batchId: batch.batchId, status, readCount, rejectedCount, records };
  } catch (error) {
    if (error instanceof ZhaoyeError) throw error;
    throw new ZhaoyeError('SOURCE_UNAVAILABLE', '无法读取或固定 Mneme 快照');
  } finally {
    source?.close();
  }
}

/** Writes the documented Mneme memories table to a new interchange file. */
export async function writeMnemeExport(destination: string, rows: BackupDetail[]): Promise<void> {
  const target = resolve(destination);
  const path = join(await realpath(dirname(target)), basename(target));
  try {
    const file = await open(path, 'wx');
    await file.close();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path);
    try {
      db.exec(`
        BEGIN;
        CREATE TABLE memories (
          id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '[]', importance INTEGER NOT NULL DEFAULT 3,
          forgotten INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
          archived_at TEXT, source TEXT, content_hash TEXT, doc_path TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          agent_scope TEXT, workspace_scope TEXT, sensitivity TEXT, occurred_at TEXT,
          agent_scope_source TEXT, workspace_scope_source TEXT, scope_decided_at TEXT,
          epistemic_status TEXT NOT NULL DEFAULT 'subjective', last_accessed_at TEXT, quality_score REAL
        );
      `);
      const insert = db.prepare(`INSERT INTO memories VALUES (${Array(24).fill('?').join(',')})`);
      for (const row of rows) {
        const meta = row.metadata;
        const str = (key: string) => (typeof meta[key] === 'string' ? (meta[key] as string) : null);
        const num = (key: string) => (typeof meta[key] === 'number' ? (meta[key] as number) : null);
        insert.run(
          row.native_id,
          str('native_kind') ?? row.kind,
          row.title,
          row.body,
          str('tags') ?? '[]',
          num('importance') ?? 3,
          Number(meta.forgotten ?? 0),
          Number(meta.archived ?? 0),
          str('archived_at'),
          str('source'),
          str('content_hash'),
          str('doc_path'),
          str('created_at') ?? row.batch.captured_at,
          str('updated_at') ?? row.source_updated_at ?? row.batch.captured_at,
          str('agent_scope'),
          str('workspace_scope'),
          str('sensitivity'),
          str('occurred_at'),
          str('agent_scope_source'),
          str('workspace_scope_source'),
          str('scope_decided_at'),
          str('epistemic_status') ?? 'subjective',
          str('last_accessed_at'),
          num('quality_score'),
        );
      }
      db.exec('COMMIT');
    } finally {
      db.close();
    }
  } catch (error) {
    throw ioError(error, path);
  }
}
