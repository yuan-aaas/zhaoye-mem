import { z } from 'zod';

export const IdSchema = z.string().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
export const Rfc3339Schema = z.string().datetime({ offset: true });
export const AttributionSchema = z.object({
  origin: z.enum(['user_direct', 'user_quote', 'external', 'worker_report', 'assistant_inference', 'unknown']),
  attributed_to: z.enum(['user', 'assistant', 'external_author', 'unknown']),
  user_stance: z.enum(['not_stated', 'adopted', 'rejected', 'uncertain']),
  derivation: z.enum(['verbatim', 'extracted', 'summarized', 'distilled', 'unknown']),
}).strict();

export const EvidenceSchema = z.object({
  kind: z.enum(['request', 'worker_file']),
  ref: z.string().min(1).max(500),
  excerpt: z.string().max(1000).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
}).strict();

export const MemoryRefSchema = z.object({ source_id: IdSchema, record_id: IdSchema, revision: z.string().min(1).max(120).nullable(), generation: z.string().min(1).max(120).nullable() }).strict();
export const ProviderMemoryItemSchema = z.object({
  schema_version: z.literal(2), ref: MemoryRefSchema, scope_id: IdSchema, project_id: IdSchema.nullable(),
  status: z.enum(['active', 'archived']), content: z.string().max(4096), occurred_at: Rfc3339Schema.nullable(),
  created_at: Rfc3339Schema, attribution: AttributionSchema, evidence: z.array(EvidenceSchema).max(5),
  source_state: z.enum(['available', 'unavailable', 'stale', 'suppressed']),
}).strict();
export const IndexProposalSchema = z.object({
  source_id: IdSchema, batch_id: IdSchema, source_format_version: z.string().max(80),
  source_cursor_before: z.string().max(500).nullable(), source_cursor_after: z.string().max(500).nullable(),
  source_item_refs: z.array(MemoryRefSchema).max(1000), topic_labels: z.array(z.string().max(40)).max(12),
  coverage: z.enum(['complete', 'partial', 'unknown']),
}).strict();
export const IdentityProposalSchema = z.object({
  proposal_id: IdSchema, expected_identity_revision: z.number().int().positive(), target_fields: z.array(z.string().min(1).max(120)).max(30),
  before: z.unknown(), after: z.unknown(), evidence_refs: z.array(EvidenceSchema).max(20), reason: z.string().max(1000),
}).strict();

export const MemoryItemSchema = z.object({
  schema_version: z.literal(2),
  ref: z.object({ source_id: z.literal('user-explicit'), record_id: IdSchema, revision: z.string().regex(/^[1-9][0-9]*$/), generation: z.null() }).strict(),
  record_id: IdSchema,
  revision: z.number().int().positive(),
  status: z.enum(['active', 'archived']),
  source_id: z.literal('user-explicit'),
  scope_id: IdSchema,
  project_id: IdSchema.nullable(),
  content: z.string().min(1).max(4096),
  occurred_at: Rfc3339Schema.nullable(),
  created_at: Rfc3339Schema,
  tags: z.array(z.string().min(1).max(40)).max(12),
  attribution: AttributionSchema,
  evidence: z.array(EvidenceSchema).max(5),
  source_state: z.enum(['available', 'unavailable', 'stale', 'suppressed']),
  request_id: IdSchema,
}).strict().superRefine((item, ctx) => {
  if (item.ref.source_id !== item.source_id || item.ref.record_id !== item.record_id || item.ref.revision !== String(item.revision)) ctx.addIssue({ code: 'custom', message: 'MemoryRef must match the item identity and revision.' });
});

export const RouteEntrySchema = z.object({
  schema_version: z.literal(2),
  route_id: IdSchema,
  source_id: z.literal('user-explicit'),
  scope_id: IdSchema,
  project_id: IdSchema.nullable(),
  record_id: IdSchema,
  revision: z.string().regex(/^[1-9][0-9]*$/),
  occurred_at: Rfc3339Schema.nullable(),
  indexed_at: Rfc3339Schema,
  topic_labels: z.array(z.string().min(1).max(40)).max(12),
  state: z.enum(['active', 'archived', 'stale', 'suppressed']),
  query_mode: z.literal('direct'),
  native_index_ref: z.null(),
}).strict();

export const ManifestSchema = z.object({
  format: z.literal('assistant-data'),
  schema_version: z.literal(2),
  assistant_id: IdSchema,
  created_at: Rfc3339Schema,
}).strict();

export const IdentityProfileSchema = z.object({
  display_name: z.string().max(80).nullable(),
  facts: z.array(z.object({ key: z.string().min(1).max(80), value: z.string().min(1).max(300) }).strict()).max(30),
}).strict();

export const HabitsSchema = z.object({
  templates: z.array(z.enum(['lead-first', 'concise', 'show-evidence', 'ask-when-unclear'])).max(12),
}).strict();

export const JournalEventSchema = z.object({
  schema_version: z.literal(2),
  seq: z.number().int().positive(),
  event_id: IdSchema,
  op_id: IdSchema,
  kind: z.string().min(1).max(60),
  payload: z.unknown(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const TaskStatusSchema = z.enum(['created', 'running', 'completed', 'failed', 'cancelled', 'unknown']);
export const TaskPacketSchema = z.object({
  task_id: IdSchema,
  attempt_id: IdSchema,
  request_id: IdSchema,
  owner_id: IdSchema,
  project_id: IdSchema,
  objective: z.string().min(1).max(4000),
  acceptance: z.string().max(1000),
  necessary_context: z.string().max(2000),
  created_at: Rfc3339Schema,
}).strict();
export const EvidenceRefSchema = z.object({
  project_id: IdSchema,
  path: z.string().min(1).max(300),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  excerpt: z.string().max(1000),
  truncated: z.boolean(),
}).strict();
export const WorkerReceiptSchema = z.object({
  task_id: IdSchema,
  attempt_id: IdSchema,
  task_revision: z.number().int().positive(),
  status: z.enum(['completed', 'failed', 'cancelled', 'unknown']),
  outcome: z.enum(['reported_success', 'reported_failure', 'none']),
  summary: z.string().max(600),
  evidence_refs: z.array(EvidenceRefSchema).max(5),
  artifact_refs: z.array(z.string().max(500)).max(5),
  pending_questions: z.array(z.string().max(300)).max(5),
  error_code: z.string().max(60).nullable(),
  created_at: Rfc3339Schema,
}).strict();

export const ModelToolCallSchema = z.object({ id: z.string().min(1).max(100), type: z.literal('function'), function: z.object({ name: z.string().min(1).max(100), arguments: z.string().max(8000) }).strict() }).strict();
export const ModelReplySchema = z.object({
  content: z.string().max(12000).nullable(),
  tool_calls: z.array(ModelToolCallSchema).max(8),
  finish_reason: z.string().max(80).nullable(),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative().optional(), completion_tokens: z.number().int().nonnegative().optional(), total_tokens: z.number().int().nonnegative().optional() }).strict().optional(),
}).strict();

export type Attribution = z.infer<typeof AttributionSchema>;
export type MemoryItem = z.infer<typeof MemoryItemSchema>;
export type RouteEntry = z.infer<typeof RouteEntrySchema>;
export type Manifest = z.infer<typeof ManifestSchema>;
export type JournalEvent = z.infer<typeof JournalEventSchema>;
export type TaskPacket = z.infer<typeof TaskPacketSchema>;
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type WorkerReceipt = z.infer<typeof WorkerReceiptSchema>;
export type ModelReply = z.infer<typeof ModelReplySchema>;
