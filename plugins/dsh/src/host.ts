import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createZhaoye, doctor, type Zhaoye } from '@zhaoye/app';
import { ZhaoyeError } from '@zhaoye/contracts';
import type {
  DshAgent,
  DshApproval,
  DshSession,
  DshSessionController,
  DshWorkspaces,
  InboxItem,
  SessionEvent,
} from './api.js';
import { TaskService, taskDatabaseName } from './tasks.js';

export const name = 'dsh-plugin-zhaoye';
export const provide = ['zhaoyeDsh'];
export const inject = ['sessionController', 'sessions', 'agents', 'workspaceRegistry'];

export interface DshPluginContext {
  agents: { get(id: string): DshAgent | undefined };
  sessions: { get(id: string): DshSession | undefined };
  sessionController: DshSessionController;
  workspaceRegistry: DshWorkspaces;
  get(name: 'approval'): DshApproval | undefined;
  reflect: { provide(name: string, service: DshService): void };
  effect(register: () => () => Promise<void>): void;
  on(event: 'session/event', callback: (session: DshSession, event: SessionEvent) => void): void;
  on(
    event: 'agent/inbox/claimed',
    callback: (event: { agent: DshAgent; message: InboxItem; turn: number }) => void,
  ): void;
  on(
    event: 'agent/inbox/discarded',
    callback: (event: { agent: DshAgent; message: InboxItem }) => void,
  ): void;
  logger: { warn(message: string): void };
}

interface PluginConfig {
  dataRoot?: string;
  initIfMissing?: boolean;
  projectRoots?: Record<string, string>;
  allowedTargetSessions?: Record<string, string[]>;
}

export interface DshService {
  identity(sessionId: string): ReturnType<Zhaoye['identity']['read']>;
  doctor(): ReturnType<typeof doctor>;
  withTasks<T>(operation: (service: TaskService) => Promise<T>): Promise<T>;
}

export function apply(ctx: DshPluginContext, config: PluginConfig = {}): void {
  const explicitRoot = config.dataRoot;
  if (
    explicitRoot !== undefined &&
    (typeof explicitRoot !== 'string' || !isAbsolute(explicitRoot))
  ) {
    throw new ZhaoyeError('INVALID_INPUT', 'DSH 照夜数据根必须使用绝对路径');
  }
  if (config.initIfMissing === true && explicitRoot === undefined) {
    throw new ZhaoyeError('INVALID_INPUT', '自动初始化需要显式配置 DSH 照夜数据根');
  }
  const dataRoot = explicitRoot ?? join(homedir(), '.zhaoye');
  const projectRoots = new Map(Object.entries(config.projectRoots ?? {}));
  const targetGrants = new Map<string, ReadonlySet<string>>();
  for (const [owner, targets] of Object.entries(config.allowedTargetSessions ?? {})) {
    if (
      !owner.trim() ||
      !Array.isArray(targets) ||
      targets.some((id) => typeof id !== 'string' || !id.trim())
    ) {
      throw new ZhaoyeError(
        'INVALID_INPUT',
        'allowedTargetSessions 必须将发起会话 ID 映射到目标会话 ID 列表',
      );
    }
    targetGrants.set(owner, new Set(targets));
  }
  let opening: Promise<Zhaoye> | undefined;
  let tasks: TaskService | undefined;
  let closing = false;
  const inFlight = new Set<Promise<unknown>>();

  function open(): Promise<Zhaoye> {
    if (closing) throw new ZhaoyeError('CONFLICT', '照夜插件正在关闭');
    opening ??= createZhaoye({
      dataRoot,
      initIfMissing: config.initIfMissing === true,
      host: {
        host_id: 'dsh',
        display_name: 'DeepSeek Harness',
        capabilities: ['tools', 'prompt', 'session'],
        adapter_version: '0.1.0',
        data_schema: 1,
      },
    }).catch((error: unknown) => {
      opening = undefined;
      throw error;
    });
    return opening;
  }

  const service: DshService = {
    async identity(sessionId) {
      const app = await open();
      return app.identity.read({
        adapter_id: 'dsh-plugin-zhaoye',
        host: 'dsh',
        session_id: sessionId,
        scope_id: app.assistantId,
        granted_project_ids: [],
        granted_source_ids: [],
      });
    },
    doctor: () => doctor(dataRoot),
    async withTasks(operation) {
      const pending = open().then((app) => {
        tasks ??= new TaskService(app.dataRoot, ctx, projectRoots, targetGrants);
        return operation(tasks);
      });
      inFlight.add(pending);
      try {
        return await pending;
      } finally {
        inFlight.delete(pending);
      }
    },
  };

  ctx.reflect.provide('zhaoyeDsh', service);
  ctx.on('session/event', (session, event) => {
    if (closing) return;
    try {
      tasks?.observe(session, event);
    } catch (error) {
      ctx.logger.warn(`照夜工作会话状态更新失败：${String(error)}`);
    }
  });
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    if (closing) return;
    try {
      tasks?.claimed(agent.session.id, message.source, turn);
    } catch (error) {
      ctx.logger.warn(`照夜派发轮次关联失败：${String(error)}`);
    }
  });
  ctx.on('agent/inbox/discarded', ({ agent, message }) => {
    if (closing) return;
    try {
      tasks?.discarded(agent.session.id, message.source.rpcId);
    } catch (error) {
      ctx.logger.warn(`照夜排队状态更新失败：${String(error)}`);
    }
  });
  ctx.effect(() => async () => {
    closing = true;
    await Promise.allSettled(inFlight);
    const app = await opening?.catch(() => undefined);
    try {
      tasks?.close();
    } finally {
      await app?.close();
    }
  });

  if (existsSync(join(dataRoot, taskDatabaseName))) {
    void service
      .withTasks((taskService) =>
        taskService.recover((taskId, error) => {
          ctx.logger.warn(`照夜任务 ${taskId} 对账失败：${String(error)}`);
        }),
      )
      .catch((error: unknown) => {
        ctx.logger.warn(`照夜任务重新对账失败：${String(error)}`);
      });
  }
}
