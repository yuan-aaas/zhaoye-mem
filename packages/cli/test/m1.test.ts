import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '@zhaoye/cli';

test('I-02 CLI init/apply/show/history/doctor and dry-run full lifecycle', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'zhaoye-cli-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, '数据 根');
  let lines: string[] = [];
  const command = async (args: string[]) => {
    lines = [];
    return run([...args, '--data-root', root, '--json'], (line) => lines.push(line));
  };
  assert.equal(await command(['init']), 0);
  const first = JSON.parse(lines[0] ?? '').data;
  assert.equal(first.created, true);
  assert.equal(await command(['init']), 0);
  assert.equal(JSON.parse(lines[0] ?? '').data.created, false);
  const path = join(parent, 'request.json');
  await writeFile(
    path,
    JSON.stringify({
      request_id: randomUUID(),
      operation_id: randomUUID(),
      expected_revision: 1,
      reason: 'user request',
      evidence_refs: [],
      update: { section: 'user_profile', display_name: '测试用户' },
    }),
  );
  assert.equal(await command(['identity', 'apply', path, '--dry-run']), 0);
  assert.equal(await command(['identity', 'show']), 0);
  assert.equal(JSON.parse(lines[0] ?? '').data.revision, 1);
  assert.equal(await command(['identity', 'apply', path]), 0);
  assert.equal(await command(['identity', 'show']), 0);
  assert.equal(JSON.parse(lines[0] ?? '').data.user_profile.display_name, '测试用户');
  assert.equal(await command(['identity', 'history']), 0);
  assert.equal(JSON.parse(lines[0] ?? '').data.length, 2);
  assert.equal(await command(['doctor']), 0);
  assert.equal(await command(['presence']), 0);
  assert.equal(
    await readFile(join(root, 'identity/identity.md'), 'utf8').then((s) => s.includes('测试用户')),
    true,
  );
  assert.equal(await command(['presence', '--release']), 4);
});
test('I-03 non-zhaoye nonempty directory is never initialized', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zhaoye-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'keep'), 'original');
  const lines: string[] = [];
  assert.equal(await run(['init', '--data-root', root, '--json'], (s) => lines.push(s)), 5);
  assert.deepEqual(await readdir(root), ['keep']);
  assert.equal(JSON.parse(lines[0] ?? '').error.code, 'CORRUPT_DATA');
});
test('CLI doctor on absent root does not create files', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'zhaoye-cli-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  assert.equal(await run(['doctor', '--data-root', join(parent, 'absent'), '--json'], () => {}), 5);
  assert.deepEqual(await readdir(parent), []);
});
test('CLI invalid options and non-JSON apply fail explicitly', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'zhaoye-cli-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  assert.equal(await run(['bad-command'], () => {}), 2);
  assert.equal(await run(['init', '--unknown'], () => {}), 2);
  const path = join(parent, 'bad.json');
  await writeFile(path, '{');
  assert.equal(
    await run(
      ['identity', 'apply', path, '--data-root', join(parent, 'absent'), '--json'],
      () => {},
    ),
    3,
  );
  assert.deepEqual(await readdir(parent), ['bad.json']);
});
test('CLI missing data-root value cannot treat the next option as a path', async () => {
  const lines: string[] = [];
  assert.equal(await run(['init', '--data-root', '--json'], (s) => lines.push(s)), 3);
  assert.equal(JSON.parse(lines[0] ?? '').error.code, 'INVALID_INPUT');
});
