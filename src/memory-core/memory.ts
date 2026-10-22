import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AttributionSchema, MemoryItemSchema, RouteEntrySchema, type Attribution, type MemoryItem, type RouteEntry } from '../contracts/schemas.js';
import { AssistantError } from '../contracts/errors.js';
import { writeJson } from '../infrastructure/files.js';
import type { Runtime } from '../infrastructure/runtime.js';

export type ExplicitContext = { actor: 'user'; requestId: string; scopeId: string; projectId: string | null; explicitSave: true };
export type MemoryInput = { content: string; tags?: string[]; occurred_at?: string | null; attribution: Attribution; evidence?: MemoryItem['evidence'] };
export type SaveReceipt = { status: 'saved' | 'saved_index_pending' | 'replayed'; item: MemoryItem; op_id: string };

function currentItems(events: ReturnType<Runtime['content']['all']>): Map<string, MemoryItem> {
  const map = new Map<string, MemoryItem>();
  for (const event of events) {
    const payload = event.payload as { item?: unknown };
    if (payload.item) {
      const parsed = MemoryItemSchema.safeParse(payload.item);
      if (parsed.success) map.set(parsed.data.record_id, parsed.data);
    }
  }
  return map;
}

function routeId(recordId: string): string { return `user-explicit:${recordId}`; }

function routeFor(item: MemoryItem): RouteEntry {
  return RouteEntrySchema.parse({ schema_version: 2, route_id: routeId(item.record_id), source_id: 'user-explicit', scope_id: item.scope_id, project_id: item.project_id, record_id: item.record_id, revision: String(item.revision), occurred_at: item.occurred_at, indexed_at: item.created_at, topic_labels: item.tags, state: item.status, query_mode: 'direct', native_index_ref: null });
}

export class MemoryCore {
  constructor(private readonly runtime: Runtime) {}

  private async indexItem(item: MemoryItem, contentSeq: number): Promise<void> {
    const route = routeFor(item);
    await this.runtime.events.append({ op_id: `index-content-${contentSeq}`, kind: 'index.route', payload: { content_seq: contentSeq, route } });
    const routes = this.runtime.events.all().filter((event) => event.kind === 'index.route').map((event) => (event.payload as { route: unknown }).route).map((value) => RouteEntrySchema.parse(value));
    const map = new Map<string, RouteEntry>();
    for (const candidate of routes) map.set(candidate.record_id, candidate);
    await writeJson(path.join(this.runtime.root, 'index/user-explicit/routes.json'), { schema_version: 2, indexed_content_seq: contentSeq, routes: [...map.values()] });
  }

  async repairIndex(): Promise<void> {
    const indexed = new Set(this.runtime.events.all().filter((event) => event.kind === 'index.route').map((event) => (event.payload as { content_seq?: number }).content_seq));
    for (const event of this.runtime.content.all()) {
      if (indexed.has(event.seq)) continue;
      const payload = event.payload as { item?: unknown };
      const item = MemoryItemSchema.safeParse(payload.item);
      if (item.success) await this.indexItem(item.data, event.seq);
    }
    const items = currentItems(this.runtime.content.all());
    const routes = [...items.values()].map(routeFor);
    await writeJson(path.join(this.runtime.root, 'index/user-explicit/routes.json'), { schema_version: 2, indexed_content_seq: this.runtime.content.all().at(-1)?.seq ?? 0, routes });
  }

  private async commit(input: MemoryItem, opId: string): Promise<SaveReceipt> {
    const saved = await this.runtime.content.append({ op_id: opId, kind: 'memory.record', payload: { item: input } });
    try {
      await this.indexItem(input, saved.event.seq);
      return { status: saved.replayed ? 'replayed' : 'saved', item: input, op_id: opId };
    } catch {
      return { status: 'saved_index_pending', item: input, op_id: opId };
    }
  }

