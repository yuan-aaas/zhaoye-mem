import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { initRoot, openRuntime } from '../src/infrastructure/runtime.js';
import { AssistantError } from '../src/contracts/errors.js';

test('single writer lock blocks a second writer instance without stealing the lock', async () => {
  const base = path.join(process.cwd(), 'plugin_test', '.test-tmp'); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'runtime-lock-'));
  const root = path.join(dir, 'data');
  try {
    await initRoot(root);
    const first = await openRuntime(root);
    try { await assert.rejects(() => openRuntime(root), (error: unknown) => error instanceof AssistantError && error.code === 'LOCKED'); }
    finally { await first.close(); }
    const second = await openRuntime(root); await second.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('init refuses to overwrite a non-empty directory without a manifest', async () => {
  const base = path.join(process.cwd(), 'plugin_test', '.test-tmp'); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'runtime-nonempty-'));
  try {
    const file = path.join(dir, 'user.txt'); await (await import('node:fs/promises')).writeFile(file, 'preserve');
    await assert.rejects(() => initRoot(dir), (error: unknown) => error instanceof AssistantError && error.code === 'CONFLICT');
    assert.equal(await (await import('node:fs/promises')).readFile(file, 'utf8'), 'preserve');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
