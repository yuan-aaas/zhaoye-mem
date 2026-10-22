import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCore } from '../src/memory-core/memory.js';
import { TaskService } from '../src/adapters/tasks.js';
import { LeadLoop } from '../src/adapters/local-lead-loop.js';
import type { LocalWorker } from '../src/adapters/local-worker.js';
import type { ModelPort, ModelRequest } from '../src/adapters/model-chat.js';
import type { ModelReply } from '../src/contracts/schemas.js';
import { withRuntime } from './helpers.js';

test('completed conversation turns that depend on replaced memories are removed from Lead history', async () => {
  await withRuntime(async (runtime) => {
    const memory = new MemoryCore(runtime);
    const item = await memory.remember({ content: 'old preference', attribution: { origin: 'user_direct', attributed_to: 'user', user_stance: 'not_stated', derivation: 'verbatim' } }, { actor: 'user', requestId: 'memory-request', scopeId: runtime.assistantId, projectId: null, explicitSave: true }, 'history-memory');
    const worker = { run: async () => { throw new Error('not used'); } } as unknown as LocalWorker;
    const tasks = new TaskService(runtime, worker, new Map());
    let calls = 0;
    const model: ModelPort = { complete: async (request: ModelRequest): Promise<ModelReply> => {
      calls += 1;
      if (calls === 1) return { content: null, tool_calls: [{ id: 'recall-1', type: 'function', function: { name: 'assistant_recall', arguments: JSON.stringify({ route_id: `user-explicit:${item.item.record_id}` }) } }], finish_reason: 'tool_calls' };
      if (calls === 2) return { content: 'old answer', tool_calls: [], finish_reason: 'stop' };
      assert.equal(request.messages.some((message) => message.content?.includes('old answer')), false);
      assert.equal(request.messages.some((message) => message.content?.includes('tell me the preference')), false);
      return { content: 'fresh answer', tool_calls: [], finish_reason: 'stop' };
    } };
    const lead = new LeadLoop(runtime, memory, tasks, model);
    const context = { scopeId: runtime.assistantId, projectId: null, ownerId: runtime.assistantId, projects: new Map<string, string>() };
    assert.equal(await lead.turn('tell me the preference', context), 'old answer');
    await memory.replace(item.item.record_id, 1, { content: 'new preference', attribution: item.item.attribution }, { actor: 'user', requestId: 'replace-request', scopeId: runtime.assistantId, projectId: null, explicitSave: true }, 'replace-history');
    assert.equal(await lead.turn('what is the preference now?', context), 'fresh answer');
  });
});
