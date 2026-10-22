import { appendFile, stat } from 'node:fs/promises';
import { AssistantError } from '../contracts/errors.js';
import { ModelReplySchema, type ModelReply } from '../contracts/schemas.js';

export type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>; tool_call_id?: string; name?: string };
export type ToolDefinition = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type ModelRequest = { messages: ChatMessage[]; tools?: ToolDefinition[]; max_tokens?: number; request_id?: string; usage_role?: 'lead' | 'worker' };

export interface ModelPort { complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelReply> }

export class ChatCompletionsModel implements ModelPort {
  usageObservationMissing = false;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly usageByRequest = new Map<string, number>();

  constructor(private readonly usageFile: string) {
    this.baseUrl = process.env.MODEL_BASE_URL?.trim() ?? '';
    this.model = process.env.MODEL_NAME?.trim() ?? '';
    this.apiKey = process.env.MODEL_API_KEY?.trim() ?? '';
    this.timeoutMs = Math.min(60_000, Math.max(1000, Number(process.env.MODEL_TIMEOUT_MS ?? 60_000)));
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelReply> {
    if (!this.baseUrl || !this.model || !this.apiKey) throw new AssistantError('MODEL_NOT_CONFIGURED');
    const requestBudget = Number(process.env.MODEL_REQUEST_TOKEN_BUDGET ?? 8000);
    const requestId = request.request_id ?? 'unknown';
    const priorUsage = this.usageByRequest.get(requestId) ?? 0;
    if (priorUsage >= requestBudget) throw new AssistantError('BUDGET_EXCEEDED', '当前请求已达到配置的 token 使用预算。');
    const url = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST', signal: combined,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, messages: request.messages, tools: request.tools, max_tokens: Math.min(request.max_tokens ?? 800, 800), stream: false }),
      });
    } catch { throw new AssistantError(combined.aborted ? 'TIMEOUT' : 'MODEL_ERROR', combined.aborted ? undefined : '无法连接模型服务。'); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new AssistantError('MODEL_ERROR', `模型服务返回 HTTP ${response.status}。`);
    }
    let raw: unknown;
    try { raw = await response.json(); } catch { throw new AssistantError('MODEL_ERROR', '模型服务返回无效 JSON。'); }
    const envelope = raw as { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
    const choice = envelope.choices?.[0];
    if (!choice?.message) throw new AssistantError('MODEL_ERROR', '模型服务未返回消息。');
    const toolCalls = Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls.map((call) => {
      const item = call as { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } };
      return { id: item.id, type: item.type, function: { name: item.function?.name, arguments: item.function?.arguments } };
    }) : [];
    const parsed = ModelReplySchema.safeParse({
      content: typeof choice.message.content === 'string' ? choice.message.content : null,
      tool_calls: toolCalls,
      finish_reason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
      usage: envelope.usage,
    });
    if (!parsed.success) throw new AssistantError('MODEL_ERROR', '模型返回格式未通过 schema 校验。');
    if (parsed.data.tool_calls.length > 1) throw new AssistantError('MODEL_ERROR', '本地最小版拒绝一条回复包含多个工具调用的响应。');
    const tokens = parsed.data.usage?.total_tokens;
    if (tokens !== undefined) {
      const next = priorUsage + tokens;
      if (next > requestBudget) throw new AssistantError('BUDGET_EXCEEDED', '该模型响应超过配置的请求 token 预算。');
      this.usageByRequest.set(requestId, next);
      while (this.usageByRequest.size > 1024) this.usageByRequest.delete(this.usageByRequest.keys().next().value!);
    }
    if (tokens !== undefined) {
      const size = await stat(this.usageFile).then((s) => s.size).catch(() => 0);
      if (size < 16 * 1024 * 1024) {
        try { await appendFile(this.usageFile, `${JSON.stringify({ at: new Date().toISOString(), request_id: requestId, model: this.model, role: request.usage_role ?? 'unknown', prompt_tokens: parsed.data.usage?.prompt_tokens ?? null, completion_tokens: parsed.data.usage?.completion_tokens ?? null, total_tokens: tokens })}\n`, { encoding: 'utf8', mode: 0o600 }); }
        catch { this.usageObservationMissing = true; }
      } else this.usageObservationMissing = true;
    }
    return parsed.data;
  }
}
