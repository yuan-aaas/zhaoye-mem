import { randomUUID } from 'node:crypto';
import type { HostService } from './host.js';
import type { TaskStore, TaskRecord } from './task-store.js';
import { renderWorkerPrompt, truncate } from './prompt.js';
import { parseWorkerReceipt, type WorkerReceipt } from './receipt.js';
import { resolveWorkerDirectory } from './projects.js';

type ToolExec = { agent?: any; signal?: AbortSignal };
export type DelegateDeps = { ctx: any; service: HostService; tasks: TaskStore };

/** Poll interval for the worker Session event log. */
const POLL_MS = 200;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function service(ctx: any, name: string): any {
  const viaGet = typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
  return viaGet ?? ctx?.[name];
}

async function notificationMessage(text: string): Promise<any> {
  const summary = [...text].slice(0, 120).join('');
  try {
    const specifier = '@deepseek-ai/dsh-llm';
    const mod: any = await import(specifier);
    if (typeof mod?.createUserMessage === 'function') {
      return mod.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'assistant-dsh', form: 'notice', summary } });
    }
  } catch {
    // fall back to a structurally compatible message
  }
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'assistant-dsh', form: 'notice', summary } };
}

function receiptNotice(task: TaskRecord): string {
  const lines = [`【委托完成】任务 ${task.task_id}`];
  const sessionId = task.child_session_id ? `（会话 ${task.child_session_id}）` : '';
  lines[0] = `${lines[0]}${sessionId}`;
  if (task.receipt) {
    if (task.receipt.degraded) lines.push('回执：Worker 没有返回结构化回执，以下是它最后一条消息的摘要。');
    lines.push(`摘要：${task.receipt.summary}`);
    if (task.receipt.evidence_refs.length > 0) {
      lines.push('证据：');
      for (const ref of task.receipt.evidence_refs) lines.push(`- ${ref.path}:${ref.start_line}-${ref.end_line} sha256=${ref.sha256.slice(0, 12)}`);
    }
    if ((task.receipt.artifact_refs ?? []).length > 0) {
      lines.push('产物：');
      for (const artifact of task.receipt.artifact_refs) lines.push(`- ${artifact}`);
    }
    if (task.receipt.pending_questions.length > 0) lines.push(`待确认：${task.receipt.pending_questions.join('；')}`);
  }
  lines.push('用 assistant_task_status 可查看完整回执；工作会话在侧栏里是一条独立对话，可以直接打开继续聊。');
  return lines.join('\n');
}

async function notifyParent(ctx: any, parentSessionId: string | null, text: string, fallbackParent?: any): Promise<void> {
  if (!parentSessionId && !fallbackParent) return;
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
    const parent = (parentSessionId ? agents?.get?.(parentSessionId) : undefined) ?? fallbackParent;
    if (!parent) return;
    const message = await notificationMessage(text);
    try {
      parent.followup(message);
    } catch {
      parent.inject(message);
    }
  } catch (error) {
    ctx.logger?.warn?.(`[assistant-dsh] 委托完成通知发送失败：${errorText(error)}`);
  }
}

async function finishTask(
  deps: DelegateDeps,
  task: TaskRecord,
  outcome: { status: 'completed' | 'failed' | 'unknown'; receipt?: WorkerReceipt; errorCode?: string; summary?: string },
  parent?: any,
): Promise<void> {
  const current = await deps.tasks.get(task.task_id);
  if (!current || current.status === 'cancelled') return;
  const updated = await deps.tasks.update(task.task_id, {
    status: outcome.status,
    receipt: outcome.receipt ?? null,
    error_code: outcome.errorCode ?? null,
  });
  const text = outcome.status === 'completed'
    ? receiptNotice(updated)
    : `【委托未完成】任务 ${task.task_id}\n${outcome.errorCode ?? 'UNKNOWN'}：${outcome.summary ?? 'Worker 未返回有效回执'}`;
  await notifyParent(deps.ctx, task.parent_session_id, text, parent);
}

/** Join the text blocks of one `assistant/message` event payload. */
function assistantText(data: any): string {
  const content = data?.message?.content ?? data?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part: any) => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
    .map((part: any) => part.text)
    .join('\n');
}

function degradedReceipt(text: string): WorkerReceipt {
  const flat = text.replace(/\s+/g, ' ').trim();
  return {
    summary: truncate(flat, 600) || '（Worker 没有返回可读结论）',
    evidence_refs: [],
    artifact_refs: [],
    pending_questions: [],
    degraded: true,
  };
}

async function settleTurn(deps: DelegateDeps, task: TaskRecord, text: string, parent: any): Promise<void> {
  const body = text.trim();
  if (!body) {
    await finishTask(deps, task, { status: 'failed', errorCode: 'EMPTY_WORKER_OUTPUT', summary: '工作会话结束了，但没有返回任何内容。' }, parent);
    return;
  }
  try {
    const receipt = await parseWorkerReceipt(body, task.cwd);
    await finishTask(deps, task, { status: 'completed', receipt }, parent);
  } catch (error) {
    // A Worker that answers in prose instead of a JSON receipt is still a usable
    // result: keep the final text as a degraded summary instead of losing it.
    deps.ctx.logger?.warn?.(`[assistant-dsh] Worker 回执解析失败，降级为摘要：${errorText(error)}`);
    await finishTask(deps, task, { status: 'completed', receipt: degradedReceipt(body) }, parent);
  }
}

/**
 * Follow the independent worker Session's event log until its current turn
 * ends, then hand the final assistant text to the receipt pipeline.
 */
