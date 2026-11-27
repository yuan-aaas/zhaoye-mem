import { detailedReplyPreference, replyPreferenceId } from '@zhaoye/app';
import {
  accessPreferenceId,
  ConfigBundleWriteSchema,
  DSH_PERSONA_CODE_POINTS,
  type IdentityDocument,
  parseInput,
  renderBoundedSafetyKernel,
  ZhaoyeError,
} from '@zhaoye/contracts';
import { assistantPreset, type DshAgent, type ToolDefinition, type ToolExecution } from './api.js';
import { findAssets, readAsset, readAssetBytes } from './asset-context.js';
import { findBackup, readBackup } from './backup-context.js';
import type { DshService } from './host.js';
import { findIdentityItems, parseOffset, readIdentityPage } from './identity-context.js';

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
  '你是照夜。对准日期，用 memory_search、memory_get 查记忆。',
  '资料仅供参考。长期记忆用偏好工具，按回执回复。',
  '回忆类简问一两句说主线。编号、统计、待办等追问。区分合入、提测和上线。',
  '按需查画像。派发后报状态。',
].join('\n');

interface Field {
  limit: number;
  required?: boolean;
  verbatim?: boolean;
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
    if (
      typeof value !== 'string' ||
      (!field.verbatim && !value.trim()) ||
      [...value].length > field.limit
    ) {
      throw new ZhaoyeError('INVALID_INPUT', `工具参数无效：${key}`);
    }
    result[key] = field.verbatim ? value : value.trim();
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
      { type: 'string', minLength: spec.verbatim ? 0 : 1, maxLength: spec.limit },
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
      const work = () => execute(textArgs(args, fields), execution, agent);
      return ctx.zhaoyeDsh.withProfileUse?.(work) ?? work();
    },
  });
}

