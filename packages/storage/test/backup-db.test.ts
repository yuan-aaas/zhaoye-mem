import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import type {
  BackupDb,
  BackupManifest,
  BackupObservation,
  StartBackupBatch,
} from '@zhaoye/contracts';
import { ensureDataRoot, hashBytes, openBackupDb, verifyBackupSnapshot } from '@zhaoye/storage';

const capturedAt = '2026-11-23T00:00:00.000Z';
const source = {
  sourceId: 'mneme-local',
  kind: 'mneme',
  scopeId: 'scope',
  displayName: 'Test',
  policy: {},
};
const request: StartBackupBatch = {
  sourceId: source.sourceId,
  scopeId: source.scopeId,
  scopeKey: 'all',
  scope: {},
  operationId: 'op',
  adapterId: 'test',
  mode: 'live',
  format: 'sqlite',
  converterVersion: '1',
};

async function fixture(t: TestContext) {
  const parent = await mkdtemp(join(tmpdir(), '照夜 MC-2-'));
  const connections: BackupDb[] = [];
  t.after(async () => {
    for (const db of connections) db.close();
    await rm(parent, { recursive: true, force: true });
  });
  const root = join(parent, 'data');
  await ensureDataRoot(root, { now: () => new Date(capturedAt) }, () => 'fixture\n');
  return {
    parent,
    root,
    file: join(root, 'backup', 'zhaoye.db'),
    async connect(mode: 'read' | 'write' | 'create' = 'create') {
      const db = await openBackupDb(root, { mode });
      connections.push(db);
      if (mode === 'create') db.registerSource(source);
      return db;
    },
  };
}

function observation(nativeId: string, body = '工具安装流程'): BackupObservation {
  return {
    nativeId,
    content: { kind: 'project', title: '工具', body },
    projectId: 'project',
    searchAllowed: true,
    visibility: 'visible',
    reason: null,
    sourceUpdatedAt: capturedAt,
    rawRef: nativeId,
    metadata: {},
  };
}

async function artifact(
  root: string,
  batchId: string,
  input = request,
  coverage: 'complete' | 'partial' = 'complete',
) {
  const path = join(root, 'backup', 'exports', batchId);
  await mkdir(path, { recursive: true });
  const raw = 'synthetic raw source\n';
  const manifest: BackupManifest = {
    batchId,
    sourceId: input.sourceId,
    scopeKey: input.scopeKey,
    format: input.format,
    converterVersion: input.converterVersion,
    captureStartedAt: capturedAt,
    capturedAt,
    capturedAtKind: 'local',
    declaredCoverage: coverage,
    artifact: { name: 'source.ndjson', bytes: Buffer.byteLength(raw), sha256: hashBytes(raw) },
  };
  await writeFile(join(path, 'source.ndjson'), raw);
  await writeFile(join(path, 'manifest.json'), JSON.stringify(manifest));
  return path;
}

async function publish(
  db: BackupDb,
  root: string,
  input: StartBackupBatch,
  records: BackupObservation[],
  status: 'complete' | 'partial' = 'complete',
) {
  const { batchId } = db.startBatch(input);
  await artifact(root, batchId, input, status);
  return db.publishBatch({ batchId, status, records, readCount: records.length, rejectedCount: 0 });
}

test('MC-2 only explicit creation migrates a backup root and reopen preserves WAL and its schema', async (t) => {
  const { root, file, connect } = await fixture(t);
  await assert.rejects(openBackupDb(root), { code: 'NOT_FOUND' });
  await assert.rejects(stat(join(root, 'backup')), { code: 'ENOENT' });
  const db = await connect();
  db.close();
  const raw = new DatabaseSync(file);
  assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 1);
  assert.equal(raw.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
  raw.close();
  const reader = await connect('read');
  assert.throws(() => reader.startBatch(request), { code: 'UNAUTHORIZED' });
  assert.equal(reader.getCompleteBatch(source.sourceId, 'all'), null);
  await reader.verify();
});

test('MC-2 never migrates an unrelated or unknown SQLite schema', async (t) => {
  const { root, file } = await fixture(t);
  await mkdir(join(root, 'backup'));
  const raw = new DatabaseSync(file);
  try {
    raw.exec('CREATE TABLE unrelated(value TEXT)');
    await assert.rejects(openBackupDb(root, { mode: 'create' }), {
      code: 'SCHEMA_MIGRATION_REQUIRED',
    });
    assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 0);
    raw.exec('PRAGMA user_version=97');
    await assert.rejects(openBackupDb(root, { mode: 'create' }), {
      code: 'SCHEMA_MIGRATION_REQUIRED',
    });
    assert.ok(raw.prepare("SELECT name FROM sqlite_schema WHERE name='unrelated'").get());
  } finally {
    raw.close();
  }
});

