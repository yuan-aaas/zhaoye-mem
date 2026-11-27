import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  createZhaoye,
  doctor,
  explicitPreference,
  inferredPreference,
  openAssetLibrary,
  type Zhaoye,
} from '@zhaoye/app';
import {
  type ActorContext,
  ActorContextSchema,
  type AdapterManifest,
  type ConfigBundleWrite,
  type IdentityDocument,
  ZhaoyeError,
} from '@zhaoye/contracts';
import type {
  DshAgent,
  DshApproval,
  DshSession,
  DshSessionController,
  DshWorkspaces,
  InboxItem,
  SessionEvent,
  ToolExecution,
} from './api.js';
import { assistantPreset } from './api.js';
import { userEvidence, verifyDistilledPreference } from './preference-context.js';
import { createSetup, type DshSetupConnection } from './setup.js';
import { TaskService, taskDatabaseName } from './tasks.js';

export const name = 'dsh-plugin-zhaoye';
export const provide = ['zhaoyeDsh'];
export const inject = ['sessionController', 'sessions', 'agents', 'workspaceRegistry'];

export interface DshPluginContext {
  agents: { get(id: string): DshAgent | undefined; list?(): DshAgent[] };
  sessions: { get(id: string): DshSession | undefined };
  sessionController: DshSessionController;
  workspaceRegistry: DshWorkspaces;
  get(name: 'approval'): DshApproval | undefined;
  reflect: { provide(name: string, service: DshService): void; get?(name: string): unknown };
  plugin?(definition: {
    name: string;
    inject: string[];
    apply(context: { connection: Partial<DshSetupConnection> }): void;
  }): void;
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
  allowedIdentityProjects?: string[];
  allowedTargetSessions?: Record<string, string[]>;
  assetBundlePython?: string;
  autoEvolution?: boolean;
  preferenceDistillation?: boolean;
  syncReminder?: { enabled?: boolean; weekday?: number; timeZone?: string };
}

