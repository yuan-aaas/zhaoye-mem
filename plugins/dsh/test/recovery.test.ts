import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { DshAgent, DshSessionController, SessionEvent } from '../dist/api.js';
import { TaskService, taskDatabaseName } from '../dist/tasks.js';

test('a cold history failure leaves only that task unknown and recovers later tasks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zhaoye-dsh-recover-'));
  const history = new Map<string, SessionEvent[]>();
  let unreadable: string | undefined;
  const controller: DshSessionController = {
    async create({ sessionId }) {
      return { sessionId };
    },
    async prompt() {
      return { accepted: true };
    },
    cancel: () => assert.fail('recovery must not cancel'),
    updateQueue: async () => assert.fail('recovery must not edit the queue'),
    async events({ address }) {
      if (address.sessionId === unreadable) throw new Error('history unavailable');
      return {
        records: (history.get(address.sessionId) ?? []).map((event) => ({ event })),
        hasMore: false,
      };
    },
    follow() {
      assert.fail('new sessions do not need existing headers');
    },
  };
  const service = new TaskService(
    directory,
    {
      sessionController: controller,
      sessions: { get: () => undefined },
      agents: { get: () => undefined },
      workspaceRegistry: { resolveByPath: async () => undefined },
      get: () => undefined,
    },
    new Map(),
    new Map(),
  );
  try {
    const caller: DshAgent = {
      session: {
        id: 'assistant',
        header: { cwd: directory },
        snapshotEvents: () => [],
      },
      status: 'running',
      inbox: { nextTurn: [], nextStep: [] },
    };
    const input = { goal: '检查文件', acceptance: '记录结果' };
    const signal = new AbortController().signal;
    const first = await service.delegate(caller, 'first', input, signal);
    const second = await service.delegate(caller, 'second', input, signal);
    unreadable = first.target_session_id;
    history.set(second.target_session_id, [
      { seq: 0, type: 'turn/start', data: { turn: 3 } },
      {
        seq: 1,
        type: 'user/message',
        data: { source: { kind: 'user', rpcId: second.request_id } },
      },
      { seq: 2, type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
    ]);
    const errors: string[] = [];
    await service.recover((id) => {
      errors.push(id);
    });
    assert.deepEqual(errors, [first.task_id]);
    const db = new DatabaseSync(join(directory, taskDatabaseName), { readOnly: true });
    try {
      const read = db.prepare('SELECT status, reason FROM tasks WHERE task_id=?');
      assert.equal(read.get(first.task_id)?.status, 'unknown');
      assert.equal(read.get(first.task_id)?.reason, 'recovery_read_failed');
      assert.equal(read.get(second.task_id)?.status, 'completed');
    } finally {
      db.close();
    }
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