test('MC-2 operations replay and repeated content links to new batches without new versions', async (t) => {
  const { root, file, connect } = await fixture(t);
  const db = await connect();
  const first = await publish(db, root, request, [observation('a')]);
  assert.equal(first.newVersionCount, 1);
  assert.deepEqual(db.startBatch(request), first);
  assert.throws(() => db.startBatch({ ...request, format: 'other' }), { code: 'CONFLICT' });
  assert.throws(() => db.startBatch({ ...request, adapterId: 'other' }), { code: 'UNAUTHORIZED' });
  assert.throws(() => db.startBatch({ ...request, scopeId: 'other' }), { code: 'OUT_OF_SCOPE' });
  assert.throws(
    () => db.startBatch({ ...request, operationId: 'changed-scope', scope: { project: 'other' } }),
    { code: 'CONFLICT' },
  );
  const repeat = await publish(db, root, { ...request, operationId: 'again' }, [observation('a')]);
  assert.equal(repeat.newVersionCount, 0);
  assert.equal(repeat.previousCompleteBatchId, first.batchId);
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    const counts = raw
      .prepare(
        'SELECT count(*) AS observations, count(DISTINCT version_id) AS versions FROM batch_records',
      )
      .get();
    assert.equal(counts?.observations, 2);
    assert.equal(counts?.versions, 1);
  } finally {
    raw.close();
  }
});

test('MC-2 only live complete batches publish a head and may add missing-record observations', async (t) => {
  const { root, file, connect } = await fixture(t);
  const db = await connect();
  const first = await publish(db, root, request, [observation('a'), observation('b')]);
  const partial = await publish(
    db,
    root,
    { ...request, operationId: 'partial' },
    [observation('a', '新正文')],
    'partial',
  );
  const older = await publish(
    db,
    root,
    { ...request, operationId: 'older', mode: 'historical' },
    [],
  );
  assert.equal(partial.absentCount, 0);
  assert.equal(older.absentCount, 0);
  assert.equal(db.getCompleteBatch(source.sourceId, request.scopeKey), first.batchId);
  const full = await publish(db, root, { ...request, operationId: 'full' }, [
    observation('a', '新正文'),
  ]);
  assert.equal(full.newVersionCount, 0);
  assert.equal(full.absentCount, 1);
  assert.equal(db.getCompleteBatch(source.sourceId, request.scopeKey), full.batchId);
  const raw = new DatabaseSync(file, { enableForeignKeyConstraints: true });
  try {
    assert.throws(
      () => raw.prepare('UPDATE backup_scope_heads SET batch_id=?').run(partial.batchId),
      /FOREIGN KEY/,
    );
    assert.throws(
      () => raw.prepare('UPDATE backup_scope_heads SET batch_id=?').run(older.batchId),
      /FOREIGN KEY/,
    );
    assert.equal(
      raw
        .prepare(
          "SELECT visibility_reason FROM batch_records WHERE batch_id=? AND visibility='unavailable'",
        )
        .get(full.batchId)?.visibility_reason,
      'source_absent',
    );
  } finally {
    raw.close();
  }
  await db.verify();
});

test('MC-2 rejects wrong artifacts, serializes a live source, rolls back publication and recovers interruption', async (t) => {
  const { root, file, connect } = await fixture(t);
  const db = await connect();
  const first = await publish(db, root, request, [observation('a')]);
  const next = { ...request, operationId: 'next' };
  const { batchId } = db.startBatch(next);
  assert.deepEqual(db.startBatch(next), { batchId, status: 'running', created: false });
  const other = await connect('write');
  assert.throws(() => other.startBatch({ ...request, operationId: 'overlap' }), { code: 'LOCKED' });
  const publication = {
    batchId,
    status: 'complete' as const,
    records: [observation('b')],
    readCount: 1,
    rejectedCount: 0,
  };
  await assert.rejects(db.publishBatch(publication), { code: 'INTEGRITY_FAILED' });
  await artifact(root, batchId, next, 'partial');
  await assert.rejects(db.publishBatch(publication), { code: 'IMPORT_INCOMPLETE' });
  await artifact(root, batchId, next);
  const raw = new DatabaseSync(file);
  try {
    raw.exec(
      "CREATE TRIGGER fail_publication BEFORE UPDATE ON backup_operations WHEN new.receipt_json IS NOT NULL BEGIN SELECT raise(ABORT,'fixture'); END",
    );
    await assert.rejects(db.publishBatch(publication), { code: 'STORAGE_FAILURE' });
    raw.exec('DROP TRIGGER fail_publication');
    assert.equal(
      raw.prepare("SELECT count(*) AS total FROM source_records WHERE native_id='b'").get()?.total,
      0,
    );
    assert.equal(db.getCompleteBatch(source.sourceId, request.scopeKey), first.batchId);
  } finally {
    raw.close();
  }
  db.close();
  assert.equal(other.recoverInterruptedBatches(), 1);
  assert.equal(other.startBatch(next).status, 'failed');
  await other.verify();
});

test('MC-2 verifies a WAL bundle and original artifacts, detects FTS loss and rebuilds it', async (t) => {
  const { root, parent, file, connect } = await fixture(t);
  const db = await connect();
  const batch = await publish(db, root, request, [observation('a')]);
  const raw = new DatabaseSync(file);
  try {
    raw.exec('DELETE FROM record_fts');
  } finally {
    raw.close();
  }
  await assert.rejects(db.verify(), { code: 'INTEGRITY_FAILED' });
  db.rebuildIndex();
  const target = join(parent, '恢复副本');
  await db.snapshotTo(target);
  await verifyBackupSnapshot(target);
  await assert.rejects(db.snapshotTo(target), { code: 'STORAGE_FAILURE' });
  await writeFile(join(target, 'backup', 'exports', batch.batchId, 'source.ndjson'), 'modified');
  await assert.rejects(verifyBackupSnapshot(target), { code: 'INTEGRITY_FAILED' });
  await db.verify();
});