  async remember(raw: MemoryInput, ctx: ExplicitContext, opId: string = randomUUID()): Promise<SaveReceipt> {
    if (!ctx.explicitSave || ctx.actor !== 'user') throw new AssistantError('UNAUTHORIZED');
    if (raw.content.length === 0 || [...raw.content].length > 4096) throw new AssistantError('BUDGET_EXCEEDED', '记忆正文最多 4096 个 Unicode 码点。');
    AttributionSchema.parse(raw.attribution);
    const priorOperation = this.runtime.content.findOp(opId);
    if (priorOperation) {
      const existing = MemoryItemSchema.parse((priorOperation.payload as { item: unknown }).item);
      if (priorOperation.kind !== 'memory.record' || existing.content !== raw.content || JSON.stringify(existing.attribution) !== JSON.stringify(raw.attribution) || existing.scope_id !== ctx.scopeId || existing.project_id !== ctx.projectId) throw new AssistantError('CONFLICT', '同一 op_id 已用于不同记忆内容。');
      return { status: 'replayed', item: existing, op_id: opId };
    }
    const now = new Date().toISOString();
    const recordId = randomUUID();
    const item = MemoryItemSchema.parse({ schema_version: 2, ref: { source_id: 'user-explicit', record_id: recordId, revision: '1', generation: null }, record_id: recordId, revision: 1, status: 'active', source_id: 'user-explicit', scope_id: ctx.scopeId, project_id: ctx.projectId, content: raw.content, occurred_at: raw.occurred_at ?? null, created_at: now, tags: raw.tags ?? [], attribution: raw.attribution, evidence: raw.evidence ?? [{ kind: 'request', ref: ctx.requestId }], source_state: 'available', request_id: ctx.requestId });
    return this.commit(item, opId);
  }

  async replace(recordId: string, expectedRevision: number, raw: MemoryInput, ctx: ExplicitContext, opId: string = randomUUID()): Promise<SaveReceipt> {
    const priorOperation = this.runtime.content.findOp(opId);
    if (priorOperation) {
      const existing = MemoryItemSchema.parse((priorOperation.payload as { item: unknown }).item);
      if (priorOperation.kind !== 'memory.record' || existing.record_id !== recordId || existing.revision !== expectedRevision + 1 || existing.content !== raw.content || existing.scope_id !== ctx.scopeId) throw new AssistantError('CONFLICT', '同一 op_id 已用于不同修订。');
      return { status: 'replayed', item: existing, op_id: opId };
    }
    const prior = currentItems(this.runtime.content.all()).get(recordId);
    if (!prior || prior.status !== 'active') throw new AssistantError('NOT_FOUND');
    if (prior.scope_id !== ctx.scopeId || prior.project_id !== ctx.projectId) throw new AssistantError('OUT_OF_SCOPE');
    if (prior.revision !== expectedRevision) throw new AssistantError('CONFLICT');
    if ([...raw.content].length > 4096) throw new AssistantError('BUDGET_EXCEEDED', '记忆正文最多 4096 个 Unicode 码点。');
    const revision = prior.revision + 1;
    const item = MemoryItemSchema.parse({ ...prior, ref: { ...prior.ref, revision: String(revision) }, revision, content: raw.content, tags: raw.tags ?? prior.tags, occurred_at: raw.occurred_at ?? prior.occurred_at, attribution: raw.attribution, evidence: raw.evidence ?? prior.evidence, created_at: new Date().toISOString(), request_id: ctx.requestId });
    return this.commit(item, opId);
  }

