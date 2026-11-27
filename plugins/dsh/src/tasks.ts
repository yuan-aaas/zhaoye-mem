import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ZhaoyeError } from '@zhaoye/contracts';
import {
  type DshAgent,
  type DshApproval,
  type DshSession,
  type DshSessionController,
  type DshSessionHeader,
  type DshWorkspaces,
  type InboxItem,
  type SessionEvent,
  standardPreset,
} from './api.js';

export const taskDatabaseName = 'dsh-tasks.sqlite';
type TaskStatus =
  | 'preparing'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown';

interface Task {
  task_id: string;
  owner_session_id: string;
  call_key: string;
  worker_session_id: string;
  request_id: string;
  cwd: string;
  turn_id: number | null;
  status: TaskStatus;
  reason: string | null;
  updated_at: string;
}

export interface Delegation {
  goal: string;
  acceptance: string;
  context?: string;
  project_id?: string;
  target_session_id?: string;
}

interface SessionServices {
  agents: { get(id: string): DshAgent | undefined };
  sessions: { get(id: string): DshSession | undefined };
  sessionController: DshSessionController;
  workspaceRegistry: DshWorkspaces;
  get(name: 'approval'): DshApproval | undefined;
}

function terminal(status: TaskStatus) {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function activeTurn(events: readonly SessionEvent[]) {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type === 'turn/end') return null;
    if (event?.type === 'turn/start') return event.data.turn ?? null;
  }
  return null;
}

function sharesActiveTurn(events: readonly SessionEvent[], requestId: string): boolean {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type === 'turn/start') break;
    if (
      event?.type === 'user/message' &&
      event.data.source?.kind === 'user' &&
      event.data.source.rpcId !== requestId
    )
      return true;
  }
  return false;
}

function view(task: Task) {
  return {
    task_id: task.task_id,
    target_session_id: task.worker_session_id,
    request_id: task.request_id,
    turn_id: task.turn_id,
    status: task.status,
    reason: task.reason,
    updated_at: task.updated_at,
  };
}

export class TaskService {
  private readonly db: DatabaseSync;
  private readonly turnInputs = new Map<
    string,
    { turn: number; requests: Set<string | undefined> }
  >();

