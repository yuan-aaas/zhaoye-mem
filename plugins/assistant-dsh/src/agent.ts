import { createAssistantTools, denialList } from './tools.js';
import { emptyProfile, type HostService } from './host.js';

export const name = 'assistant-dsh-agent';
export const inject = ['assistant', 'tools', 'systemPrompt'];

/**
 * Global tools this agent must not see. The list is intersected with the tools
 * actually visible to the agent before `tools.restrict` is called: restrict
 * rejects unknown names and only masks global tools (scope-local tools stay).
 */
const GLOBAL_DENY = [
  'memory_save', 'memory_search', 'memory_list', 'memory_get', 'memory_update',
  'memory_delete', 'memory_forget', 'memory_archive', 'memory_register_document',
  'memory_runtime', 'set_scope_state',
  'canvas_add_note',
  'noteboard_add', 'noteboard_create', 'noteboard_history', 'noteboard_layout',
  'noteboard_query', 'noteboard_read_session', 'noteboard_remove', 'noteboard_restore',
  'noteboard_save_as', 'noteboard_sessions', 'noteboard_update',
  'working_directory', 'load_workspace_dependencies',
];

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
    // fall through to the tool probe
  }
  return null;
}

function isAssistantAgent(agent: any): boolean {
  if (!agent?.ctx) return false;
  const preset = composedPresetId(agent);
  if (preset !== null) return preset === 'assistant';
  try {
    return Boolean(agent.ctx.tools?.get?.('assistant_locate', agent.ctx));
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

function restrictAssistantAgent(agent: any, configured: string[]): void {
  if (!agent?.ctx || restrictedAgents.has(agent)) return;
  restrictedAgents.add(agent);
  const tools = agent.ctx.tools;
  if (!tools) return;
  const visible = visibleToolNames(agent.ctx);
  const candidates = [...new Set([...GLOBAL_DENY, ...configured])].filter((name) => visible === null || visible.has(name));
  applyDeny(tools, candidates);
  try {
    const denied = new Set(candidates);
    tools.guard((exec: any) => denied.has(exec?.name) ? '该助手会话不允许使用这个工具；请使用 assistant_* 工具。' : undefined);
  } catch {
    // no guard seam
  }
}

export const apply = (ctx: any): void => {
  const service = ctx.assistant as HostService | undefined;
  if (!service) {
    ctx.logger?.warn?.('[assistant-dsh] 未找到 assistant 服务，跳过助手工具注册。');
    return;
  }
  const tools = createAssistantTools(service, service.tasks, ctx);

  // The invitation is a separate, top-of-prompt section: a passive line buried
  // after the rules was not enough to make the model ask on the first turn.
  try {
    ctx.systemPrompt.section({
      name: 'assistant-profile-invitation',
      order: 5,
      text: (context: any) => {
        const agentId = context?.agent?.id ?? context?.agent?.session?.id ?? 'unknown';
        return service.profileInvitation(agentId, emptyProfile(service.identity));
      },
    });
  } catch (error) {
    ctx.logger?.warn?.(`[assistant-dsh] 画像提示段注册失败：${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    ctx.systemPrompt.section({
      name: 'assistant-identity',
      order: 10,
      text: () => service.identityText || '【助手数据】正在加载，请稍后重试。',
    });
  } catch (error) {
    ctx.logger?.warn?.(`[assistant-dsh] 身份段注册失败：${error instanceof Error ? error.message : String(error)}`);
  }

  // Shadow mneme's per-agent memory context and guide: this session uses the
  // zhaoye-mem index and assistant_* tools, not the global memory_* surface.
  try {
    ctx.systemPrompt.context({ name: 'memory', order: 90, text: () => service.memoryText });
  } catch (error) {
    ctx.logger?.warn?.(`[assistant-dsh] 记忆索引段注册失败：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    ctx.systemPrompt.section({ name: 'memory-guide', order: 150, text: '本会话的记忆由 assistant_* 工具提供；不要调用 memory_* 工具。' });
  } catch (error) {
    ctx.logger?.warn?.(`[assistant-dsh] mneme 指引段覆盖失败：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    ctx.systemPrompt.context({ name: 'user-settings', order: 85, text: '' });
  } catch (error) {
    ctx.logger?.warn?.(`[assistant-dsh] mneme 用户设置段覆盖失败：${error instanceof Error ? error.message : String(error)}`);
  }

  ctx.effect(() => {
    const disposers: Array<() => void> = [];
    for (const definition of tools) {
      try {
        const dispose = ctx.tools.register(definition);
        if (typeof dispose === 'function') disposers.push(dispose);
      } catch (error) {
        ctx.logger?.warn?.(`[assistant-dsh] 工具注册失败 ${definition.name}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
          // best effort
        }
      }
    };
  }, 'assistant-dsh: agent tools');

  const configured = denialList(ctx, service.config.deniedTools);
  // If this preset's own context is already scoped, restrict immediately; the
  // agent/created path below covers hosts that only expose the scoped ctx there.
  try {
    const visible = visibleToolNames(ctx);
    const candidates = [...new Set([...GLOBAL_DENY, ...configured])].filter((name) => visible === null || visible.has(name));
    if (applyDeny(ctx.tools, candidates)) {
      const denied = new Set(candidates);
      ctx.tools.guard((exec: any) => denied.has(exec?.name) ? '该助手会话不允许使用这个工具；请使用 assistant_* 工具。' : undefined);
    }
  } catch {
    // not a scoped context; handled on agent/created
  }
  ctx.on('agent/created', (event: any) => {
    const agent = event?.agent ?? event;
    if (isAssistantAgent(agent)) restrictAssistantAgent(agent, configured);
  });
  // HMR/reload after the agent already exists.
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
    for (const agent of agents?.list?.() ?? []) if (isAssistantAgent(agent)) restrictAssistantAgent(agent, configured);
  } catch {
    // no registry
  }
};
