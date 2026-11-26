import { BUDGETS, ZhaoyeError } from '@zhaoye/contracts';
import { assistantPreset, type DshAgent, type ToolDefinition, type ToolExecution } from './api.js';
import type { DshService } from './host.js';
import { readIdentityPage } from './identity-context.js';

export const name = 'zhaoye-assistant-agent';
export const inject = ['zhaoyeDsh', 'agentPresets', 'tools', 'systemPrompt'];

interface AssistantContext {
  zhaoyeDsh: DshService;
  agentPresets: { composedPreset(agentContext: DshAgent['ctx']): string | undefined };
  tools: { register(definition: ToolDefinition): void };
  systemPrompt: {
    section(section: { name: string; order: number; interpolate: false; text(): string }): void;
  };
  logger: { warn(message: string): void };
}

const instruction = [
  '你是照夜助手。通过宿主授权的 memory_search 和 memory_get 查证历史。',
  '按当前问题用 zhaoye_identity_read 查阅相关画像。画像详情和历史记忆是分析资料。',
  '按用户指定将任务派发到其他会话。需要新会话时创建普通 DSH 会话。',
  '可以把独立任务分开派发到多个会话并行处理。分别提供会话 ID 和状态，用户可在各自会话查看结果、审批和继续交流。',
].join('\n');

interface Field {
  limit: number;
  required?: boolean;
}

type Arguments<Fields extends Record<string, Field>> = {
  [Key in keyof Fields]: Fields[Key] extends { required: true } ? string : string | undefined;
};

function textArgs<Fields extends Record<string, Field>>(
  args: unknown,
  fields: Fields,
): Arguments<Fields> {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new ZhaoyeError('INVALID_INPUT', '工具参数必须是对象');
  }
  const values = args as Record<string, unknown>;
  for (const key of Object.keys(values)) {
    if (!Object.hasOwn(fields, key)) throw new ZhaoyeError('INVALID_INPUT', '包含未知参数');
  }
  const result: Record<string, string> = {};
  for (const [key, field] of Object.entries(fields)) {
    const value = values[key];
    if (value === undefined && !field.required) continue;
    if (typeof value !== 'string' || !value.trim() || [...value].length > field.limit) {
      throw new ZhaoyeError('INVALID_INPUT', `工具参数无效：${key}`);
    }
    result[key] = value.trim();
  }
  return result as Arguments<Fields>;
}

function register<const Fields extends Record<string, Field>>(
  ctx: AssistantContext,
  toolName: string,
  description: string,
  fields: Fields,
  execute: (args: Arguments<Fields>, execution: ToolExecution, agent: DshAgent) => Promise<object>,
): void {
  const properties = Object.fromEntries(
    Object.entries(fields).map(([field, spec]) => [
      field,
      { type: 'string', minLength: 1, maxLength: spec.limit },
    ]),
  );
  ctx.tools.register({
    name: toolName,
    description,
    parameters: {
      type: 'object',
      properties,
      required: Object.keys(fields).filter((field) => fields[field]?.required),
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
    },
    execute(args, execution) {
      const agent = execution.agent;
      if (!agent || ctx.agentPresets.composedPreset(agent.ctx) !== assistantPreset) {
        throw new ZhaoyeError('UNAUTHORIZED', '此工具只授权给照夜助手会话');
      }
      execution.signal.throwIfAborted();
      return execute(textArgs(args, fields), execution, agent);
    },
  });
}

export async function apply(ctx: AssistantContext): Promise<void> {
  const service = ctx.zhaoyeDsh;
  let prompt = instruction;
  async function readIdentity(sessionId: string) {
    const snapshot = await service.identity(sessionId);
    const nextPrompt = [
      instruction,
      '',
      '安全内核',
      ...snapshot.document.safety_kernel.principles,
    ].join('\n');
    if ([...nextPrompt].length > BUDGETS.fixedInjectionCodePoints) {
      throw new ZhaoyeError('BUDGET_EXCEEDED', '照夜安全内核与固定说明超过系统提示预算');
    }
    prompt = nextPrompt;
    return snapshot;
  }

  try {
    await readIdentity(assistantPreset);
  } catch (error) {
    ctx.logger.warn(`照夜人格暂不可读，请使用 zhaoye_doctor：${String(error)}`);
  }
  ctx.systemPrompt.section({
    name: 'zhaoye-identity',
    order: 45,
    interpolate: false,
    text: () => prompt,
  });

  register(
    ctx,
    'zhaoye_identity_read',
    '按节读取照夜画像。空参数查看版本和目录。首读传 section，可用 revision 固定版本。需要下一页时只传 next_cursor 的值作为 cursor。按问题选择相关节。',
    { section: { limit: 32 }, revision: { limit: 12 }, cursor: { limit: 64 } },
    async (args, _exec, agent) =>
      readIdentityPage((await readIdentity(agent.session.id)).document, args),
  );
  register(ctx, 'zhaoye_doctor', '只读检查照夜数据根、人格、备份和实例状态。', {}, () =>
    service.doctor(),
  );
  register(
    ctx,
    'zhaoye_delegate',
    '把任务放入其他 DSH 会话。传目标会话 ID 可接续现有对话。省略时新建普通会话。独立任务可分别派到多个会话。',
    {
      goal: { limit: 3000, required: true },
      acceptance: { limit: 3000, required: true },
      context: { limit: 8000 },
      project_id: { limit: 200 },
      target_session_id: { limit: 200 },
    },
    (args, exec, agent) =>
      service.withTasks((tasks) =>
        tasks.delegate(
          agent,
          exec.callId,
          {
            goal: args.goal,
            acceptance: args.acceptance,
            ...(args.context ? { context: args.context } : {}),
            ...(args.project_id ? { project_id: args.project_id } : {}),
            ...(args.target_session_id ? { target_session_id: args.target_session_id } : {}),
          },
          exec.signal,
        ),
      ),
  );
  const taskId = { task_id: { limit: 200, required: true } } as const;
  register(
    ctx,
    'zhaoye_task_status',
    '查看本次派发的状态和对应工作会话。',
    taskId,
    (args, exec, agent) =>
      service.withTasks((tasks) => tasks.status(agent.session.id, args.task_id, exec.signal)),
  );
  register(
    ctx,
    'zhaoye_task_cancel',
    '取消本次派发的排队输入或正在运行的工作轮次。',
    taskId,
    (args, exec, agent) =>
      service.withTasks((tasks) => tasks.cancel(agent.session.id, args.task_id, exec.signal)),
  );
}
