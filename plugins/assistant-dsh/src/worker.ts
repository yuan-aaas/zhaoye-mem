export const name = 'assistant-dsh-worker';
export const inject = ['tools', 'systemPrompt'];

/** Global tools masked from the worker scope: memory/admin/recursion only. */
const GLOBAL_DENY = [
  'memory_save', 'memory_search', 'memory_list', 'memory_get', 'memory_update',
  'memory_delete', 'memory_forget', 'memory_archive', 'memory_register_document',
  'memory_runtime', 'set_scope_state',
  'subagent', 'subagent_fork', 'send_message', 'list_agents',
  'canvas_add_note',
  'noteboard_add', 'noteboard_create', 'noteboard_history', 'noteboard_layout',
  'noteboard_query', 'noteboard_read_session', 'noteboard_remove', 'noteboard_restore',
  'noteboard_save_as', 'noteboard_sessions', 'noteboard_update',
];

/** Guard fallback for the same deny list; fs/shell tools are allowed. */
const GUARD_DENY = new Set(GLOBAL_DENY);

function visibleToolNames(ctx: any): Set<string> | null {
  try {
    const schemas = ctx.tools?.schemas;
    const value = typeof schemas === 'function' ? schemas.call(ctx.tools) : schemas;
    if (!Array.isArray(value)) return null;
    const names = new Set<string>();
    for (const item of value) {
      const toolName = typeof item === 'string' ? item : item?.name;
      if (typeof toolName === 'string') names.add(toolName);
    }
    return names;
  } catch {
    return null;
  }
}

function composedPresetId(agent: any): string | null {
  try {
    const presets = agent?.ctx?.get?.('agentPresets');
    const composed = presets?.composedPreset?.(agent.ctx);
    if (typeof composed === 'string') return composed;
    if (composed && typeof composed.id === 'string') return composed.id;
  } catch {
    // fall back to the tool probe
  }
  return null;
}

function isWorkerAgent(agent: any): boolean {
  if (!agent?.ctx) return false;
  const preset = composedPresetId(agent);
  if (preset !== null) return preset === 'assistant-worker';
  try {
    return Boolean(agent.ctx.tools?.get?.('read', agent.ctx)) && !agent.ctx.tools?.get?.('assistant_locate', agent.ctx);
  } catch {
    return false;
  }
}

function applyDeny(tools: any, names: string[]): boolean {
  if (names.length === 0) return false;
  try {
    tools.restrict({ deny: names });
    return true;
  } catch {
    // one unknown name rejects the whole set; apply the rest one by one
  }
  let applied = false;
  for (const name of names) {
    try {
      tools.restrict({ deny: [name] });
      applied = true;
    } catch {
      // not a global tool in this scope
    }
  }
  return applied;
}

const restrictedAgents = new WeakSet<object>();

function restrictWorkerAgent(agent: any): void {
  if (!agent?.ctx || restrictedAgents.has(agent)) return;
  restrictedAgents.add(agent);
  const tools = agent.ctx.tools;
  if (!tools) return;
  const visible = visibleToolNames(agent.ctx);
  const candidates = GLOBAL_DENY.filter((name) => visible === null || visible.has(name));
  applyDeny(tools, candidates);
  try {
    tools.guard((exec: any) => GUARD_DENY.has(exec?.name) ? '工作轨不允许使用记忆/便签/画布工具或继续委托。' : undefined);
  } catch {
    // no guard seam
  }
}

export const apply = (ctx: any): void => {
  try {
    ctx.systemPrompt.section({
      name: 'assistant-worker-contract',
      order: 20,
      text: `你是助手新开的独立工作会话（不是子代理）。可以读写当前工作目录内的文件、运行命令、搜索资料；不能使用记忆工具、便签/画布，不能继续委托，不继承主对话人格。需要审批的操作在本会话里向用户请求，等待批准，不要绕过。
完成后最后一条消息必须是一个 JSON 对象：{"summary":"≤600 字结论","evidence_refs":[{"path":"相对路径","start_line":1,"end_line":10,"quote":"原文片段"}],"artifact_refs":["相对路径"],"pending_questions":[]}。
evidence_refs 引用实际读到的依据（最多 5 条）；artifact_refs 列出本次创建/修改的文件（最多 10 条）。path 只能是相对路径，行号与 quote 必须真实对应。没有依据时不要编造。`,
    });
  } catch (error) {
    ctx.logger?.warn?.(`[assistant-dsh] Worker 契约段注册失败：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    ctx.systemPrompt.section({ name: 'memory-guide', order: 150, text: '工作轨不使用记忆工具。' });
    ctx.systemPrompt.context({ name: 'memory', order: 90, text: '' });
    ctx.systemPrompt.context({ name: 'user-settings', order: 85, text: '' });
  } catch {
    // shadowing is best effort
  }

  // Immediate path when the preset's own context is already scoped.
  try {
    const visible = visibleToolNames(ctx);
    const candidates = GLOBAL_DENY.filter((name) => visible === null || visible.has(name));
    if (applyDeny(ctx.tools, candidates)) {
      ctx.tools.guard((exec: any) => GUARD_DENY.has(exec?.name) ? '工作轨不允许使用记忆/便签/画布工具或继续委托。' : undefined);
    }
  } catch {
    // not a scoped context; handled on agent/created
  }

  ctx.on('agent/created', (event: any) => {
    const agent = event?.agent ?? event;
    if (isWorkerAgent(agent)) restrictWorkerAgent(agent);
  });
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
    for (const agent of agents?.list?.() ?? []) if (isWorkerAgent(agent)) restrictWorkerAgent(agent);
  } catch {
    // no registry
  }
};
