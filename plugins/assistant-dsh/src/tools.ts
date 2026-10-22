import { randomUUID } from 'node:crypto';
import type { HostService } from './host.js';
import type { TaskStore } from './task-store.js';
import { delegateTask, cancelTask, taskStatus } from './delegate.js';

type ToolExec = { agent?: any; signal?: AbortSignal; name?: string };
type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> };
  execute: (args: any, exec: ToolExec) => Promise<unknown>;
};

function tool(definition: Omit<ToolDefinition, 'output'> & { output?: ToolDefinition['output'] }): ToolDefinition {
  return {
    ...definition,
    output: definition.output ?? {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
  };
}

function attribution(mode: unknown) {
  if (mode === 'quote') return { origin: 'user_quote', attributed_to: 'external_author', user_stance: 'not_stated', derivation: 'verbatim' } as const;
  if (mode === 'external') return { origin: 'external', attributed_to: 'external_author', user_stance: 'not_stated', derivation: 'verbatim' } as const;
  return { origin: 'user_direct', attributed_to: 'user', user_stance: 'not_stated', derivation: 'verbatim' } as const;
}

function sessionOf(exec: ToolExec): { id: string | null; cwd: string | undefined } {
  const agent = exec.agent;
  return {
    id: agent?.session?.id ?? agent?.id ?? null,
    cwd: agent?.session?.header?.cwd,
  };
}

function projectOf(args: { project_id?: unknown }, exec: ToolExec, service: HostService): string | null {
  if (typeof args.project_id === 'string' && args.project_id.trim()) return args.project_id.trim();
  return service.projectForCwd(sessionOf(exec).cwd);
}

function context() {
  return { adapter_id: 'dsh', request_id: randomUUID() };
}

export function createAssistantTools(service: HostService, tasks: TaskStore, ctx: any): ToolDefinition[] {
  return [
    tool({
      name: 'assistant_locate',
      description: '在当前 scope 和项目内定位用户明确保存的记忆，返回最多 5 条路由（不含正文）。需要正文时再调用 assistant_recall。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '精确子串查询；为空时列出最近的少量路由。' },
          project_id: { type: 'string', description: '插件 projectMap 中登记的项目 ID；省略时使用会话工作目录对应的项目。' },
        },
      },
      async execute(args, exec) {
        const api = await service.ready;
        const projectId = projectOf(args, exec, service);
        const routes = await api.locateMemory(typeof args.query === 'string' ? args.query : '', projectId);
        return { routes, coverage: 'complete', source_state: 'available' };
      },
    }),
    tool({
      name: 'assistant_recall',
      description: '读取一条由 assistant_locate 返回、且当前 scope 有权访问的明确记忆正文。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['record_id'],
        properties: {
          record_id: { type: 'string', description: '记忆的 record_id（也可传路由的 route_id）。' },
          project_id: { type: 'string' },
          query: { type: 'string', description: '可选的精确子串校验。' },
        },
      },
      async execute(args, exec) {
        const api = await service.ready;
        const projectId = projectOf(args, exec, service);
        const item = await api.recallMemory(String(args.record_id), projectId, typeof args.query === 'string' ? args.query : '');
        const content = [...item.content].slice(0, service.config.recallBudget).join('');
        return {
          record_id: item.record_id,
          revision: item.revision,
          project_id: item.project_id,
          content,
          content_truncated: content.length < [...item.content].length,
          occurred_at: item.occurred_at,
          attribution: item.attribution,
          source_state: item.source_state,
        };
      },
    }),
    tool({
      name: 'assistant_remember',
      description: '在用户明确要求保存内容时写入一条显式记忆。普通聊天里的“记住”必须先向用户确认；引用内容用 as=quote，外部资料用 as=external。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['content'],
        properties: {
          content: { type: 'string', description: '要保存的正文，最多 4096 个 Unicode 码点。' },
          tags: { type: 'array', items: { type: 'string' }, description: '最多 12 个短标签。' },
          as: { type: 'string', enum: ['user', 'quote', 'external'], description: '内容归属：user=用户明确表述，quote=用户引用，external=外部资料。' },
          project_id: { type: 'string' },
        },
      },
      async execute(args, exec) {
        const api = await service.ready;
        const projectId = projectOf(args, exec, service);
        const result = await api.rememberMemory({ content: String(args.content), tags: Array.isArray(args.tags) ? args.tags.map(String) : [], attribution: attribution(args.as) }, context(), { project_id: projectId, operation_id: randomUUID() });
        await service.refresh();
        return { status: result.status, record_id: result.item.record_id, revision: result.item.revision, op_id: result.op_id };
      },
    }),
    tool({
      name: 'assistant_replace',
      description: '在用户明确要求修改一条已有显式记忆时，按 expected_revision 写入新版本。版本不匹配返回 CONFLICT。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['record_id', 'expected_revision', 'content'],
        properties: {
          record_id: { type: 'string' },
          expected_revision: { type: 'integer', minimum: 1 },
          content: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          as: { type: 'string', enum: ['user', 'quote', 'external'] },
          project_id: { type: 'string' },
        },
      },
      async execute(args, exec) {
        const api = await service.ready;
        const projectId = projectOf(args, exec, service);
        const result = await api.replaceMemory(String(args.record_id), Number(args.expected_revision), { content: String(args.content), tags: Array.isArray(args.tags) ? args.tags.map(String) : [], attribution: attribution(args.as) }, context(), { project_id: projectId, operation_id: randomUUID() });
        await service.refresh();
        return { status: result.status, record_id: result.item.record_id, revision: result.item.revision, op_id: result.op_id };
      },
    }),
    tool({
      name: 'assistant_archive',
      description: '在用户明确要求删除/归档一条显式记忆时，按 expected_revision 归档。软删除，不物理清除。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['record_id', 'expected_revision'],
        properties: {
          record_id: { type: 'string' },
          expected_revision: { type: 'integer', minimum: 1 },
          project_id: { type: 'string' },
        },
      },
      async execute(args, exec) {
        const api = await service.ready;
        const projectId = projectOf(args, exec, service);
        const result = await api.archiveMemory(String(args.record_id), Number(args.expected_revision), context(), { project_id: projectId, operation_id: randomUUID() });
        await service.refresh();
        return { status: result.status, record_id: result.item.record_id, revision: result.item.revision, op_id: result.op_id };
      },
    }),
    tool({
      name: 'assistant_identity_preview',
      description: '预览助手人格/用户画像/协作习惯的修改，返回 before/after。只有用户明确确认后才调用 assistant_identity_commit。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kernel: { type: 'string', description: '完整的新助手人格文本；不改则省略。' },
          user_profile: {
            type: 'object',
            description: '要部分更新的用户画像字段；facts 传入时整组替换。',
            properties: {
              display_name: { type: ['string', 'null'] },
              facts: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] } },
            },
          },
          habits: { type: 'object', properties: { templates: { type: 'array', items: { type: 'string', enum: ['lead-first', 'concise', 'show-evidence', 'ask-when-unclear'] } } } },
        },
      },
      async execute(args) {
        const api = await service.ready;
        const current = await api.readIdentity();
        const patch: Record<string, unknown> = {};
        if (typeof args.kernel === 'string') patch.kernel = args.kernel;
        if (args.user_profile && typeof args.user_profile === 'object') patch.user_profile = args.user_profile;
        if (args.habits && typeof args.habits === 'object') patch.habits = args.habits;
        const preview = await api.previewIdentityUpdate({ operation_id: randomUUID(), expected_revision: current.revision, patch }, context());
        return { proposal_id: preview.proposal_id, expected_revision: preview.expected_revision, before: preview.before, after: preview.after };
      },
    }),
    tool({
      name: 'assistant_identity_commit',
      description: '提交一个已经展示给用户并得到明确确认的画像提案。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['proposal_id', 'expected_revision'],
        properties: {
          proposal_id: { type: 'string' },
          expected_revision: { type: 'integer', minimum: 1 },
        },
      },
      async execute(args) {
        const api = await service.ready;
        const receipt = await api.commitIdentityUpdate(String(args.proposal_id), Number(args.expected_revision), context());
        await service.refresh();
        return { proposal_id: receipt.proposal_id, revision: receipt.revision, identity_hash: receipt.identity_hash };
      },
    }),
    tool({
      name: 'assistant_delegate',
      description: '新开一条独立工作会话（普通对话，不是子代理），把需要实际执行的具体任务（读写文件、运行命令、分析项目）交给它。立即返回 task_id 和 session_id；完成后会收到通知，也可用 assistant_task_status 查询。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['objective'],
        properties: {
          objective: { type: 'string', description: '要工作会话完成的具体任务。' },
          acceptance: { type: 'string', description: '验收标准。' },
          necessary_context: { type: 'string', description: '工作会话必需的背景，不继承主对话历史。' },
          project_id: { type: 'string', description: '插件 projectMap 中登记的项目 ID；省略时使用会话工作目录。' },
        },
      },
      async execute(args, exec) {
        return delegateTask({ objective: String(args.objective), acceptance: typeof args.acceptance === 'string' ? args.acceptance : '', necessaryContext: typeof args.necessary_context === 'string' ? args.necessary_context : '', projectId: projectOf(args, exec, service) }, exec, { ctx, service, tasks });
      },
    }),
    tool({
      name: 'assistant_task_status',
      description: '查询本插件新开的工作会话任务状态与回执。',
      parameters: { type: 'object', additionalProperties: false, required: ['task_id'], properties: { task_id: { type: 'string' } } },
      async execute(args) {
        return taskStatus(String(args.task_id), tasks);
      },
    }),
    tool({
      name: 'assistant_task_cancel',
      description: '取消一个仍在运行的委托任务。已完成的回执不会被删除。',
      parameters: { type: 'object', additionalProperties: false, required: ['task_id'], properties: { task_id: { type: 'string' } } },
      async execute(args, exec) {
        return cancelTask(String(args.task_id), exec, { ctx, tasks });
      },
    }),
  ];
}

export function denialList(ctx: any, configured: string[]): string[] {
  const deny = new Set(configured);
  try {
    const schemas = ctx.tools?.schemas;
    const visible = typeof schemas === 'function' ? schemas.call(ctx.tools, undefined) : schemas;
    if (Array.isArray(visible)) {
      for (const item of visible) {
        const name = typeof item === 'string' ? item : item?.name;
        if (typeof name === 'string' && (name.startsWith('memory_') || name === 'set_scope_state')) deny.add(name);
      }
    }
  } catch {
    // keep the static list
  }
  return [...deny];
}