function watchWorkerSession(deps: DelegateDeps, task: TaskRecord, sessionId: string, parent: any): void {
  const sessions = service(deps.ctx, 'sessions');
  let watermark = Number.NEGATIVE_INFINITY;
  let lastText = '';
  let settled = false;

  const stop = (): void => {
    if (settled) return;
    settled = true;
    clearInterval(timer);
    clearTimeout(timeout);
  };

  const timer = setInterval(() => {
    if (settled) return;
    let events: any[];
    try {
      const session = sessions?.get?.(sessionId);
      if (!session || typeof session.snapshotEvents !== 'function') return;
      events = session.snapshotEvents() ?? [];
    } catch (error) {
      deps.ctx.logger?.warn?.(`[assistant-dsh] 工作会话事件读取失败：${errorText(error)}`);
      return;
    }
    for (const event of events) {
      const seq = Number(event?.seq);
      if (!Number.isFinite(seq) || seq <= watermark) continue;
      watermark = seq;
      if (event.type === 'assistant/message') {
        const text = assistantText(event.data);
        if (text.trim()) lastText = text;
      } else if (event.type === 'turn/end') {
        stop();
        void settleTurn(deps, task, lastText, parent);
        return;
      }
    }
  }, POLL_MS);
  timer.unref?.();

  const timeout = setTimeout(() => {
    if (settled) return;
    stop();
    void finishTask(deps, task, {
      status: 'unknown',
      errorCode: 'DELEGATE_TIMEOUT',
      summary: `工作会话 ${sessionId} 超时仍未结束（可能在等待审批）。它仍在侧栏里，可以直接打开继续。`,
    }, parent);
  }, deps.service.config.delegateTimeoutMs);
  timeout.unref?.();
}

export async function delegateTask(
  input: { objective: string; acceptance: string; necessaryContext: string; projectId: string | null },
  exec: ToolExec,
  deps: DelegateDeps,
): Promise<unknown> {
  const parent = exec.agent;
  if (!parent) throw new Error('assistant_delegate 需要当前 Agent 上下文。');
  const parentSessionId = parent.session?.id ?? parent.id ?? null;
  const sessionCwd = parent.session?.header?.cwd;
  const resolved = await resolveWorkerDirectory(input.projectId, deps.service.config.projectMap, sessionCwd);
  const task = await deps.tasks.create({
    parent_session_id: parentSessionId,
    child_session_id: null,
    objective: input.objective,
    acceptance: input.acceptance,
    necessary_context: input.necessaryContext,
    project_id: resolved.projectId,
    cwd: resolved.cwd,
  });

  const controller = service(deps.ctx, 'sessionController');
  if (!controller || typeof controller.create !== 'function' || typeof controller.prompt !== 'function') {
    await finishTask(deps, task, { status: 'failed', errorCode: 'SESSION_CONTROLLER_UNAVAILABLE', summary: '当前宿主没有可用的会话服务，无法新开工作会话。' }, parent);
    throw new Error('当前宿主没有可用的会话服务，无法启动工作会话。');
  }

  // The worker is an ordinary Session (not a subagent): its cwd is the project
  // directory, so its sandbox and approval channel are the normal ones.
  let sessionId = '';
  try {
    const created = await controller.create({
      cwd: resolved.cwd,
      agentPreset: deps.service.config.workerPreset,
    });
    sessionId = typeof created?.sessionId === 'string' ? created.sessionId : '';
    if (!sessionId) throw new Error('sessionController.create 没有返回 sessionId');
  } catch (error) {
    await finishTask(deps, task, { status: 'failed', errorCode: 'DELEGATE_START_FAILED', summary: errorText(error) }, parent);
    throw error;
  }

  await deps.tasks.update(task.task_id, { status: 'running', child_session_id: sessionId });

  const prompt = renderWorkerPrompt({
    objective: input.objective,
    acceptance: input.acceptance,
    necessaryContext: input.necessaryContext,
    cwd: resolved.cwd,
    projectId: resolved.projectId,
    taskId: task.task_id,
  });

  try {
    await controller.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: prompt }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, new AbortController().signal);
  } catch (error) {
    await finishTask(deps, task, { status: 'failed', errorCode: 'PROMPT_REJECTED', summary: errorText(error) }, parent);
    throw error;
  }

  watchWorkerSession(deps, task, sessionId, parent);

  return {
    task_id: task.task_id,
    status: 'running',
    session_id: sessionId,
    message: `已新开工作会话 ${sessionId}（独立对话，可直接打开接管）。完成后会收到通知；可用 assistant_task_status 查询。`,
  };
}

export async function taskStatus(taskId: string, tasks: TaskStore): Promise<unknown> {
  const task = await tasks.get(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);
  return {
    task_id: task.task_id,
    attempt_id: task.attempt_id,
    status: task.status,
    session_id: task.child_session_id,
    objective: task.objective,
    project_id: task.project_id,
    cwd: task.cwd,
    receipt: task.receipt,
    error_code: task.error_code,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

export async function cancelTask(taskId: string, exec: ToolExec, deps: Pick<DelegateDeps, 'ctx' | 'tasks'>): Promise<unknown> {
  const task = await deps.tasks.get(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);
  if (task.status !== 'running') return { task_id: task.task_id, status: task.status, message: '任务当前不在运行，未改变状态。' };
  const controller = service(deps.ctx, 'sessionController');
  try {
    if (task.child_session_id && typeof controller?.cancel === 'function') {
      controller.cancel({ sessionId: task.child_session_id });
    }
  } catch (error) {
    deps.ctx.logger?.warn?.(`[assistant-dsh] 取消委托失败：${errorText(error)}`);
  }
  const updated = await deps.tasks.update(task.task_id, { status: 'cancelled', error_code: 'CANCELLED' });
  return { task_id: updated.task_id, status: updated.status };
}
