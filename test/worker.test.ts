import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { LocalWorker } from '../src/adapters/local-worker.js';
import { AssistantError } from '../src/contracts/errors.js';
import type { ModelPort, ModelRequest } from '../src/adapters/model-chat.js';
import type { ModelReply } from '../src/contracts/schemas.js';
import { assertSafeDirectory, assertSafeFile } from '../src/infrastructure/files.js';

test('Worker uses independent context, line evidence, and source boundary', async () => {
  const base = path.join(process.cwd(), 'plugin_test', '.test-tmp'); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'worker-'));
  const project = path.join(dir, 'project'); await mkdir(project);
  await writeFile(path.join(project, 'README.md'), '# Demo\n- First task\n- Second task\n', 'utf8');
  let calls = 0;
  const model: ModelPort = { complete: async (request: ModelRequest): Promise<ModelReply> => {
    calls += 1;
    assert.equal(request.usage_role, 'worker');
    if (calls === 1) {
      assert.equal(request.messages.some((message) => message.content?.includes('lead private history')), false);
      return { content: null, finish_reason: 'tool_calls', tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read_text', arguments: JSON.stringify({ path: 'README.md', start_line: 2, line_count: 2 }) } }] };
    }
    const last = request.messages.at(-1)!;
    const result = JSON.parse(last.content ?? '{}') as { evidence: unknown };
    return { content: null, finish_reason: 'tool_calls', tool_calls: [{ id: 'finish-1', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ summary: 'Two tasks are listed.', evidence_refs: [result.evidence] }) } }] };
  } };
  try {
    const worker = new LocalWorker(model);
    const receipt = await worker.run({ task_id: 'task-1', attempt_id: 'attempt-1', request_id: 'request-1', owner_id: 'owner-1', project_id: 'demo', objective: 'Find the listed tasks', acceptance: 'Cite the source', necessary_context: '', created_at: new Date().toISOString() }, { projectRoot: project, projectId: 'demo', ownerId: 'owner-1', taskRevision: 2 });
    assert.equal(receipt.status, 'completed');
    assert.equal(receipt.outcome, 'reported_success');
    assert.equal(receipt.evidence_refs[0]?.start_line, 2);
    assert.equal(receipt.evidence_refs[0]?.end_line, 3);
    await assert.rejects(() => assertSafeFile(project, '../outside.txt', 100), (error: unknown) => error instanceof AssistantError && error.code === 'OUT_OF_SCOPE');
    await assert.rejects(() => assertSafeDirectory(project, '../'), (error: unknown) => error instanceof AssistantError && error.code === 'OUT_OF_SCOPE');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Worker refuses a symlink that points outside the registered project', async (t) => {
  const base = path.join(process.cwd(), 'plugin_test', '.test-tmp'); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'worker-link-'));
  const project = path.join(dir, 'project'); await mkdir(project);
  const secret = path.join(dir, 'outside.txt'); await writeFile(secret, 'private', 'utf8');
  try { await symlink(secret, path.join(project, 'outside.txt')); }
  catch { await rm(dir, { recursive: true, force: true }); t.skip('Windows symlink privilege is not available in this environment.'); return; }
  try { await assert.rejects(() => assertSafeFile(project, 'outside.txt', 100), (error: unknown) => error instanceof AssistantError && error.code === 'OUT_OF_SCOPE'); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
