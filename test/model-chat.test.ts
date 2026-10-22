import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { ChatCompletionsModel } from '../src/adapters/model-chat.js';
import { AssistantError } from '../src/contracts/errors.js';

test('Chat Completions adapter accepts a plain reply and rejects multi-tool replies', async () => {
  const base = path.join(process.cwd(), 'plugin_test', '.test-tmp'); await mkdir(base, { recursive: true });
  const usageFile = path.join(base, `usage-${process.pid}-${Date.now()}.jsonl`);
  const oldEnv = { base: process.env.MODEL_BASE_URL, model: process.env.MODEL_NAME, key: process.env.MODEL_API_KEY };
  const oldFetch = globalThis.fetch;
  process.env.MODEL_BASE_URL = 'https://model.example/v1'; process.env.MODEL_NAME = 'fixture-model'; process.env.MODEL_API_KEY = 'fixture-secret';
  let nextBody: unknown = { choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } };
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://model.example/v1/chat/completions');
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer fixture-secret');
    return new Response(JSON.stringify(nextBody), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const model = new ChatCompletionsModel(usageFile);
    const reply = await model.complete({ messages: [{ role: 'user', content: 'hello' }], request_id: 'request-model', usage_role: 'lead' });
    assert.equal(reply.content, 'hello');
    assert.equal(reply.usage?.total_tokens, 6);
    nextBody = { choices: [{ message: { content: null, tool_calls: [
      { id: 'one', type: 'function', function: { name: 'assistant_locate', arguments: '{}' } },
      { id: 'two', type: 'function', function: { name: 'assistant_recall', arguments: '{}' } },
    ] }, finish_reason: 'tool_calls' }] };
    await assert.rejects(() => model.complete({ messages: [{ role: 'user', content: 'x' }], request_id: 'request-multi', usage_role: 'lead' }), (error: unknown) => error instanceof AssistantError && error.code === 'MODEL_ERROR' && !error.message.includes('fixture-secret'));
  } finally {
    globalThis.fetch = oldFetch;
    if (oldEnv.base === undefined) delete process.env.MODEL_BASE_URL; else process.env.MODEL_BASE_URL = oldEnv.base;
    if (oldEnv.model === undefined) delete process.env.MODEL_NAME; else process.env.MODEL_NAME = oldEnv.model;
    if (oldEnv.key === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = oldEnv.key;
    await rm(usageFile, { force: true });
  }
});
