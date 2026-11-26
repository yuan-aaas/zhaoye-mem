import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '@zhaoye/cli';
import type { AssetManifest } from '@zhaoye/contracts';

test('CLI registers a portable config bundle and reads only verified catalogued files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zhaoye-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assetId = 'ai-config-bundle';
  const bundle = join(root, 'assets', 'files', assetId);
  const catalog = join(root, 'assets', 'manifest.json');
  const loadCatalog = async (): Promise<AssetManifest> =>
    JSON.parse(await readFile(catalog, 'utf8'));
  async function invoke(...args: string[]) {
    let output = '';
    const code = await run([...args, '--data-root', root, '--json'], (line) => {
      output = line;
    });
    return { code, ...JSON.parse(output) };
  }
  assert.equal((await invoke('init')).code, 0);
  assert.deepEqual(await loadCatalog(), { schema_version: 1, assets: [] });
  assert.deepEqual((await invoke('assets', 'init')).data, { created: false });
  const register = () => invoke('assets', 'register-config-bundle', assetId);
  assert.equal((await register()).error.code, 'NOT_FOUND');
  const modules = ['01-skills', '06-work', '07-knowledge'];
  for (const module of [...modules, '07-knowledge/daily']) {
    await mkdir(join(bundle, module), { recursive: true });
  }
  const native = JSON.stringify({
    name: '个人配置',
    version: '1.0.0',
    description: '项目参考',
    modules: Object.fromEntries(modules.map((module) => [module, { path: `${module}/` }])),
    link_status: { path: 'C:/private/path' },
  });
  await writeFile(join(bundle, 'manifest.json'), native);
  await writeFile(join(bundle, '06-work', 'private.md'), 'private');
  await writeFile(join(bundle, '07-knowledge', 'daily', 'private.md'), 'private');
  const guide = '01-skills/SKILL.md';
  await writeFile(join(bundle, guide), '按需读取');
  await writeFile(join(bundle, '01-skills', 'large.txt'), 'x'.repeat(129 * 1024));
  assert.equal((await register()).code, 0);
  const snapshot = await readFile(catalog, 'utf8');
  assert.equal((await register()).code, 0);
  assert.equal(await readFile(catalog, 'utf8'), snapshot);
  assert.equal(await readFile(join(bundle, 'manifest.json'), 'utf8'), native);
  assert.ok(!snapshot.includes('C:/private/path'));
  assert.equal(
    (await invoke('assets', 'list', '--query', '个人配置 项目参考')).data.items[0].asset_id,
    assetId,
  );
  const files = (await invoke('assets', 'files', assetId, '--limit', '1')).data;
  assert.equal(files.items[0].path, guide);
  assert.equal(files.next_offset, 1);
  assert.equal((await invoke('assets', 'read', assetId, guide)).data.content, '按需读取');
  for (const path of ['06-work/private.md', '07-knowledge/daily/private.md']) {
    assert.equal((await invoke('assets', 'read', assetId, path)).data.content, 'private');
  }
  assert.equal(
    (await invoke('assets', 'read', assetId, '../identity.json')).error.code,
    'INVALID_INPUT',
  );
  assert.equal((await invoke('assets', 'read', assetId, 'manifest.json')).data.content, native);
  assert.equal(
    (await invoke('assets', 'read', assetId, '01-skills/large.txt')).error.code,
    'BUDGET_EXCEEDED',
  );
  assert.equal((await invoke('assets', 'verify', assetId)).data.verified, true);
  await writeFile(join(bundle, guide), '修改后');
  assert.equal((await invoke('assets', 'read', assetId, guide)).error.code, 'INTEGRITY_FAILED');
  assert.equal((await invoke('assets', 'verify', assetId)).error.code, 'INTEGRITY_FAILED');
  const before = (await loadCatalog()).assets[0]?.created_at;
  assert.equal((await register()).code, 0);
  assert.equal((await loadCatalog()).assets[0]?.created_at, before);
  assert.equal((await invoke('assets', 'read', assetId, guide)).data.content, '修改后');

  await symlink(join(root, 'identity'), join(bundle, '01-skills', 'external'), 'junction');
  const updated = await readFile(catalog, 'utf8');
  assert.equal((await register()).error.code, 'INVALID_INPUT');
  assert.equal(await readFile(catalog, 'utf8'), updated);
});