export interface DshService {
  identity(sessionId: string): ReturnType<Zhaoye['identity']['read']>;
  identityVersion(
    sessionId: string,
    revision: number,
  ): ReturnType<Zhaoye['identity']['readVersion']>;
  identityHistory(sessionId: string): ReturnType<Zhaoye['identity']['listVersions']>;
  latestIdentity?(): IdentityDocument | undefined;
  withProfileUse?<T>(work: () => Promise<T>): Promise<T>;
  rememberPreference(agent: DshAgent): ReturnType<Zhaoye['evolution']['remember']>;
  listPreferences(sessionId: string): ReturnType<Zhaoye['evolution']['list']>;
  reviewPreference(
    id: string,
    decision: 'apply' | 'reject',
    execution: ToolExecution,
    agent: DshAgent,
  ): ReturnType<Zhaoye['evolution']['review']>;
  prepareReminder?(): Promise<void>;
  pendingReminder?(): boolean;
  syncStatus(sessionId: string, sourceId?: string): Promise<object>;
  syncMemory(
    sourceId: string | undefined,
    execution: ToolExecution,
    agent: DshAgent,
  ): ReturnType<Zhaoye['backup']['syncMneme']>;
  assets(): ReturnType<typeof openAssetLibrary>;
  refreshAsset(assetId: string): Promise<{ asset_id: string; files: number }>;
  writeAsset(
    assetId: string,
    operation: ConfigBundleWrite,
    execution: ToolExecution,
    agent: DshAgent,
  ): ReturnType<Zhaoye['assets']['writeConfigBundle']>;
  withBackup<T>(
    sessionId: string,
    operation: (backup: Zhaoye['backup'], actor: ActorContext) => Promise<T>,
  ): Promise<T>;
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
  const defaultRoot = resolve(explicitRoot ?? join(homedir(), '.zhaoye'));
  const timeZone =
    config.syncReminder?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const weekday = config.syncReminder?.weekday ?? 5;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new RangeError();
  } catch {
    throw new ZhaoyeError('INVALID_INPUT', '同步提醒时区或星期无效');
  }
  const bundledPython =
    process.platform === 'win32'
      ? join(
          dirname(process.execPath),
          'resources',
          'runtime',
          'primary-runtime',
          'dependencies',
          'python',
          'python.exe',
        )
      : undefined;
  const python =
    config.assetBundlePython ??
    (bundledPython && existsSync(bundledPython) ? bundledPython : undefined);
  if (python !== undefined && (typeof python !== 'string' || !isAbsolute(python)))
    throw new ZhaoyeError('INVALID_INPUT', 'assetBundlePython 必须是受信任解释器的绝对路径');
  const projectRoots = new Map(Object.entries(config.projectRoots ?? {}));
  const identityProjects = ActorContextSchema.shape.granted_project_ids.safeParse(
    config.allowedIdentityProjects === undefined ? '*' : config.allowedIdentityProjects,
  );
  if (
    !identityProjects.success ||
    (config.allowedIdentityProjects !== undefined && !Array.isArray(config.allowedIdentityProjects))
  ) {
    throw new ZhaoyeError('INVALID_INPUT', 'allowedIdentityProjects 必须是有效的项目 ID 列表');
  }
  const grantedIdentityProjects = identityProjects.data;
  const projectGrants =
    grantedIdentityProjects === '*' ? undefined : new Set(grantedIdentityProjects);
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
  let switching: Promise<void> | undefined;
  let tasks: TaskService | undefined;
  let closing = false;
  const inFlight = new Set<Promise<unknown>>();
  let latest: IdentityDocument | undefined;
  let reminder: string | null = null;
  let reminderTimer: ReturnType<typeof setInterval> | undefined;
  const host: AdapterManifest = {
    host_id: 'dsh',
    display_name: 'DeepSeek Harness',
    capabilities: ['tools', 'prompt', 'session'],
    adapter_version: '0.1.0',
    data_schema: 1,
  };
  const setup = createSetup({
    defaultRoot,
    dshHome: resolve(process.env.DSH_HOME || join(homedir(), '.dsh')),
    activate: switchRoot,
    async initialize(dataRoot) {
      const app = await createZhaoye({ dataRoot, initIfMissing: true, host });
      await app.close();
    },
    async prepareChat() {
      await service.identity(assistantPreset);
    },
    async skills() {
      const skills = ctx.reflect.get?.('skills') as
        | { list(): Promise<Array<{ name: string }>> }
        | undefined;
      return skills?.list() ?? [];
    },
    session: (id) => ctx.sessions.get(id),
    async readyPreset() {
      const presets = ctx.reflect.get?.('agentPresets') as
        | {
            list(): Promise<Array<{ id: string; broken?: unknown }>>;
          }
        | undefined;
      return (
        (await presets?.list())?.some(
          (preset) => preset.id === assistantPreset && !preset.broken,
        ) ?? false
      );
    },
    logger: ctx.logger,
  });

  function assertAvailable() {
    if (closing) throw new ZhaoyeError('CONFLICT', '照夜插件正在关闭');
    if (switching) throw new ZhaoyeError('LOCKED', '照夜正在切换数据目录，请稍后再试');
  }

  function open(): Promise<Zhaoye> {
    assertAvailable();
    opening ??= createZhaoye({
      dataRoot: setup.root(),
      initIfMissing: config.initIfMissing === true,
      host,
    }).catch((error: unknown) => {
      opening = undefined;
      throw error;
    });
    return opening;
  }

  async function switchRoot(dataRoot: string, persist: () => Promise<void>) {
    assertAvailable();
    function assertIdle() {
      const active = ctx.agents.list?.().some(({ status, session }) => {
        if (status !== 'running') return false;
        const selected = session
          .snapshotEvents()
          .findLast((event) => event.type === 'agent-preset/selected');
        return (selected?.data.agentPreset ?? session.header.agentPreset) === assistantPreset;
      });
      if (closing || active || inFlight.size || tasks?.hasActiveTasks())
        throw new ZhaoyeError('LOCKED', '照夜还有对话或任务在运行，请结束后再切换目录');
    }
    const change = async () => {
      assertIdle();
      const previous = await opening?.catch(() => undefined);
      const next = await createZhaoye({ dataRoot, initIfMissing: false, host });
      let nextTasks: TaskService | undefined;
      let activated = false;
      try {
        const { document } = await next.identity.read(identityActor(next, assistantPreset));
        if (existsSync(join(next.dataRoot, taskDatabaseName)))
          nextTasks = new TaskService(next.dataRoot, ctx, projectRoots, targetGrants);
        assertIdle();
        await persist();
        const previousTasks = tasks;
        tasks = nextTasks;
        opening = Promise.resolve(next);
        latest = visibleIdentity(document);
        reminder = null;
        activated = true;
        try {
          previousTasks?.close();
        } finally {
          await previous?.close();
        }
      } catch (error) {
        if (!activated) {
          try {
            nextTasks?.close();
          } finally {
            await next.close();
          }
          throw error;
        }
        ctx.logger.warn(`照夜旧目录关闭失败：${String(error)}`);
      }
    };
    switching = change();
    try {
      await switching;
    } finally {
      switching = undefined;
    }
    recoverTasks();
  }

  function identityActor(app: Zhaoye, sessionId: string): ActorContext {
    return {
      adapter_id: 'dsh-plugin-zhaoye',
      host: 'dsh',
      session_id: sessionId,
      scope_id: app.assistantId,
      granted_project_ids: grantedIdentityProjects,
      granted_source_ids: [],
    };
  }
  function visibleIdentity(document: IdentityDocument) {
    if (projectGrants)
      document.project_state.projects = document.project_state.projects.filter((project) =>
        projectGrants.has(project.project_id),
      );
    return document;
  }
  function backupActor(app: Zhaoye, sessionId: string): ActorContext {
    return {
      adapter_id: 'dsh',
      host: 'dsh',
      session_id: sessionId,
      scope_id: app.assistantId,
      granted_project_ids: '*',
      granted_source_ids: '*',
      backup_unassigned: true,
      backup_history: true,
    };
  }
  async function syncOverview(app: Zhaoye, actor: ActorContext, claim = false, sourceId?: string) {
    const sources = await app.backup.listSources(actor);
    if (sourceId && !sources.some((source) => source.sourceId === sourceId))
      throw new ZhaoyeError('NOT_FOUND', '没有这个本地 Mneme 来源');
    const states = await Promise.all(
      sources.map(async (source) => ({
        source_id: source.sourceId,
        ...(await app.backup.syncStatus(source.sourceId, actor)),
      })),
    );
    const due =
      config.syncReminder?.enabled === false
        ? null
        : await app.backup.reminder({
            timeZone,
            weekday,
            claim,
            successes: states.map((state) => state.succeededAt),
          });
    if (!switching && app.dataRoot === setup.root()) reminder = claim ? null : due;
    return {
      sources: sourceId ? states.filter((state) => state.source_id === sourceId) : states,
      status: sources.length ? 'configured' : 'source_not_configured',
      reminder: due ? { week: due, message: '这周的记忆还没同步，要现在同步吗？' } : null,
    };
  }
  const service: DshService = {
    async identity(sessionId) {
      const instance = open();
      const app = await instance;
      const snapshot = await app.identity.read(identityActor(app, sessionId));
      visibleIdentity(snapshot.document);
      if (opening === instance && (!latest || snapshot.revision >= latest.revision))
        latest = snapshot.document;
      return snapshot;
    },
    latestIdentity() {
      assertAvailable();
      return latest;
    },
    async withProfileUse(work) {
      assertAvailable();
      const pending = work();
      inFlight.add(pending);
      try {
        return await pending;
      } finally {
        inFlight.delete(pending);
      }
    },
    async rememberPreference(agent) {
      const evidence = userEvidence(agent.session);
      if (!evidence) throw new ZhaoyeError('INVALID_INPUT', '当前轮没有可确认的纯文本用户消息');
      const app = await open();
      const result = await app.evolution.remember(evidence, identityActor(app, agent.session.id));
      await service.identity(agent.session.id);
      return result;
    },
    async listPreferences(sessionId) {
      const app = await open();
      return app.evolution.list(identityActor(app, sessionId));
    },
    async reviewPreference(id, decision, execution, agent) {
      const item = (await service.listPreferences(agent.session.id)).find(
        (entry) => entry.id === id,
      );
      if (!item) throw new ZhaoyeError('NOT_FOUND', '没有这条待查偏好');
      const result = await ctx.get('approval')?.request({
        agent,
        toolName: 'zhaoye_preference_review',
        callId: execution.callId,
        signal: execution.signal,
        reason: `确认${decision === 'apply' ? '应用' : '驳回'}这条偏好？${item.text}`,
      });
      execution.signal.throwIfAborted();
      if (result !== 'allowed-once') throw new ZhaoyeError('UNAUTHORIZED', '本次偏好处理未获确认');
      const app = await open();
      const reviewed = await app.evolution.review(
        id,
        decision,
        identityActor(app, agent.session.id),
      );
      await service.identity(agent.session.id);
      return reviewed;
    },
    async prepareReminder() {
      if (config.syncReminder?.enabled === false) return;
      const check = async () => {
        const app = await open();
        await syncOverview(app, backupActor(app, 'zhaoye-reminder'));
      };
      await check();
      if (!reminderTimer && !closing) {
        reminderTimer = setInterval(() => {
          if (closing || switching) return;
          void check().catch((error: unknown) =>
            ctx.logger.warn(`照夜同步提醒检查失败：${String(error)}`),
          );
        }, 30_000);
        reminderTimer.unref();
      }
    },
    pendingReminder: () => reminder !== null,
    async syncStatus(sessionId, sourceId) {
      const app = await open();
      const actor = backupActor(app, sessionId);
      const state = await syncOverview(app, actor, sourceId === undefined, sourceId);
      return {
        ...state,
        pending_preferences: (await app.evolution.list(identityActor(app, sessionId))).length,
      };
    },
    async syncMemory(sourceId, execution, agent) {
      const app = await open();
      const actor = backupActor(app, agent.session.id);
      const sources = await app.backup.listSources(actor);
      const selected = sourceId
        ? sources.find((source) => source.sourceId === sourceId)
        : sources.length === 1
          ? sources[0]
          : undefined;
      if (!selected)
        throw new ZhaoyeError(
          sources.length ? 'INVALID_INPUT' : 'NOT_FOUND',
          sources.length ? '请指定要同步的 Mneme 来源' : '尚未登记本地 Mneme 来源',
        );
      const outcome = await ctx.get('approval')?.request({
        agent,
        toolName: 'zhaoye_sync_now',
        callId: execution.callId,
        signal: execution.signal,
        reason: `增量同步本地 Mneme 来源 ${selected.sourceId}？`,
      });
      execution.signal.throwIfAborted();
      if (outcome !== 'allowed-once') throw new ZhaoyeError('UNAUTHORIZED', '本次增量同步未获确认');
      const result = await app.backup.syncMneme(
        {
          sourceId: selected.sourceId,
          operationId: randomUUID(),
          evolve: config.autoEvolution !== false,
        },
        { ...actor, backup_import: true },
        (row) =>
          verifyDistilledPreference(row, async (id) => {
            const active = ctx.sessions.get(id);
            if (active) return active.snapshotEvents();
            try {
              const saved = await ctx.sessionController.events(
                {
                  address: { kind: 'session', sessionId: id },
                  maxMessages: 100,
                },
                execution.signal,
              );
              return saved.records.map(({ event }) => event);
            } catch {
              return [];
            }
          }),
      );
      await service.identity(agent.session.id);
      await syncOverview(app, actor);
      return result;
    },
    async identityVersion(sessionId, revision) {
      const app = await open();
      return visibleIdentity(
        await app.identity.readVersion(identityActor(app, sessionId), revision),
      );
    },
    async identityHistory(sessionId) {
      const app = await open();
      return app.identity.listVersions(identityActor(app, sessionId), 200);
    },
    doctor: () => doctor(setup.root()),
    assets: () => openAssetLibrary(setup.root()),
    async refreshAsset(assetId) {
      const asset = await (await open()).assets.registerConfigBundle(assetId);
      return { asset_id: asset.asset_id, files: asset.files.length };
    },
    async writeAsset(assetId, operation, execution, agent) {
      if (!python)
        throw new ZhaoyeError('SOURCE_UNAVAILABLE', '此 DSH 未配置资产包解释器 assetBundlePython');
      const outcome = await ctx.get('approval')?.request({
        agent,
        toolName: 'zhaoye_asset_write',
        callId: execution.callId,
        signal: execution.signal,
        reason: `允许照夜对本地配置包 ${assetId}/${operation.path} 执行 ${operation.action}${operation.action === 'archive' ? `（${operation.report_type}）` : ''} 吗？`,
      });
      execution.signal.throwIfAborted();
      if (outcome !== 'allowed-once') throw new ZhaoyeError('UNAUTHORIZED', '本次资产写入未获授权');
      return (await open()).assets.writeConfigBundle(assetId, operation, python);
    },
    async withBackup(sessionId, operation) {
      const app = await open();
      return operation(app.backup, backupActor(app, sessionId));
    },
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
  ctx.plugin?.({
    name: 'zhaoye-onboarding',
    inject: ['connection'],
    apply: ({ connection }) => {
      if (connection.fetch) setup.bind({ fetch: connection.fetch });
    },
  });
  ctx.on('session/event', (session, event) => {
    if (closing) return;
    try {
      tasks?.observe(session, event);
    } catch (error) {
      ctx.logger.warn(`照夜工作会话状态更新失败：${String(error)}`);
    }
    if (switching || event.type !== 'turn/end' || event.data.reason?.kind !== 'completed') return;
    const evidence = userEvidence(session, true);
    if (!evidence) return;
    const explicit = explicitPreference(evidence.text);
    const fallback =
      config.autoEvolution !== false &&
      config.preferenceDistillation !== true &&
      inferredPreference(evidence.text);
    if (!explicit && !fallback) return;
    const pending = open()
      .then(async (app) => {
        const actor = identityActor(app, session.id);
        if (explicit) {
          await app.evolution.remember(evidence, actor);
          await service.identity(session.id);
        } else {
          await app.evolution.propose(evidence, actor);
        }
      })
      .catch((error: unknown) => {
        ctx.logger.warn(`照夜会话偏好处理失败：${String(error)}`);
      })
      .finally(() => inFlight.delete(pending));
    inFlight.add(pending);
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
    if (reminderTimer) clearInterval(reminderTimer);
    await switching?.catch(() => {});
    await Promise.allSettled(inFlight);
    const app = await opening?.catch(() => undefined);
    try {
      tasks?.close();
    } finally {
      await app?.close();
    }
  });

  if (config.initIfMissing === true) {
    void open().catch((error: unknown) => {
      ctx.logger.warn(`照夜数据根暂不可用：${String(error)}`);
    });
  }

  function recoverTasks() {
    if (closing || !existsSync(join(setup.root(), taskDatabaseName))) return;
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
  recoverTasks();
}