  async archive(recordId: string, expectedRevision: number, ctx: ExplicitContext, opId: string = randomUUID()): Promise<SaveReceipt> {
    const priorOperation = this.runtime.content.findOp(opId);
    if (priorOperation) {
      const existing = MemoryItemSchema.parse((priorOperation.payload as { item: unknown }).item);
      if (priorOperation.kind !== 'memory.record' || existing.record_id !== recordId || existing.revision !== expectedRevision + 1 || existing.status !== 'archived' || existing.scope_id !== ctx.scopeId) throw new AssistantError('CONFLICT', '同一 op_id 已用于不同归档。');
      return { status: 'replayed', item: existing, op_id: opId };
    }
    const prior = currentItems(this.runtime.content.all()).get(recordId);
    if (!prior || prior.status !== 'active') throw new AssistantError('NOT_FOUND');
    if (prior.scope_id !== ctx.scopeId || prior.project_id !== ctx.projectId) throw new AssistantError('OUT_OF_SCOPE');
    if (prior.revision !== expectedRevision) throw new AssistantError('CONFLICT');
    const revision = prior.revision + 1;
    const item = MemoryItemSchema.parse({ ...prior, ref: { ...prior.ref, revision: String(revision) }, revision, status: 'archived', created_at: new Date().toISOString(), request_id: ctx.requestId });
    return this.commit(item, opId);
  }

  async locate(query: string, ctx: Pick<ExplicitContext, 'scopeId' | 'projectId'>, projectId?: string): Promise<RouteEntry[]> {
    await this.repairIndex();
    const items = currentItems(this.runtime.content.all());
    const q = query.toLocaleLowerCase();
    const candidates = [...items.values()].filter((item) => item.status === 'active' && item.scope_id === ctx.scopeId && (projectId ? item.project_id === projectId : item.project_id === ctx.projectId || ctx.projectId === null) && (!q || item.content.toLocaleLowerCase().includes(q) || item.tags.some((tag) => tag.toLocaleLowerCase().includes(q))));
    const byId = new Map(candidates.map((item) => [item.record_id, routeFor(item)]));
    return [...byId.values()].slice(0, 5);
  }

  async recall(routeIdValue: string, query: string, ctx: Pick<ExplicitContext, 'scopeId' | 'projectId'>): Promise<MemoryItem> {
    const id = routeIdValue.startsWith('user-explicit:') ? routeIdValue.slice('user-explicit:'.length) : routeIdValue;
    const item = currentItems(this.runtime.content.all()).get(id);
    if (!item || item.status !== 'active') throw new AssistantError('NOT_FOUND');
    if (item.scope_id !== ctx.scopeId || (item.project_id && ctx.projectId && item.project_id !== ctx.projectId)) throw new AssistantError('OUT_OF_SCOPE');
    if (query && !item.content.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && !item.tags.some((tag) => tag.toLocaleLowerCase().includes(query.toLocaleLowerCase()))) throw new AssistantError('NOT_FOUND', '记录不匹配给定的精确子串查询。');
    return item;
  }

  /** Read-only, newest-first listing used by adapters to render an index summary. */
  async list(limit: number, ctx: Pick<ExplicitContext, 'scopeId' | 'projectId'>): Promise<MemoryItem[]> {
    return [...currentItems(this.runtime.content.all()).values()]
      .filter((item) => item.status === 'active' && item.scope_id === ctx.scopeId && (!ctx.projectId || item.project_id === ctx.projectId))
      .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.record_id.localeCompare(left.record_id))
      .slice(0, limit);
  }

  async directSearch(query: string, ctx: Pick<ExplicitContext, 'scopeId' | 'projectId'>): Promise<MemoryItem[]> {
    const q = query.toLocaleLowerCase();
    return [...currentItems(this.runtime.content.all()).values()].filter((item) => item.status === 'active' && item.scope_id === ctx.scopeId && (!ctx.projectId || item.project_id === ctx.projectId) && (item.content.toLocaleLowerCase().includes(q) || item.tags.some((tag) => tag.toLocaleLowerCase().includes(q)))).slice(0, 5);
  }

  isCurrentReference(recordId: string, revision: number, scopeId: string): boolean {
    const item = currentItems(this.runtime.content.all()).get(recordId);
    return Boolean(item && item.status === 'active' && item.scope_id === scopeId && item.revision === revision);
  }
}
