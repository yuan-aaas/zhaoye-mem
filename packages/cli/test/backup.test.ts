import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createZhaoye } from '@zhaoye/app';
import { run } from '@zhaoye/cli';
import type { BackupBatchReceipt, BackupResult } from '@zhaoye/contracts';

const date = '2026-11-24T00:00:00.000Z';

function updateDatabase(path: string, sql: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

test('MC-3/4 CLI imports scoped Mneme rows, searches, paginates and exports them', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'zhaoye-mneme-fixture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'data');
  const origin = join(dir, 'memory.db');
  const policy = join(dir, 'policy.json');
  const invoke = async (...args: string[]) => {
    let result!: {
      data: BackupBatchReceipt & BackupResult & { records: number; verified: boolean };
      error: { code: string; details: { missingColumns?: string[] } };
    };
    const code = await run([...args, '--data-root', root, '--json'], (line) => {
      result = JSON.parse(line);
    });
    return { code, ...result };
  };
  const db = new DatabaseSync(origin);
  try {
    db.exec(`
      CREATE TABLE memories (id TEXT PRIMARY KEY, type TEXT, title TEXT, content TEXT,
        archived INTEGER, forgotten INTEGER, tags TEXT, created_at TEXT, updated_at TEXT, workspace_scope TEXT);
    `);
    const insert = db.prepare(
      "INSERT INTO memories VALUES (?, 'project', ?, '工具安装流程', ?, 0, '[]', ?, ?, ?)",
    );
    insert.run('a', '安装一', 0, date, date, 'approved');
    insert.run('b', '安装二', 0, date, date, 'approved');
    insert.run('archived', '安装归档', 1, date, date, 'approved');
    insert.run('private', 'outside-scope', 0, date, date, 'denied');
  } finally {
    db.close();
  }
  await writeFile(
    policy,
    JSON.stringify({
      workspaces: ['approved'],
      includeUnassigned: true,
      includeUnknownSensitivity: true,
      projects: [{ agent: null, workspace: 'approved', projectId: 'project' }],
    }),
  );
  assert.equal((await invoke('init')).code, 0);
  const registered = await invoke('backup', 'source', 'add', '--file', origin, '--policy', policy);
  assert.equal(registered.code, 0);
  const source = registered.data.sourceId as string;
  const first = await invoke('backup', 'import', '--source', source, '--operation-id', 'first');
  assert.equal(first.code, 0);
  assert.equal(first.data.recordCount, 3);
  const raw = await readFile(
    join(root, 'backup', 'exports', first.data.batchId, 'source.ndjson'),
    'utf8',
  );
  assert.ok(!raw.includes('outside-scope'));
  const query = ['backup', 'search', '安装', '--source', source, '--limit', '1'];
  const page = await invoke(...query);
  assert.equal(page.data.hits.length, 1);
  assert.equal(page.data.coverage, 'partial');
  assert.ok(page.data.next_cursor);
  const next = await invoke(...query, '--cursor', page.data.next_cursor);
  assert.equal(next.data.hits.length, 1);
  assert.notEqual(next.data.hits[0]?.record_id, page.data.hits[0]?.record_id);
  assert.equal(next.data.coverage, 'complete');
  assert.equal(
    (await invoke('backup', 'search', '安装流程', '--source', source, '--project', 'other')).data
      .hits.length,
    0,
  );
  const fullText = ['backup', 'search', '安装流程', '--source', source];
  assert.equal((await invoke(...fullText)).data.hits.length, 2);
  const noMatch = await invoke('backup', 'search', '无匹配内容', '--source', source);
  assert.equal(noMatch.data.hits.length, 0);
  assert.equal(noMatch.data.coverage, 'complete');
  const backupPath = join(root, 'backup', 'zhaoye.db');
  updateDatabase(backupPath, 'DELETE FROM record_fts');
  assert.equal((await invoke(...fullText)).error.code, 'INTEGRITY_FAILED');
  assert.equal((await invoke(...query)).data.hits.length, 1);
  updateDatabase(
    backupPath,
    `
    INSERT INTO record_fts(title, body, version_id) SELECT title, body, version_id FROM record_versions
  `,
  );
  assert.equal((await invoke(...fullText)).data.hits.length, 2);
  const output = join(dir, 'exchange.db');
  const exportResult = await invoke(
    'backup',
    'export-mneme',
    '--source',
    source,
    '--out',
    output,
    '--history',
  );
  assert.equal(exportResult.data.records, 3);
  const round = new DatabaseSync(output, { readOnly: true });
  try {
    assert.equal(
      round.prepare("SELECT archived FROM memories WHERE id='archived'").get()?.archived,
      1,
    );
    assert.equal(round.prepare('SELECT count(*) AS n FROM memories').get()?.n, 3);
  } finally {
    round.close();
  }
  assert.equal(
    (await invoke('backup', 'export-mneme', '--source', source, '--out', origin)).code,
    6,
  );
  updateDatabase(
    origin,
    "UPDATE memories SET archived=1 WHERE id='a'; UPDATE memories SET content=NULL WHERE id='b'",
  );
  const partial = await invoke('backup', 'import', '--source', source, '--operation-id', 'partial');
  assert.equal(partial.data.status, 'partial');
  assert.equal(partial.data.previousCompleteBatchId, first.data.batchId);
  assert.equal((await invoke(...query, '--cursor', page.data.next_cursor)).error.code, 'CONFLICT');
  const current = await invoke(...query);
  assert.equal(current.data.hits.length, 1);
  assert.equal(current.data.hits[0]?.title, '安装二');
  assert.equal(current.data.coverage, 'partial');
  assert.equal((await invoke('backup', 'verify')).data.verified, true);
  const app = await createZhaoye({
    dataRoot: root,
    initIfMissing: false,
    host: {
      host_id: 'cli',
      display_name: 'test',
      capabilities: [],
      adapter_version: '0.1.0',
      data_schema: 1,
    },
  });
  try {
    const limited = {
      adapter_id: 'cli',
      scope_id: app.assistantId,
      granted_source_ids: [source],
      granted_project_ids: ['other'],
    };
    await assert.rejects(
      app.backup.searchBackup(source, { query: '安装', projects: ['project'] }, limited),
      { code: 'OUT_OF_SCOPE' },
    );
    await assert.rejects(
      app.backup.searchBackup(source, { query: '安装', includeUnassigned: true }, limited),
      { code: 'UNAUTHORIZED' },
    );
    await assert.rejects(
      app.backup.searchBackup(source, { query: '安装', batchId: first.data.batchId }, limited),
      { code: 'UNAUTHORIZED' },
    );
    await assert.rejects(app.backup.searchBackup('another-source', { query: '安装' }, limited), {
      code: 'OUT_OF_SCOPE',
    });
  } finally {
    await app.close();
  }
  updateDatabase(origin, 'ALTER TABLE memories DROP COLUMN workspace_scope');
  const rejected = await invoke(
    'backup',
    'import',
    '--source',
    source,
    '--operation-id',
    'missing-scope',
  );
  assert.equal(rejected.error.code, 'SCHEMA_MIGRATION_REQUIRED');
  assert.deepEqual(rejected.error.details.missingColumns, ['workspace_scope']);
  assert.deepEqual((await invoke(...query)).data, current.data);
});
