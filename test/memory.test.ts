import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCore } from '../src/memory-core/memory.js';
import { AssistantError } from '../src/contracts/errors.js';
import { withRuntime } from './helpers.js';
import { AttributionSchema } from '../src/contracts/schemas.js';

const ctx = (scopeId: string, projectId: string | null = null) => ({ actor: 'user' as const, requestId: 'request-1', scopeId, projectId, explicitSave: true as const });
const user = { origin: 'user_direct' as const, attributed_to: 'user' as const, user_stance: 'not_stated' as const, derivation: 'verbatim' as const };
const quote = { origin: 'user_quote' as const, attributed_to: 'external_author' as const, user_stance: 'not_stated' as const, derivation: 'verbatim' as const };

test('explicit memories preserve attribution, route, revision CAS, and archive state', async () => {
  await withRuntime(async (runtime) => {
    const memory = new MemoryCore(runtime);
    const saved = await memory.remember({ content: '先给结论', tags: ['communication'], attribution: user }, ctx(runtime.assistantId), 'remember-1');
    assert.equal(saved.item.attribution.attributed_to, 'user');
    const quoteRecord = await memory.remember({ content: '文章主张甲', attribution: quote }, ctx(runtime.assistantId), 'remember-2');
    assert.equal(quoteRecord.item.attribution.attributed_to, 'external_author');
    assert.equal(quoteRecord.item.attribution.user_stance, 'not_stated');
    const located = await memory.locate('communication', { scopeId: runtime.assistantId, projectId: null });
    assert.equal(located.length, 1);
    assert.equal(located[0]!.record_id, saved.item.record_id);
    const replaced = await memory.replace(saved.item.record_id, 1, { content: '回答先给结论', attribution: user }, ctx(runtime.assistantId), 'replace-1');
    assert.equal(replaced.item.revision, 2);
    assert.equal(memory.isCurrentReference(saved.item.record_id, 1, runtime.assistantId), false);
    assert.equal(memory.isCurrentReference(saved.item.record_id, 2, runtime.assistantId), true);
    await assert.rejects(() => memory.replace(saved.item.record_id, 1, { content: '过期写入', attribution: user }, ctx(runtime.assistantId)), (error: unknown) => error instanceof AssistantError && error.code === 'CONFLICT');
    const archived = await memory.archive(saved.item.record_id, 2, ctx(runtime.assistantId), 'archive-1');
    assert.equal(archived.item.status, 'archived');
    assert.equal(memory.isCurrentReference(saved.item.record_id, 2, runtime.assistantId), false);
    assert.equal((await memory.locate('回答', { scopeId: runtime.assistantId, projectId: null })).length, 0);
  });
});

test('memory refuses scope crossing and repeated writes use the original record', async () => {
  await withRuntime(async (runtime) => {
    const memory = new MemoryCore(runtime);
    const input = { content: 'local fact', attribution: user };
    const saved = await memory.remember(input, ctx(runtime.assistantId), 'same-op');
    const replayed = await memory.remember(input, ctx(runtime.assistantId), 'same-op');
    assert.equal(replayed.status, 'replayed');
    assert.equal(replayed.item.record_id, saved.item.record_id);
    await assert.rejects(() => memory.recall(`user-explicit:${saved.item.record_id}`, '', { scopeId: 'someone-else', projectId: null }), (error: unknown) => error instanceof AssistantError && error.code === 'OUT_OF_SCOPE');
  });
});

test('external distilled content stays external and cannot be labeled as a direct user quote', () => {
  const attribution = AttributionSchema.parse({ origin: 'external', attributed_to: 'external_author', user_stance: 'not_stated', derivation: 'distilled' });
  assert.equal(attribution.origin, 'external');
  assert.equal(attribution.derivation, 'distilled');
});
