import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AssistantFramework, openAssistantFramework, AssistantError, type IdentityUpdateRequest } from '../src/index.js';
import { withRuntime } from './helpers.js';

const source = { adapter_id: 'dsh', request_id: 'user-request-1' };
const update = (operationId: string, revision: number, name: string): IdentityUpdateRequest => ({ operation_id: operationId, expected_revision: revision, patch: { user_profile: { display_name: name } } });

test('framework exposes a partial identity update API and records adapter provenance', async () => {
  await withRuntime(async (runtime) => {
    const api = new AssistantFramework(runtime);
    const initial = await api.readIdentity();
    const request = { operation_id: 'first-update', expected_revision: initial.revision, patch: { user_profile: { facts: [{ key: 'role', value: '开发者' }] } } };
    await api.updateIdentity(request, source);
    const receipt = await api.updateIdentity(update('second-update', 2, '小林'), source);
    const after = await api.readIdentity();
    assert.equal(receipt.revision, 3);
    assert.equal(receipt.identity_hash, after.identity_hash);
    assert.equal(after.kernel, initial.kernel);
    assert.deepEqual(after.habits, initial.habits);
    assert.deepEqual(after.user_profile, { display_name: '小林', facts: [{ key: 'role', value: '开发者' }] });
    const proposal = runtime.events.findOp(`identity-proposal:${receipt.proposal_id}`)!;
    assert.deepEqual((proposal.payload as { source: unknown }).source, source);
  });
});

test('same operation retries return the original receipt after a newer update and restart', async () => {
  await withRuntime(async (runtime) => {
    const api = new AssistantFramework(runtime);
    const request = update('retry-update', 1, '旧称呼');
    const first = await api.updateIdentity(request, source);
    await api.updateIdentity(update('new-update', 2, '新称呼'), source);
    await runtime.close();
    const reopened = await openAssistantFramework(runtime.root);
    try {
      assert.deepEqual(await reopened.updateIdentity(request, { ...source, request_id: 'retry-request' }), first);
      assert.equal((await reopened.readIdentity()).user_profile.display_name, '新称呼');
    } finally { await reopened.close(); }
  });
});

test('stale revisions and reusing an operation for different content do not overwrite identity', async () => {
  await withRuntime(async (runtime) => {
    const api = new AssistantFramework(runtime);
    await api.updateIdentity(update('operation-1', 1, '有效称呼'), source);
    const eventCount = runtime.events.all().length;
    await assert.rejects(() => api.updateIdentity(update('operation-2', 1, '过期修改'), source), (error: unknown) => error instanceof AssistantError && error.code === 'CONFLICT');
    await assert.rejects(() => api.updateIdentity(update('operation-1', 1, '不同内容'), source), (error: unknown) => error instanceof AssistantError && error.code === 'CONFLICT');
    assert.equal(runtime.events.all().length, eventCount);
    assert.equal((await api.readIdentity()).user_profile.display_name, '有效称呼');
  });
});

test('preview supplies full before and after values and only its adapter can commit', async () => {
  await withRuntime(async (runtime) => {
    const api = new AssistantFramework(runtime);
    const preview = await api.previewIdentityUpdate(update('preview', 1, '待保存'), source);
    assert.equal(preview.before.user_profile.display_name, null);
    assert.equal(preview.after.user_profile.display_name, '待保存');
    assert.equal((await api.readIdentity()).revision, 1);
    await assert.rejects(() => api.commitIdentityUpdate(preview.proposal_id, 1, { adapter_id: 'other-host', request_id: 'other-request' }), (error: unknown) => error instanceof AssistantError && error.code === 'UNAUTHORIZED');
    await api.commitIdentityUpdate(preview.proposal_id, 1, source);
    assert.equal((await api.readIdentity()).user_profile.display_name, '待保存');
  });
});

