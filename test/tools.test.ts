import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LeadTools } from '../src/adapters/local-lead-loop.js';

test('Lead exposes exactly the four MVP tools and no write-memory tool', () => {
  assert.deepEqual(LeadTools.map((tool) => tool.function.name), ['assistant_locate', 'assistant_recall', 'assistant_delegate', 'assistant_task_status']);
  assert.equal(LeadTools.some((tool) => /remember|replace|archive/i.test(tool.function.name)), false);
});
