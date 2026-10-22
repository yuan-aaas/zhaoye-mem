import { randomUUID } from 'node:crypto';
import { AssistantError } from '../contracts/errors.js';
import { TaskPacketSchema, WorkerReceiptSchema, type TaskPacket, type WorkerReceipt } from '../contracts/schemas.js';
import type { Runtime } from '../infrastructure/runtime.js';
import type { LocalWorker, WorkerBinding } from './local-worker.js';

type TaskSnapshot = { task_id: string; attempt_id: string | null; owner_id: string; project_id: string; revision: number; status: 'created' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'; packet: TaskPacket; receipt?: WorkerReceipt; updated_at: string };
function latestTasks(runtime: Runtime): Map<string, TaskSnapshot> {
  const map = new Map<string, TaskSnapshot>();
  for (const event of runtime.events.all()) {
    const payload = event.payload as TaskSnapshot;
    if (!payload.task_id || !event.kind.startsWith('task.')) continue;
    if (event.kind === 'task.stale_receipt') continue;
    const current = map.get(payload.task_id);
    if (!current || payload.revision >= current.revision) map.set(payload.task_id, payload);
  }
  return map;
}

export class TaskService {
  private readonly controllers = new Map<string, AbortController>();
  private runningCount = 0;

  constructor(private readonly runtime: Runtime, private readonly worker: LocalWorker, private readonly projectRoots: Map<string, string>) {}

  async reconcileAfterRestart(): Promise<void> {
    for (const task of latestTasks(this.runtime).values()) {
      if (task.status !== 'running' || !task.attempt_id) continue;
      const next: TaskSnapshot = { ...task, revision: task.revision + 1, status: 'unknown', updated_at: new Date().toISOString() };
      await this.runtime.events.append({ op_id: `task-unknown:${task.attempt_id}`, kind: 'task.unknown', payload: next });
    }
  }

  list(): TaskSnapshot[] { return [...latestTasks(this.runtime).values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)); }
  get(taskId: string): TaskSnapshot { const task = latestTasks(this.runtime).get(taskId); if (!task) throw new AssistantError('NOT_FOUND'); return task; }

  private async startAttempt(task: TaskSnapshot, objective: string, acceptance: string, necessaryContext: string, requestId = task.packet.request_id): Promise<WorkerReceipt> {
    if (this.runningCount >= 1) throw new AssistantError('BUDGET_EXCEEDED', 'Worker 并发上限为 1。');
    const projectRoot = this.projectRoots.get(task.project_id);
    if (!projectRoot) throw new AssistantError('OUT_OF_SCOPE', `项目 ${task.project_id} 未登记。`);
    this.runningCount += 1;
    const controller = new AbortController();
    const attemptId = randomUUID();
    const packet = TaskPacketSchema.parse({ task_id: task.task_id, attempt_id: attemptId, request_id: requestId, owner_id: task.owner_id, project_id: task.project_id, objective, acceptance, necessary_context: necessaryContext, created_at: new Date().toISOString() });
    const running: TaskSnapshot = { ...task, attempt_id: attemptId, packet, revision: task.revision + 1, status: 'running', updated_at: new Date().toISOString() };
    await this.runtime.events.append({ op_id: `task-attempt:${attemptId}`, kind: 'task.attempt_started', payload: running });
    this.controllers.set(task.task_id, controller);
    try {
      const binding: WorkerBinding = { projectRoot, projectId: task.project_id, ownerId: task.owner_id, taskRevision: running.revision };
      const receipt = await this.worker.run(packet, binding, controller.signal);
      return await this.acceptReceipt(receipt, running);
    } catch (error) {
      const status = error instanceof AssistantError && ['TIMEOUT', 'COMMIT_UNKNOWN'].includes(error.code) ? 'unknown' : 'failed';
      const receipt: WorkerReceipt = { task_id: task.task_id, attempt_id: attemptId, task_revision: running.revision, status, outcome: 'none', summary: error instanceof AssistantError ? error.message.slice(0, 600) : 'Worker 执行失败。', evidence_refs: [], artifact_refs: [], pending_questions: [], error_code: error instanceof AssistantError ? error.code : 'WORKER_ERROR', created_at: new Date().toISOString() };
      return this.acceptReceipt(receipt, running);
    } finally {
      this.controllers.delete(task.task_id);
      this.runningCount -= 1;
    }
  }

  private async acceptReceipt(raw: WorkerReceipt, expected: TaskSnapshot): Promise<WorkerReceipt> {
    const receipt = WorkerReceiptSchema.parse(raw);
    const current = latestTasks(this.runtime).get(expected.task_id);
    if (!current || current.revision !== receipt.task_revision || current.attempt_id !== receipt.attempt_id || current.status !== 'running') {
      await this.runtime.events.append({ op_id: `task-stale-receipt:${receipt.attempt_id}:${receipt.created_at}`, kind: 'task.stale_receipt', payload: { task_id: receipt.task_id, attempt_id: receipt.attempt_id, task_revision: receipt.task_revision, status: receipt.status, received_at: new Date().toISOString() } });
      if (current?.receipt) return current.receipt;
      return WorkerReceiptSchema.parse({ ...receipt, status: 'unknown', outcome: 'none', summary: 'Worker 回执已过期，没有改变当前任务状态。请用 /task 查看最新状态。', evidence_refs: [], artifact_refs: [], error_code: 'STALE_RECEIPT', created_at: new Date().toISOString() });
    }
    const terminal: TaskSnapshot = { ...current, revision: current.revision + 1, status: receipt.status, receipt, updated_at: new Date().toISOString() };
    await this.runtime.events.append({ op_id: `task-receipt:${receipt.attempt_id}`, kind: 'task.receipt', payload: terminal });
    return receipt;
  }

  async delegate(input: { objective: string; acceptance?: string; necessaryContext?: string; projectId: string; ownerId: string; requestId: string }): Promise<WorkerReceipt> {
    if (this.list().filter((task) => task.status === 'created').length >= 8) throw new AssistantError('BUDGET_EXCEEDED', '待执行任务队列上限为 8。');
    if (this.list().some((task) => ['created', 'running'].includes(task.status))) throw new AssistantError('BUDGET_EXCEEDED', '当前每个用户请求最多启动 1 个 Worker 任务。');
    const taskId = randomUUID();
    const attemptId = randomUUID();
    const packet = TaskPacketSchema.parse({ task_id: taskId, attempt_id: attemptId, request_id: input.requestId, owner_id: input.ownerId, project_id: input.projectId, objective: input.objective, acceptance: input.acceptance ?? '', necessary_context: input.necessaryContext ?? '', created_at: new Date().toISOString() });
    const created: TaskSnapshot = { task_id: taskId, attempt_id: null, owner_id: input.ownerId, project_id: input.projectId, revision: 1, status: 'created', packet, updated_at: new Date().toISOString() };
    await this.runtime.events.append({ op_id: `task-created:${taskId}`, kind: 'task.created', payload: created });
    return this.startAttempt(created, input.objective, input.acceptance ?? '', input.necessaryContext ?? '');
  }

  async retry(taskId: string): Promise<WorkerReceipt> {
    const task = this.get(taskId);
    if (!['unknown', 'failed'].includes(task.status)) throw new AssistantError('CONFLICT', '只有 unknown 或 failed 任务可以显式创建新 attempt。');
    if (this.list().some((item) => item.status === 'running')) throw new AssistantError('BUDGET_EXCEEDED', '当前已有运行中的 Worker。');
    return this.startAttempt(task, task.packet.objective, task.packet.acceptance, task.packet.necessary_context, randomUUID());
  }

  async cancel(taskId: string): Promise<TaskSnapshot> {
    const task = this.get(taskId);
    if (task.status !== 'running') throw new AssistantError('CONFLICT', '任务当前不在运行。');
    this.controllers.get(taskId)?.abort();
    const current = this.get(taskId);
    const next: TaskSnapshot = { ...current, revision: current.revision + 1, status: 'unknown', updated_at: new Date().toISOString() };
    await this.runtime.events.append({ op_id: `task-cancel-unknown:${task.attempt_id}`, kind: 'task.unknown', payload: next });
    return next;
  }
}