test('concurrent adapters share a serial queue and stale writes fail without corrupting the journal', async () => {
  await withRuntime(async (runtime) => {
    const first = new AssistantFramework(runtime);
    const second = new AssistantFramework(runtime);
    const results = await Promise.allSettled([
      first.updateIdentity(update('concurrent-1', 1, '先到'), source),
      second.updateIdentity(update('concurrent-2', 1, '后到'), { adapter_id: 'other-host', request_id: 'request-2' }),
    ]);
    assert.equal(results[0]!.status, 'fulfilled');
    assert.equal(results[1]!.status, 'rejected');
    await runtime.events.replay();
    assert.equal((await second.readIdentity()).revision, 2);
    assert.equal((await first.readIdentity()).user_profile.display_name, '先到');
  });
});

test('invalid and oversized patches leave the identity and journal unchanged', async () => {
  await withRuntime(async (runtime) => {
    const api = new AssistantFramework(runtime);
    const initial = await api.readIdentity();
    await assert.rejects(() => api.updateIdentity({ operation_id: 'empty', expected_revision: 1, patch: {} }, source), (error: unknown) => error instanceof AssistantError && error.code === 'INVALID_INPUT');
    await assert.rejects(() => api.updateIdentity({ operation_id: 'oversized', expected_revision: 1, patch: { kernel: '长'.repeat(1600) } }, source), (error: unknown) => error instanceof AssistantError && error.code === 'BUDGET_EXCEEDED');
    assert.deepEqual(await api.readIdentity(), initial);
    assert.equal(runtime.events.all().length, 0);
  });
});

test('adapters can save and query explicit memory through the public framework API', async () => {
  await withRuntime(async (runtime) => {
    const api = new AssistantFramework(runtime);
    const saved = await api.rememberMemory({ content: '用户明确保存的内容', attribution: { origin: 'user_direct', attributed_to: 'user', user_stance: 'not_stated', derivation: 'verbatim' } }, source, { operation_id: 'explicit-memory', project_id: 'demo' });
    const routes = await api.locateMemory('明确', 'demo');
    assert.equal(routes[0]!.record_id, saved.item.record_id);
    assert.equal((await api.recallMemory(routes[0]!.route_id, 'demo')).content, saved.item.content);
    assert.equal((await api.readIdentity()).revision, 1);
  });
});

test('adapters can list explicit memories for an index summary without changing data', async () => {
  await withRuntime(async (runtime) => {
    const api = new AssistantFramework(runtime);
    const attribution = { origin: 'user_direct', attributed_to: 'user', user_stance: 'not_stated', derivation: 'verbatim' } as const;
    const first = await api.rememberMemory({ content: '第一条', attribution }, source, { operation_id: 'list-1', project_id: 'demo' });
    await api.rememberMemory({ content: '第二条', attribution }, source, { operation_id: 'list-2', project_id: 'demo' });
    const other = await api.rememberMemory({ content: '别的项目', attribution }, source, { operation_id: 'list-3', project_id: 'other' });
    const eventCount = runtime.content.all().length + runtime.events.all().length;
    const listed = await api.listMemories(10, 'demo');
    assert.deepEqual(listed.map((item) => item.content), ['第二条', '第一条']);
    assert.equal(listed.some((item) => item.record_id === first.item.record_id), true);
    assert.equal((await api.listMemories(1, 'demo')).length, 1);
    assert.equal((await api.listMemories(10, null)).length, 3);
    await api.archiveMemory(other.item.record_id, other.item.revision, source, { project_id: 'other' });
    assert.equal((await api.listMemories(10, 'other')).length, 0);
    assert.equal(runtime.content.all().length + runtime.events.all().length >= eventCount, true);
  });
});

test('framework and memory core have no adapter, model-loop or delegation dependencies', async () => {
  for (const directory of ['framework', 'memory-core']) {
    const root = path.join(process.cwd(), 'src', directory);
    for (const file of await readdir(root)) {
      if (!file.endsWith('.ts')) continue;
      const code = await readFile(path.join(root, file), 'utf8');
      assert.doesNotMatch(code, /(?:from\s*|import\s*\()\s*['"][^'"]*(?:adapters\/|local-worker|lead-loop|model-chat|\/tasks)/);
    }
  }
});
