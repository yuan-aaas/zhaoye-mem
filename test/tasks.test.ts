import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { TaskService } from '../src/adapters/tasks.js';
import type { LocalWorker } from '../src/adapters/local-worker.js';
import { withRuntime } from './helpers.js';
import { once } from 'node:events';

test('task receipt is bound to the active attempt revision and stored', async () => {
  await withRuntime(async (runtime) => {
    const projectRoot = path.resolve('fixtures/project');
    const fakeWorker = { run: async (packet: { task_id: string; attempt_id: string }, binding: { taskRevision: number }) => ({ task_id: packet.task_id, attempt_id: packet.attempt_id, task_revision: binding.taskRevision, status: 'completed' as const, outcome: 'reported_success' as const, summary: 'Found two action items.', evidence_refs: [], artifact_refs: [], pending_questions: [], error_code: null, created_at: new Date().toISOString() }) };
    const tasks = new TaskService(runtime, fakeWorker as unknown as LocalWorker, new Map([['demo', projectRoot]]));
    const receipt = await tasks.delegate({ objective: 'Summarize open items', projectId: 'demo', ownerId: runtime.assistantId, requestId: 'request-1' });
    assert.equal(receipt.status, 'completed');
    assert.equal(receipt.outcome, 'reported_success');
    const task = tasks.get(receipt.task_id);
    assert.equal(task.status, 'completed');
    assert.equal(task.revision, 3);
    assert.equal(task.attempt_id, receipt.attempt_id);
  });
});

test('late completion after cancellation stays unknown and is retained as stale audit', async () => {
  await withRuntime(async (runtime) => {
    let finishWorker!: () => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const gate = new Promise<void>((resolve) => { finishWorker = resolve; });
    const fakeWorker = { run: async (packet: { task_id: string; attempt_id: string }, binding: { taskRevision: number }) => {
      notifyStarted(); await gate;
      return { task_id: packet.task_id, attempt_id: packet.attempt_id, task_revision: binding.taskRevision, status: 'completed' as const, outcome: 'reported_success' as const, summary: 'Late success.', evidence_refs: [], artifact_refs: [], pending_questions: [], error_code: null, created_at: new Date().toISOString() };
    } };
    const tasks = new TaskService(runtime, fakeWorker as unknown as LocalWorker, new Map([['demo', path.resolve('fixtures/project')]]));
    const pending = tasks.delegate({ objective: 'Read project', projectId: 'demo', ownerId: runtime.assistantId, requestId: 'request-2' });
    await started;
    const running = tasks.list()[0]!;
    await tasks.cancel(running.task_id);
    finishWorker();
    const returned = await pending;
    assert.equal(returned.status, 'unknown');
    assert.equal(tasks.get(running.task_id).status, 'unknown');
    assert.equal(runtime.events.all().some((event) => event.kind === 'task.stale_receipt'), true);
  });
});
