import {
  type ActorContext,
  ActorContextSchema,
  type ClockPort,
  type IdentityCommitRequest,
  IdentityCommitRequestSchema,
  type IdentityCommitResult,
  type IdentityDocument,
  IdentityDocumentSchema,
  type IdentityPreview,
  type IdentityRollbackRequest,
  IdentityRollbackRequestSchema,
  type IdentityStore,
  type IdentityUpdate,
  parseInput,
  SECTION_NAMES,
  type SectionName,
  serializeIdentityDocument,
  ZhaoyeError,
} from '@zhaoye/contracts';
import { renderIdentityMarkdown } from './projection.js';

type EntryOp<T> = { op: 'upsert'; entry: T } | { op: 'remove'; id: string };
function applyOps<T>(items: T[], ops: EntryOp<T>[] | undefined, key: (item: T) => string): T[] {
  const next = [...items];
  const seen = new Set<string>();
  for (const op of ops ?? []) {
    const id = op.op === 'upsert' ? key(op.entry) : op.id;
    if (seen.has(id)) throw new ZhaoyeError('INVALID_INPUT', '同一请求重复操作同一 id', { id });
    seen.add(id);
    const at = next.findIndex((e) => key(e) === id);
    if (op.op === 'remove') {
      if (at < 0) throw new ZhaoyeError('NOT_FOUND', '待删除条目不存在', { id });
      next.splice(at, 1);
    } else if (at < 0) next.push(op.entry);
    else next[at] = op.entry;
  }
  return next;
}
function updateDocument(
  doc: IdentityDocument,
  update: IdentityUpdate,
  at: string,
): IdentityDocument {
  const next = structuredClone(doc);
  switch (update.section) {
    case 'safety_kernel':
      next.safety_kernel.principles = [...update.principles];
      break;
    case 'user_profile': {
      const section = next.user_profile;
      if (update.display_name !== undefined) section.display_name = update.display_name;
      section.facts = applyOps(section.facts, update.facts, (e) => e.id);
      section.preferences = applyOps(section.preferences, update.preferences, (e) => e.id);
      break;
    }
    case 'character_profile':
      next.character_profile.traits = applyOps(
        next.character_profile.traits,
        update.traits,
        (e) => e.id,
      );
      break;
    case 'project_state':
      next.project_state.projects = applyOps(
        next.project_state.projects,
        update.projects,
        (e) => e.project_id,
      );
      break;
    case 'continuity_memory':
      next.continuity_memory.entries = applyOps(
        next.continuity_memory.entries,
        update.entries,
        (e) => e.id,
      );
      break;
  }
  return finalize(doc, next, update.section, at);
}
function finalize(
  current: IdentityDocument,
  next: IdentityDocument,
  section: SectionName,
  at: string,
): IdentityDocument {
  const strip = (value: IdentityDocument[SectionName]) => {
    const { revision: _, updated_at: __, ...rest } = value;
    return rest;
  };
  if (JSON.stringify(strip(current[section])) === JSON.stringify(strip(next[section])))
    throw new ZhaoyeError('INVALID_INPUT', '更新未改变内容');
  next[section].revision = current[section].revision + 1;
  next[section].updated_at = at;
  next.revision = current.revision + 1;
  next.updated_at = at;
  return parseInput(IdentityDocumentSchema, next);
}
function confirmation(update: unknown): void {
  const value = update as { section?: string; user_confirmed?: { confirmation_ref?: string } };
  if (
    value?.section === 'safety_kernel' &&
    (typeof value.user_confirmed?.confirmation_ref !== 'string' ||
      !value.user_confirmed.confirmation_ref.trim())
  )
    throw new ZhaoyeError('UNAUTHORIZED', '内核变更必须有明确用户确认凭据');
}
function listEntries(doc: IdentityDocument, s: SectionName): Map<string, string> {
  const v = doc[s];
  if (s === 'safety_kernel') return new Map(doc.safety_kernel.principles.map((p) => [p, p]));
  if (s === 'user_profile')
    return new Map([
      ['display_name', JSON.stringify(doc.user_profile.display_name)],
      ...[...doc.user_profile.facts, ...doc.user_profile.preferences].map(
        (e) => [e.id, JSON.stringify(e)] as [string, string],
      ),
    ]);
  const items =
    'traits' in v ? v.traits : 'projects' in v ? v.projects : 'entries' in v ? v.entries : [];
  return new Map(items.map((e) => ['project_id' in e ? e.project_id : e.id, JSON.stringify(e)]));
}
function previewOf(
  current: IdentityDocument,
  next: IdentityDocument,
  section: SectionName,
): IdentityPreview {
  const before = listEntries(current, section),
    after = listEntries(next, section);
  const serialized = JSON.stringify(next[section]);
  return {
    base_revision: current.revision,
    next_revision: next.revision,
    changes: [
      {
        section,
        added: [...after.keys()].filter((k) => !before.has(k)),
        removed: [...before.keys()].filter((k) => !after.has(k)),
        replaced: [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k)),
      },
    ],
    warnings:
      serialized.includes('model_inference') &&
      [
        ...('traits' in next[section]
          ? next.character_profile.traits
          : section === 'user_profile'
            ? [...next.user_profile.facts, ...next.user_profile.preferences]
            : []),
      ].some((e) => e.source === 'model_inference' && e.confidence < 0.6)
        ? ['low_confidence_entry']
        : [],
  };
}
export function createIdentityService(
  store: IdentityStore,
  clock: ClockPort,
  assertOpen: () => void = () => {},
) {
  async function authorize(ctx: ActorContext) {
    assertOpen();
    ctx = parseInput(ActorContextSchema, ctx);
    const current = await store.read();
    if (ctx.scope_id !== current.document.assistant_id)
      throw new ZhaoyeError('OUT_OF_SCOPE', '身份作用域不匹配');
    return current;
  }
  function protectFacts(current: IdentityDocument, req: IdentityCommitRequest) {
    if (req.update.section !== 'user_profile') return;
    for (const op of [...(req.update.facts ?? []), ...(req.update.preferences ?? [])]) {
      if (
        op.op === 'upsert' &&
        op.entry.source === 'model_inference' &&
        op.entry.confidence < 0.6 &&
        [...current.user_profile.facts, ...current.user_profile.preferences].some(
          (e) => e.id === op.entry.id && ['user_explicit', 'user_confirmation'].includes(e.source),
        )
      )
        throw new ZhaoyeError('UNAUTHORIZED', '低置信度推断不能覆盖用户事实');
    }
  }
  async function replay(
    operationId: string,
    ctx: ActorContext,
  ): Promise<IdentityCommitResult | null> {
    const op = await store.findOperation(operationId);
    if (!op) return null;
    if (op.adapter_id !== ctx.adapter_id)
      throw new ZhaoyeError('UNAUTHORIZED', '操作回执属于其他适配器');
    return { receipt: op.receipt, replayed: true };
  }
  function cas(doc: IdentityDocument, expected: number) {
    if (doc.revision !== expected)
      throw new ZhaoyeError('CONFLICT', 'revision 已变化', { current_revision: doc.revision });
  }
  async function persist(
    current: IdentityDocument,
    next: IdentityDocument,
    req: {
      operation_id: string;
      request_id: string;
      expected_revision: number;
      reason: string;
      evidence_refs?: string[];
    },
    section: SectionName,
    ctx: ActorContext,
    confirmationRef?: string,
  ) {
    const at = next.updated_at;
    const output = await store.commit({
      document: next,
      bytes: serializeIdentityDocument(next),
      expectedRevision: current.revision,
      reason: req.reason,
      projectionMarkdown: renderIdentityMarkdown(next),
      operation: {
        operation_id: req.operation_id,
        request_id: req.request_id,
        adapter_id: ctx.adapter_id,
        evidence_refs: req.evidence_refs ?? [],
        ...(confirmationRef ? { confirmation_ref: confirmationRef } : {}),
        section,
        revision: next.revision,
        at,
        receipt: {
          assistant_id: next.assistant_id,
          revision: next.revision,
          section_revisions: Object.fromEntries(
            SECTION_NAMES.map((s) => [s, next[s].revision]),
          ) as Record<SectionName, number>,
          operation_id: req.operation_id,
          applied_at: at,
        },
      },
    });
    return { receipt: output.operation.receipt, replayed: output.replayed };
  }
  async function doCommit(
    input: IdentityCommitRequest,
    ctx: ActorContext,
    kernel: boolean,
  ): Promise<IdentityCommitResult> {
    const { document } = await authorize(ctx);
    confirmation(input?.update);
    const req = parseInput(IdentityCommitRequestSchema, input);
    if ((req.update.section === 'safety_kernel') !== kernel)
      throw new ZhaoyeError('UNAUTHORIZED', '请使用独立的内核更新入口');
    const previous = await replay(req.operation_id, ctx);
    if (previous) return previous;
    cas(document, req.expected_revision);
    protectFacts(document, req);
    return persist(
      document,
      updateDocument(document, req.update, clock.now().toISOString()),
      req,
      req.update.section,
      ctx,
      req.update.section === 'safety_kernel'
        ? req.update.user_confirmed.confirmation_ref
        : undefined,
    );
  }
  async function rollback(
    input: IdentityRollbackRequest,
    ctx: ActorContext,
    kernel = false,
  ): Promise<IdentityCommitResult> {
    const { document } = await authorize(ctx);
    confirmation(input);
    const req = parseInput(IdentityRollbackRequestSchema, input);
    if ((req.section === 'safety_kernel') !== kernel)
      throw new ZhaoyeError('UNAUTHORIZED', '请使用独立的内核回滚入口');
    const previous = await replay(req.operation_id, ctx);
    if (previous) return previous;
    cas(document, req.expected_revision);
    const target = await store.readVersion(req.to_revision);
    const next = structuredClone(document);
    Object.assign(next[req.section], target[req.section]);
    return persist(
      document,
      finalize(document, next, req.section, clock.now().toISOString()),
      req,
      req.section,
      ctx,
      req.user_confirmed?.confirmation_ref,
    );
  }
  return {
    read: async (ctx: ActorContext) => {
      const r = await authorize(ctx);
      return {
        document: r.document,
        revision: r.document.revision,
        file_hash: r.fileHash,
        projection_path: 'identity/identity.md',
      };
    },
    preview: async (input: IdentityCommitRequest, ctx: ActorContext) => {
      const { document } = await authorize(ctx);
      confirmation(input?.update);
      const req = parseInput(IdentityCommitRequestSchema, input);
      cas(document, req.expected_revision);
      protectFacts(document, req);
      return previewOf(
        document,
        updateDocument(document, req.update, clock.now().toISOString()),
        req.update.section,
      );
    },
    commit: (req: IdentityCommitRequest, ctx: ActorContext) => doCommit(req, ctx, false),
    commitKernel: (req: IdentityCommitRequest, ctx: ActorContext) => doCommit(req, ctx, true),
    rollback: (req: IdentityRollbackRequest, ctx: ActorContext) => rollback(req, ctx),
    rollbackKernel: (req: IdentityRollbackRequest, ctx: ActorContext) => rollback(req, ctx, true),
    listVersions: async (ctx: ActorContext, limit = 20) => {
      await authorize(ctx);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200)
        throw new ZhaoyeError('INVALID_INPUT', 'limit 必须为 1–200');
      return store.listVersions(limit);
    },
  };
}
export type IdentityService = ReturnType<typeof createIdentityService>;