  constructor(
    root: string,
    private readonly host: SessionServices,
    private readonly projectRoots: ReadonlyMap<string, string>,
    private readonly targetGrants: ReadonlyMap<string, ReadonlySet<string>>,
  ) {
    this.db = new DatabaseSync(join(root, taskDatabaseName));
    try {
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
      if (version === 0 && !this.db.prepare('SELECT name FROM sqlite_schema LIMIT 1').get()) {
        this.db.exec(`
          BEGIN;
          CREATE TABLE tasks (
            task_id TEXT PRIMARY KEY,
            owner_session_id TEXT NOT NULL,
            call_key TEXT NOT NULL,
            worker_session_id TEXT NOT NULL,
            request_id TEXT NOT NULL UNIQUE,
            cwd TEXT NOT NULL,
            turn_id INTEGER,
            status TEXT NOT NULL,
            reason TEXT,
            updated_at TEXT NOT NULL,
            UNIQUE (owner_session_id, call_key)
          ) STRICT;
          CREATE INDEX tasks_worker ON tasks(worker_session_id, status);
          PRAGMA user_version=1;
          COMMIT;
        `);
      } else if (
        version !== 1 ||
        !this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='tasks'").get()
      ) {
        throw new ZhaoyeError('SCHEMA_MIGRATION_REQUIRED', '照夜 DSH 任务账本格式不兼容');
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  hasActiveTasks(): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM tasks WHERE status IN ('preparing','queued','running') LIMIT 1")
        .get(),
    );
  }

  private owned(owner: string, id: string): Task {
    const task = this.db
      .prepare('SELECT * FROM tasks WHERE task_id=? AND owner_session_id=?')
      .get(id, owner) as Task | undefined;
    if (!task) throw new ZhaoyeError('NOT_FOUND', '当前助手会话没有该任务');
    return task;
  }

  private update(task: Task, status: TaskStatus, reason: string | null, turn = task.turn_id): Task {
    const timestamp = new Date().toISOString();
    this.db
      .prepare(`
      UPDATE tasks
      SET status=?, reason=?, turn_id=?, updated_at=?
      WHERE task_id=? AND status NOT IN ('completed', 'failed', 'cancelled')
    `)
      .run(status, reason, turn, timestamp, task.task_id);
    return this.owned(task.owner_session_id, task.task_id);
  }

  async delegate(caller: DshAgent, callId: string, input: Delegation, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!callId) throw new ZhaoyeError('INVALID_INPUT', '宿主未提供工具调用 ID');
    const owner = caller.session.id;
    const callKey = `${activeTurn(caller.session.snapshotEvents()) ?? 'idle'}:${callId}`;
    const configured =
      input.project_id === undefined
        ? caller.session.header.cwd
        : this.projectRoots.get(input.project_id);
    if (typeof configured !== 'string' || !isAbsolute(configured)) {
      throw new ZhaoyeError('INVALID_INPUT', '委托需要当前工作区或已配置的项目 ID');
    }
    const cwd = await realpath(configured);
    if (!(await stat(cwd)).isDirectory())
      throw new ZhaoyeError('INVALID_INPUT', '工作区必须是目录');
    signal.throwIfAborted();

    const findPrevious = this.db.prepare(
      'SELECT * FROM tasks WHERE owner_session_id=? AND call_key=?',
    );
    const previous = findPrevious.get(owner, callKey) as Task | undefined;
    if (previous) return view(previous);

    const taskId = randomUUID();
    const targetId = input.target_session_id ?? taskId;
    if (input.target_session_id !== undefined) {
      if (targetId === owner) {
        throw new ZhaoyeError('INVALID_INPUT', '请选择当前助手会话以外的会话');
      }
      await this.assertTarget(await this.targetHeader(targetId, signal), cwd);
      signal.throwIfAborted();
    }

    const requestId = `zhaoye-${taskId}`;
    // Keep the database column name so existing task statuses remain readable.
    const inserted = this.db
      .prepare(`
      INSERT INTO tasks (task_id, owner_session_id, call_key, worker_session_id, request_id, cwd, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'preparing', ?)
      ON CONFLICT (owner_session_id, call_key) DO NOTHING
    `)
      .run(taskId, owner, callKey, targetId, requestId, cwd, new Date().toISOString());
    if (inserted.changes === 0) {
      const existing = findPrevious.get(owner, callKey) as Task | undefined;
      if (!existing) throw new ZhaoyeError('CONFLICT', '派发记录发生冲突');
      return view(existing);
    }

    if (input.target_session_id !== undefined) {
      try {
        await this.authorizeTarget(caller, callId, targetId, signal);
      } catch (error) {
        this.update(this.owned(owner, taskId), 'failed', 'target_authorization_failed');
        throw error;
      }
    }

    try {
      if (input.target_session_id === undefined) {
        const workspace = await this.host.workspaceRegistry.resolveByPath(cwd);
        signal.throwIfAborted();
        const result = await this.host.sessionController.create({
          sessionId: targetId,
          agentPreset: standardPreset,
          ...(workspace ? { workspaceId: workspace.id } : { cwd }),
        });
        if (result.sessionId !== targetId) {
          throw new ZhaoyeError('CONFLICT', '宿主返回了非预期的目标会话 ID');
        }
      }
      const live = this.host.sessions.get(targetId);
      if (live) await this.assertTarget(live.header, cwd);
    } catch (error) {
      this.update(this.owned(owner, taskId), 'failed', 'session_create_failed');
      throw error;
    }

    const text = [
      `工作目标：${input.goal}`,
      `验收条件：${input.acceptance}`,
      input.context ? `必要上下文：${input.context}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    try {
      const accepted = await this.host.sessionController.prompt(
        {
          requestId,
          sessionId: targetId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
        signal,
      );
      if (!accepted.accepted) throw new ZhaoyeError('CONFLICT', '宿主未接受工作派发');
    } catch (error) {
      const current = this.owned(owner, taskId);
      if (current.status === 'preparing') this.update(current, 'unknown', 'admission_unconfirmed');
      throw error;
    }

    const current = this.owned(owner, taskId);
    return view(current.status === 'preparing' ? this.update(current, 'queued', null) : current);
  }

  private async targetHeader(sessionId: string, signal: AbortSignal): Promise<DshSessionHeader> {
    const live = this.host.sessions.get(sessionId);
    if (live) return live.header;
    const frames = this.host.sessionController.follow(
      {
        address: { kind: 'session', sessionId },
        maxMessages: 1,
        activate: false,
      },
      signal,
    );
    for await (const frame of frames) {
      if (frame.type === 'snapshot') return frame.header;
    }
    throw new ZhaoyeError('NOT_FOUND', '找不到目标会话');
  }

  private async authorizeTarget(
    caller: DshAgent,
    callId: string,
    targetId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const owner = caller.session.id;
    if (this.targetGrants.get(owner)?.has(targetId)) return;
    const created = this.db
      .prepare(`
      SELECT 1 FROM tasks
      WHERE owner_session_id=? AND task_id=? AND worker_session_id=?
      AND status IN ('queued', 'running', 'completed', 'cancelled')
    `)
      .get(owner, targetId, targetId);
    if (created) return;
    const outcome = await this.host.get('approval')?.request({
      agent: caller,
      toolName: 'zhaoye_delegate',
      callId,
      reason: `允许将本次任务及其必要上下文发送到已有 DSH 会话 ${targetId} 吗？`,
      signal,
    });
    signal.throwIfAborted();
    if (outcome !== 'allowed-once') {
      throw new ZhaoyeError('UNAUTHORIZED', '当前派发没有目标会话授权');
    }
  }

  private async assertTarget(header: DshSessionHeader, cwd: string): Promise<void> {
    if (
      header.origin === 'subagent' ||
      !header.cwd ||
      !isAbsolute(header.cwd) ||
      relative(await realpath(header.cwd), cwd) !== ''
    ) {
      throw new ZhaoyeError('UNAUTHORIZED', '目标必须是所选工作区内的普通 DSH 会话');
    }
  }

  private fold(task: Task, events: readonly SessionEvent[]): Task {
    let turn: number | null = null;
    let matched = task.turn_id;
    for (const event of events) {
      if (event.type === 'turn/start') turn = event.data.turn ?? null;
      if (
        event.type === 'user/message' &&
        turn !== null &&
        event.data.source?.rpcId === task.request_id
      )
        matched = turn;
      if (event.type !== 'turn/end') continue;
      turn = null;
      if (matched === null || event.data.turn !== matched) continue;
      const reason = event.data.reason;
      if (reason?.kind === 'completed') return this.update(task, 'completed', 'completed', matched);
      if (reason?.kind === 'aborted' && reason.reason?.kind === 'user') {
        return this.update(task, 'cancelled', 'user', matched);
      }
      return this.update(
        task,
        'failed',
        reason?.error?.code ?? reason?.kind ?? 'turn_ended',
        matched,
      );
    }
    return matched !== null && task.status !== 'running'
      ? this.update(task, 'running', null, matched)
      : task;
  }

  observe(session: DshSession, event: SessionEvent): void {
    if (event.type === 'turn/start' && typeof event.data.turn === 'number') {
      this.turnInputs.set(session.id, { turn: event.data.turn, requests: new Set() });
      return;
    }
    if (event.type === 'turn/end' && this.turnInputs.get(session.id)?.turn === event.data.turn) {
      this.turnInputs.delete(session.id);
    }
    if (event.type !== 'user/message' && event.type !== 'turn/end') return;
    const pending = this.db
      .prepare(
        "SELECT * FROM tasks WHERE worker_session_id=? AND status NOT IN ('completed', 'failed', 'cancelled')",
      )
      .all(session.id) as unknown as Task[];
    if (!pending.length) return;
    const events = session.snapshotEvents();
    for (const task of pending) this.fold(task, events);
  }

  claimed(sessionId: string, source: InboxItem['source'], turn: number): void {
    const inputs = this.turnInputs.get(sessionId);
    if (source.kind === 'user' && inputs?.turn === turn) inputs.requests.add(source.rpcId);
    const task = this.pendingInput(sessionId, source.rpcId);
    if (task && task.turn_id === null) this.update(task, 'running', null, turn);
  }

  discarded(sessionId: string, requestId: string | undefined): void {
    const task = this.pendingInput(sessionId, requestId);
    if (task && task.turn_id === null) this.update(task, 'cancelled', 'queue_discarded');
  }

  private pendingInput(sessionId: string, requestId?: string): Task | undefined {
    if (!requestId) return undefined;
    return this.db
      .prepare(
        "SELECT * FROM tasks WHERE worker_session_id=? AND request_id=? AND status NOT IN ('completed','failed','cancelled')",
      )
      .get(sessionId, requestId) as Task | undefined;
  }

  private async reconcile(task: Task, signal: AbortSignal): Promise<Task> {
    if (terminal(task.status)) return task;
    const live = this.host.sessions.get(task.worker_session_id);
    if (live) return this.fold(task, live.snapshotEvents());
    const events: SessionEvent[] = [];
    let beforeSeq: number | undefined;
    try {
      // Bounded cold reads keep status requests independent of an arbitrarily long session.
      for (let page = 0; page < 4; page++) {
        const response = await this.host.sessionController.events(
          {
            address: { kind: 'session', sessionId: task.worker_session_id },
            maxMessages: 50,
            ...(beforeSeq === undefined ? {} : { beforeSeq }),
          },
          signal,
        );
        const batch = response.records.map((record) => record.event);
        events.unshift(...batch);
        const first = batch[0]?.seq;
        if (!response.hasMore || first === undefined || first === beforeSeq) break;
        beforeSeq = first;
      }
    } catch (error) {
      signal.throwIfAborted();
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== 'session/not-found') throw error;
    }
    const current = this.owned(task.owner_session_id, task.task_id);
    if (terminal(current.status)) return current;
    const nowLive = this.host.sessions.get(task.worker_session_id);
    if (nowLive) return this.fold(current, nowLive.snapshotEvents());
    const reconciled = this.fold(current, events);
    return terminal(reconciled.status)
      ? reconciled
      : this.update(reconciled, 'unknown', 'session_unconfirmed');
  }

  async recover(reportFailure: (taskId: string, error: unknown) => void): Promise<void> {
    const pending = this.db
      .prepare("SELECT * FROM tasks WHERE status NOT IN ('completed', 'failed', 'cancelled')")
      .all() as unknown as Task[];
    for (const task of pending) {
      try {
        await this.reconcile(task, AbortSignal.timeout(5_000));
      } catch (error) {
        const current = this.owned(task.owner_session_id, task.task_id);
        if (!terminal(current.status) && !this.host.sessions.get(task.worker_session_id)) {
          this.update(current, 'unknown', 'recovery_read_failed');
        }
        reportFailure(task.task_id, error);
      }
    }
  }

  async status(owner: string, id: string, signal: AbortSignal) {
    return view(await this.reconcile(this.owned(owner, id), signal));
  }

  async cancel(owner: string, id: string, signal: AbortSignal) {
    const task = await this.reconcile(this.owned(owner, id), signal);
    if (terminal(task.status)) return view(task);
    signal.throwIfAborted();
    const agent = this.host.agents.get(task.worker_session_id);
    if (!agent) throw new ZhaoyeError('CONFLICT', '工作轮次当前无法安全取消');
    const queueItem = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].find(
      (item) => item.source.rpcId === task.request_id,
    );
    if (queueItem) {
      const result = await this.host.sessionController.updateQueue({
        sessionId: task.worker_session_id,
        itemId: queueItem.id,
        action: { kind: 'remove' },
      });
      if (!result.accepted) throw new ZhaoyeError('CONFLICT', '宿主未接受移除队列请求');
      return view(this.update(task, 'cancelled', 'queue_removed'));
    }
    const events = agent.session.snapshotEvents();
    if (
      task.turn_id === null ||
      activeTurn(events) !== task.turn_id ||
      agent.status !== 'running'
    ) {
      throw new ZhaoyeError('CONFLICT', '当前活动轮次与已派发任务不匹配');
    }
    const inputs = this.turnInputs.get(task.worker_session_id);
    if (
      inputs?.turn !== task.turn_id ||
      inputs.requests.size !== 1 ||
      !inputs.requests.has(task.request_id) ||
      sharesActiveTurn(events, task.request_id)
    ) {
      throw new ZhaoyeError('CONFLICT', '无法确认任务独占当前轮次，请在工作会话中停止');
    }
    const result = this.host.sessionController.cancel({ sessionId: task.worker_session_id });
    if (!result.accepted) throw new ZhaoyeError('CONFLICT', '宿主未接受取消请求');
    return { ...view(this.owned(owner, id)), cancel_requested: true };
  }
}
