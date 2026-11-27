import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import { createZhaoye } from '@zhaoye/app';

async function fixture(t: TestContext, clock = { now: () => new Date() }) {
  const dir = await mkdtemp(join(tmpdir(), 'zhaoye-evolution-'));
  const cleanup: Array<() => void> = [];
  const root = join(dir, 'data');
  const open = () =>
    createZhaoye({
      dataRoot: root,
      initIfMissing: true,
      clock,
      host: {
        host_id: 'cli',
        display_name: 'Test',
        capabilities: [],
        adapter_version: '0.1.0',
        data_schema: 1,
      },
    });
  const app = await open();
  t.after(async () => {
    for (const close of cleanup) close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const actor = {
    adapter_id: 'cli',
    scope_id: app.assistantId,
    granted_project_ids: '*',
    granted_source_ids: '*',
    backup_import: true,
    backup_history: true,
    backup_unassigned: true,
    backup_export: true,
  } as const;
  return { app, root, dir, actor, open, cleanup };
}

test('durable human evidence applies once, survives restart, and can be withdrawn', async (t) => {
  const { app, actor, open } = await fixture(t);
  const evidence = {
    id: 'user:1',
    text: '以后读不到文件，先问我要路径或权限',
    at: '2026-11-27T01:00:00.000Z',
  };
  const [first, repeated] = await Promise.all([
    app.evolution.remember(evidence, actor),
    app.evolution.remember(evidence, actor),
  ]);
  assert.equal(first.state, 'applied');
  assert.equal(first.revision, 2);
  assert.deepEqual(first, repeated);
  await assert.rejects(
    app.evolution.remember({ ...evidence, id: 'user:2', text: '这次回答简短些' }, actor),
    {
      code: 'INVALID_INPUT',
    },
  );
  assert.equal(
    (
      await app.evolution.propose(
        { ...evidence, id: 'user:3', text: '我习惯先给结论再沟通' },
        actor,
      )
    ).state,
    'pending',
  );
  await app.close();
  const reopened = await open();
  try {
    assert.deepEqual(await reopened.evolution.remember(evidence, actor), first);
    assert.equal((await reopened.evolution.list(actor)).length, 1);
    const withdrawn = await reopened.evolution.remember(
      {
        ...evidence,
        id: 'user:4',
        text: '忘掉读不到先问我的偏好',
        at: '2026-11-28T01:00:00.000Z',
      },
      actor,
    );
    assert.equal(withdrawn.state, 'applied');
    assert.equal(withdrawn.revision, 3);
    assert.deepEqual((await reopened.identity.read(actor)).document.user_profile.preferences, []);
  } finally {
    await reopened.close();
  }
});

test('Mneme sync inherits unchanged rows, records removals and checkpoints preference intake', async (t) => {
  const { app, actor, dir, root, cleanup } = await fixture(t);
  const file = join(dir, 'memory.db');
  const db = new DatabaseSync(file);
  cleanup.push(() => db.close());
  db.exec(`
    CREATE TABLE memories(id TEXT PRIMARY KEY, type TEXT, title TEXT, content TEXT,
      archived INTEGER, forgotten INTEGER, source TEXT, updated_at TEXT, last_accessed_at TEXT);
    INSERT INTO memories VALUES
      ('keep','project','两条已核对','保留这条',0,0,NULL,'2026-11-26T01:00:00Z',NULL),
      ('remove','project','需要移除','移除这条',0,0,NULL,'2026-11-26T01:00:00Z',NULL),
      ('archive','project','需要归档','归档这条',0,0,NULL,'2026-11-26T01:00:00Z',NULL);
  `);
  const { sourceId } = await app.backup.registerMneme(
    {
      file,
      policy: { rawMode: 'sqlite', includeUnassigned: true, includeUnknownSensitivity: true },
    },
    actor,
  );
  const baseline = await app.backup.syncMneme({ sourceId, operationId: 'baseline' }, actor);
  const baselineFiles = await readdir(join(root, 'backup', 'exports', baseline.batchId));
  assert.deepEqual(baselineFiles.sort(), ['manifest.json', 'source.ndjson']);
  assert.equal(baseline.changed, 3);
  db.exec(`
    UPDATE memories SET last_accessed_at='2026-11-27T02:00:00Z' WHERE id='keep';
    DELETE FROM memories WHERE id='remove';
    UPDATE memories SET archived=1 WHERE id='archive';
    INSERT INTO memories VALUES ('pref','preference','偏好','希望先说重点',0,0,'session:example','2026-11-27T04:00:00Z',NULL);
  `);
  const firstDelta = await app.backup.syncMneme({ sourceId, operationId: 'delta' }, actor, () => {
    throw new Error('synthetic crash between backup and preference');
  });
  assert.equal(firstDelta.status, 'complete');
  assert.equal(firstDelta.preferenceError, 'STORAGE_FAILURE');
  assert.equal(firstDelta.absent, 1);
  assert.equal(firstDelta.changed, 3);
  const raw = await readFile(
    join(root, 'backup', 'exports', firstDelta.batchId, 'source.ndjson'),
    'utf8',
  );
  assert.ok(!raw.includes('保留这条'));
  assert.equal(JSON.parse(raw.split('\n')[0] ?? '').parentBatchId, baseline.batchId);
  assert.match(raw, /source_absent/);
  assert.equal(
    (await app.backup.searchBackup(sourceId, { query: '保留这条', includeUnassigned: true }, actor))
      .hits.length,
    1,
  );
  assert.equal(
    (
      await app.backup.searchBackup(
        sourceId,
        { query: '移除这条', includeUnassigned: true, history: true },
        actor,
      )
    ).hits.length,
    0,
  );
  assert.equal(
    (
      await app.backup.searchBackup(
        sourceId,
        { query: '归档这条', includeUnassigned: true, history: true },
        actor,
      )
    ).hits.length,
    1,
  );
  assert.equal((await app.evolution.list(actor)).length, 0);
  const retry = await app.backup.syncMneme({ sourceId, operationId: 'no-change' }, actor);
  assert.equal(retry.status, 'unchanged');
  assert.equal(retry.preferenceError, undefined);
  assert.equal(retry.batchId, firstDelta.batchId);
  assert.equal((await app.evolution.list(actor))[0]?.evidence.sourceSession, 'example');
  assert.equal((await readdir(join(root, 'backup', 'exports'))).length, 2);
  db.exec(
    "UPDATE memories SET content='保留记录更新',updated_at='2026-11-27T06:00:00Z' WHERE id='keep'",
  );
  const secondDelta = await app.backup.syncMneme({ sourceId, operationId: 'delta-2' }, actor);
  assert.equal(secondDelta.changed, 1);
  assert.equal(
    (
      await app.backup.searchBackup(
        sourceId,
        { query: '保留记录更新', includeUnassigned: true },
        actor,
      )
    ).hits.length,
    1,
  );
  assert.equal(
    (
      await app.backup.searchBackup(
        sourceId,
        { query: '保留这条', includeUnassigned: true, batchId: firstDelta.batchId },
        actor,
      )
    ).hits.length,
    1,
  );
  assert.equal(
    (
      await app.backup.exportMneme(
        sourceId,
        join(dir, 'export.db'),
        { includeUnassigned: true, history: true },
        actor,
      )
    ).records,
    3,
  );
  assert.equal((await app.backup.verifyBackup(actor)).verified, true);
  assert.equal((await app.evolution.list(actor)).length, 1);
  db.exec("UPDATE memories SET content=NULL WHERE id='keep'");
  await assert.rejects(app.backup.syncMneme({ sourceId, operationId: 'invalid' }, actor), {
    code: 'IMPORT_INCOMPLETE',
  });
  assert.equal((await app.backup.syncStatus(sourceId, actor)).batchId, secondDelta.batchId);
  assert.equal((await app.backup.syncStatus(sourceId, actor)).error, 'IMPORT_INCOMPLETE');
});

test('Friday reminder uses local dates, catches up once and observes earlier sync', async (t) => {
  let now = new Date('2026-11-26T15:59:00Z');
  const { app, open } = await fixture(t, { now: () => now });
  const schedule = { timeZone: 'Asia/Shanghai', weekday: 5, successes: [undefined] };
  assert.equal(await app.backup.reminder(schedule), null);
  now = new Date('2026-11-26T16:00:00Z');
  assert.equal(await app.backup.reminder(schedule), '2026-11-27');
  await app.close();
  now = new Date('2026-12-08T00:00:00.000Z');
  const reopened = await open();
  try {
    assert.equal(
      await reopened.backup.reminder({ ...schedule, successes: ['2026-12-02T00:00:00.000Z'] }),
      null,
    );
    const claims = await Promise.all([
      reopened.backup.reminder({ ...schedule, claim: true }),
      reopened.backup.reminder({ ...schedule, claim: true }),
    ]);
    assert.deepEqual(claims, ['2026-12-04', null]);
  } finally {
    await reopened.close();
  }
});