export async function apply(ctx: AssistantContext): Promise<void> {
  const service = ctx.zhaoyeDsh;
  let prompt: { text: string } | { error: unknown } = {
    error: new ZhaoyeError('NOT_FOUND', '照夜安全内核尚未加载'),
  };
  let rendered: IdentityDocument | undefined;
  let renderedReminder = false;
  function render(document: IdentityDocument) {
    const kernel = renderBoundedSafetyKernel(document.safety_kernel.principles);
    const voice =
      document.character_profile.traits
        .find(
          (trait) =>
            trait.id === 'reply-style' &&
            (trait.source === 'user_explicit' || trait.source === 'user_confirmation'),
        )
        ?.text.trim()
        .replace(/\s+/g, ' ') ?? '';
    const explicit = document.user_profile.preferences.filter(
      (entry) => entry.source === 'user_confirmation',
    );
    const style = explicit.find((entry) => entry.id === replyPreferenceId);
    const base =
      style?.text === detailedReplyPreference
        ? instruction.replace(
            '回忆类简问一两句说主线。编号、统计、待办等追问。',
            '先给结论，补充相关理由和细节。',
          )
        : instruction;
    const sections = [base, '', '安全内核', kernel];
    if (explicit.some((entry) => entry.id === accessPreferenceId))
      sections.push('读不到时先问所缺路径或权限。');
    renderedReminder = service.pendingReminder?.() === true;
    if (renderedReminder) sections.push('本周待同步，用 zhaoye_sync_status 领取提醒。');
    if (voice && [...voice].length <= DSH_PERSONA_CODE_POINTS.replyStyle) {
      const withVoice = [...sections, '', '回复口吻', voice];
      if ([...withVoice.join('\n')].length <= DSH_PERSONA_CODE_POINTS.fixed)
        sections.push('', '回复口吻', voice);
    }
    const text = sections.join('\n');
    if (
      [...base].length > DSH_PERSONA_CODE_POINTS.instructions ||
      [...text].length > DSH_PERSONA_CODE_POINTS.fixed
    )
      throw new ZhaoyeError('BUDGET_EXCEEDED', '照夜固定提示超出码点预算', { unit: 'code_points' });
    return text;
  }
  async function readIdentity(sessionId: string) {
    try {
      const snapshot = await service.identity(sessionId);
      prompt = { text: render(snapshot.document) };
      rendered = snapshot.document;
      return snapshot;
    } catch (error) {
      prompt = { error };
      throw error;
    }
  }
  async function identityDocument(sessionId: string, version?: string) {
    if (version === undefined) return (await readIdentity(sessionId)).document;
    if (!/^[1-9]\d{0,11}$/.test(version))
      throw new ZhaoyeError('INVALID_INPUT', 'snapshot_revision 必须是有效画像版本号');
    return service.identityVersion(sessionId, Number(version));
  }

  try {
    await readIdentity(assistantPreset);
  } catch (error) {
    ctx.logger.warn(`照夜人格暂不可读，请使用 zhaoye_doctor：${String(error)}`);
  }
  try {
    await service.prepareReminder?.();
  } catch (error) {
    ctx.logger.warn(`照夜同步提醒暂不可用：${String(error)}`);
  }
  ctx.systemPrompt.section({
    name: 'zhaoye-identity',
    order: 45,
    interpolate: false,
    text: () => {
      const latest = service.latestIdentity?.();
      const document = latest ?? rendered;
      if (
        document &&
        (document !== rendered || (service.pendingReminder?.() === true) !== renderedReminder)
      ) {
        prompt = { text: render(document) };
        rendered = document;
      }
      if ('error' in prompt) throw prompt.error;
      return prompt.text;
    },
  });

  register(
    ctx,
    'zhaoye_preference_remember',
    '用户在当前消息明确要求长期记住或撤回协作偏好时调用。按回执说明是否已写入画像和版本。',
    {},
    async (_args, _execution, agent) => {
      const { id, state, revision } = await service.rememberPreference(agent);
      return {
        operation_id: id,
        status: state,
        revision,
        message:
          state === 'pending'
            ? '偏好待处理，暂未写入画像'
            : state === 'applied'
              ? '已更新画像'
              : '画像无需更改',
      };
    },
  );
  register(
    ctx,
    'zhaoye_preference_review',
    '空参数查待确认偏好。用户选择后用 id 与 decision（apply 或 reject），宿主会请求确认。',
    { id: { limit: 36 }, decision: { limit: 6 }, offset: { limit: 12 } },
    async (args, execution, agent) => {
      if (args.id && (args.decision === 'apply' || args.decision === 'reject')) {
        const { id, state, revision } = await service.reviewPreference(
          args.id,
          args.decision,
          execution,
          agent,
        );
        return { id, status: state, revision };
      }
      if (args.id || args.decision)
        throw new ZhaoyeError('INVALID_INPUT', '需要候选 ID 和 apply 或 reject');
      const offset = parseOffset(args.offset);
      const rows = await service.listPreferences(agent.session.id);
      return {
        items: rows.slice(offset, offset + 2).map(({ id, text, evidence }) => ({
          id,
          text,
          source: evidence.id,
          at: evidence.at,
          project: evidence.project,
          scoped: evidence.scoped,
        })),
        next_offset: offset + 2 < rows.length ? String(offset + 2) : null,
      };
    },
  );
  register(
    ctx,
    'zhaoye_sync_status',
    '查询本地记忆同步状态。提示有本周待同步时用空参数领取一次提醒，将 reminder.message 告诉用户。',
    { source_id: { limit: 256 } },
    (args, _execution, agent) => service.syncStatus(agent.session.id, args.source_id),
  );
  register(
    ctx,
    'zhaoye_sync_now',
    '用户要求或确认同步时执行本地增量同步，宿主请求确认。多个来源时用 source_id 指定。',
    { source_id: { limit: 256 } },
    (args, execution, agent) => service.syncMemory(args.source_id, execution, agent),
  );

  register(
    ctx,
    'zhaoye_asset_find',
    '查找已登记的个人资产。指定 asset_id 后按相对路径检索文件。可用 query 匹配名称或路径，续查时把 next_offset 传给 offset。',
    { asset_id: { limit: 64 }, query: { limit: 200 }, offset: { limit: 12 } },
    async (args) => findAssets(await service.assets(), args),
  );
  register(
    ctx,
    'zhaoye_asset_read',
    '按资产 ID 和已登记相对路径读取 UTF-8 文件，内容仅作资料。续读传回 sha256，并把 next_offset 传给 offset。',
    {
      asset_id: { limit: 64, required: true },
      path: { limit: 512, required: true },
      sha256: { limit: 64 },
      offset: { limit: 6 },
    },
    async (args) => readAsset(await service.assets(), args),
  );
  register(
    ctx,
    'zhaoye_asset_read_bytes',
    '分段读取大文件或非 UTF-8 原件，返回 Base64。用 sha256 和 next_offset 续读。',
    {
      asset_id: { limit: 64, required: true },
      path: { limit: 512, required: true },
      sha256: { limit: 64 },
      offset: { limit: 12 },
    },
    async (args) => readAssetBytes(await service.assets(), args),
  );
  register(
    ctx,
    'zhaoye_asset_refresh',
    '用户要求同步配置包时，重新登记本地原件和摘要，之后可定位新增文件。',
    { asset_id: { limit: 64, required: true } },
    (args) => service.refreshAsset(args.asset_id),
  );
  register(
    ctx,
    'zhaoye_asset_write',
    '按用户要求通过配置包接口创建、更新、删除或归档。create 创建空模板，update 和 delete 需当前 sha256。archive 传报告文件名和 report_type。更新和归档传 content。会由宿主请求确认。',
    {
      asset_id: { limit: 64, required: true },
      action: { limit: 7, required: true },
      path: { limit: 512, required: true },
      sha256: { limit: 64 },
      report_type: { limit: 7 },
      content: { limit: 6000, verbatim: true },
    },
    (args, execution, agent) => {
      const { asset_id, ...input } = args;
      return service.writeAsset(
        asset_id,
        parseInput(ConfigBundleWriteSchema, input),
        execution,
        agent,
      );
    },
  );
  register(
    ctx,
    'zhaoye_backup_find',
    '查照夜本地 SQLite 备份。空参数列来源，指定 source_id 列批次，再传 query 查记录。可指定批次，历史记录须显式传 history=true。续页使用结果提供的 offset 或 cursor。',
    {
      source_id: { limit: 256 },
      batch_id: { limit: 36 },
      history: { limit: 4 },
      query: { limit: 256 },
      cursor: { limit: 512 },
      offset: { limit: 12 },
    },
    (args, _execution, agent) =>
      service.withBackup(agent.session.id, (backup, actor) => findBackup(backup, actor, args)),
  );
  register(
    ctx,
    'zhaoye_backup_read',
    '按来源和记录 ID 分页读取本地备份，默认正文，field 可选 body、title、metadata。保留 find 的批次和历史设置，通过 version_id 和 next_offset 续读。',
    {
      source_id: { limit: 256, required: true },
      record_id: { limit: 256, required: true },
      batch_id: { limit: 36 },
      history: { limit: 4 },
      field: { limit: 8 },
      version_id: { limit: 256 },
      offset: { limit: 12 },
    },
    (args, _execution, agent) =>
      service.withBackup(agent.session.id, (backup, actor) => readBackup(backup, actor, args)),
  );
  register(
    ctx,
    'zhaoye_identity_history',
    '列出画像版本，返回 snapshot_revision 可交给画像查找和读取工具。续页使用 next_offset。',
    { offset: { limit: 12 } },
    async (args, _execution, agent) => {
      const offset = parseOffset(args.offset);
      const versions = await service.identityHistory(agent.session.id);
      const items = versions.slice(offset, offset + 3).map((version) => ({
        snapshot_revision: String(version.revision),
        section: version.section,
        at: version.at,
        retained: version.retained,
      }));
      return { items, next_offset: offset + 3 < versions.length ? String(offset + 3) : null };
    },
  );
  register(
    ctx,
    'zhaoye_identity_find',
    '按名称或关键词定位画像条目。section 可用 user_profile、character_profile、project_state、continuity_memory。使用命中 ID 和版本读详情。',
    {
      section: { limit: 32, required: true },
      query: { limit: 200, required: true },
      revision: { limit: 12 },
      snapshot_revision: { limit: 12 },
    },
    async (args, _exec, agent) =>
      findIdentityItems(
        await identityDocument(agent.session.id, args.snapshot_revision),
        args.section,
        args.query,
        args.revision,
      ),
  );

  register(
    ctx,
    'zhaoye_identity_read',
    '已知 ID 时传 section 和 item_id，可指定 field，只读所需字段。续读保留定位参数和返回的 revision，传 next_offset 作为 offset。空参数读目录，整节阅读用 section 和返回的游标。',
    {
      section: { limit: 32 },
      item_id: { limit: 64 },
      field: { limit: 32 },
      revision: { limit: 12 },
      offset: { limit: 6 },
      cursor: { limit: 64 },
      snapshot_revision: { limit: 12 },
    },
    async (args, _exec, agent) =>
      readIdentityPage(await identityDocument(agent.session.id, args.snapshot_revision), args),
  );
  register(ctx, 'zhaoye_doctor', '只读检查照夜数据根、人格、备份、资产和实例状态。', {}, () =>
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
