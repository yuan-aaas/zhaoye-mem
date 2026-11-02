import { z } from 'zod';
import { ZhaoyeError } from './errors.js';
import { LIMITS } from './limits.js';

const text = (max: number) =>
  z
    .string()
    .min(1)
    .refine((v) => Array.from(v).length <= max, 'too long');
const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const uuid = z.uuid();
const date = z.iso.datetime({ offset: true });
const revision = z.number().int().min(1).max(999999999999);
const refs = z.array(text(LIMITS.evidenceText)).max(LIMITS.evidenceRefs);
const base = { revision, updated_at: date };
export const SECTION_NAMES = [
  'safety_kernel',
  'user_profile',
  'character_profile',
  'project_state',
  'continuity_memory',
] as const;
export const SectionNameSchema = z.enum(SECTION_NAMES);
export type SectionName = z.infer<typeof SectionNameSchema>;
export const ProfileEntrySchema = z.strictObject({
  id,
  text: text(LIMITS.profileText),
  confidence: z.number().min(0).max(1),
  source: z.enum(['user_explicit', 'user_confirmation', 'model_inference', 'imported', 'preset']),
  evidence_refs: refs,
  updated_at: date,
});
export const ProjectEntrySchema = z.strictObject({
  project_id: id,
  name: text(200),
  goal: z.string().max(LIMITS.projectGoal),
  decisions: z.array(text(LIMITS.projectText)).max(LIMITS.projectItems),
  progress: z.array(text(LIMITS.projectText)).max(LIMITS.projectItems),
  blockers: z.array(text(LIMITS.projectText)).max(LIMITS.projectItems),
  next_steps: z.array(text(LIMITS.projectText)).max(LIMITS.projectItems),
  evidence_refs: refs,
  updated_at: date,
});
export const ContinuityEntrySchema = z.strictObject({
  id,
  summary: text(LIMITS.summary),
  occurred_at: date,
  evidence_refs: refs,
  updated_at: date,
});
const unique = <T>(items: T[], key: (item: T) => string) =>
  new Set(items.map(key)).size === items.length;
const profileList = (max: number) =>
  z
    .array(ProfileEntrySchema)
    .max(max)
    .refine((v) => unique(v, (e) => e.id), 'duplicate id');
export const IdentityDocumentSchema = z.strictObject({
  schema_version: z.literal(1),
  assistant_id: uuid,
  revision,
  created_at: date,
  updated_at: date,
  safety_kernel: z.strictObject({
    ...base,
    principles: z.array(text(LIMITS.principleText)).min(1).max(LIMITS.principles),
  }),
  user_profile: z
    .strictObject({
      ...base,
      display_name: text(200).nullable(),
      facts: profileList(LIMITS.facts),
      preferences: profileList(LIMITS.preferences),
    })
    .refine(
      (v) => unique([...v.facts, ...v.preferences], (e) => e.id),
      'duplicate id in user_profile',
    ),
  character_profile: z.strictObject({ ...base, traits: profileList(LIMITS.traits) }),
  project_state: z.strictObject({
    ...base,
    projects: z
      .array(ProjectEntrySchema)
      .max(LIMITS.projects)
      .refine((v) => unique(v, (e) => e.project_id), 'duplicate project_id'),
  }),
  continuity_memory: z.strictObject({
    ...base,
    entries: z
      .array(ContinuityEntrySchema)
      .max(LIMITS.continuity)
      .refine((v) => unique(v, (e) => e.id), 'duplicate id'),
  }),
});
export type IdentityDocument = z.infer<typeof IdentityDocumentSchema>;
export type ProfileEntry = z.infer<typeof ProfileEntrySchema>;
export type ProjectEntry = z.infer<typeof ProjectEntrySchema>;
export type ContinuityEntry = z.infer<typeof ContinuityEntrySchema>;
const ops = <T extends z.ZodType>(schema: T) =>
  z
    .array(
      z.union([
        z.strictObject({ op: z.literal('upsert'), entry: schema }),
        z.strictObject({ op: z.literal('remove'), id }),
      ]),
    )
    .max(100);
export const ConfirmationSchema = z.strictObject({ confirmation_ref: text(200) });
export const IdentityUpdateSchema = z.discriminatedUnion('section', [
  z.strictObject({
    section: z.literal('safety_kernel'),
    principles: z.array(text(LIMITS.principleText)).min(1).max(LIMITS.principles),
    user_confirmed: ConfirmationSchema,
  }),
  z.strictObject({
    section: z.literal('user_profile'),
    display_name: text(200).nullable().optional(),
    facts: ops(ProfileEntrySchema).optional(),
    preferences: ops(ProfileEntrySchema).optional(),
  }),
  z.strictObject({ section: z.literal('character_profile'), traits: ops(ProfileEntrySchema) }),
  z.strictObject({ section: z.literal('project_state'), projects: ops(ProjectEntrySchema) }),
  z.strictObject({ section: z.literal('continuity_memory'), entries: ops(ContinuityEntrySchema) }),
]);
const requestBase = {
  request_id: uuid,
  operation_id: uuid,
  expected_revision: revision,
  reason: text(200),
};
export const IdentityCommitRequestSchema = z.strictObject({
  ...requestBase,
  update: IdentityUpdateSchema,
  evidence_refs: refs,
});
export const IdentityRollbackRequestSchema = z.strictObject({
  ...requestBase,
  section: SectionNameSchema,
  to_revision: revision,
  user_confirmed: ConfirmationSchema.optional(),
});
export const ActorContextSchema = z.strictObject({
  adapter_id: text(64),
  host: text(200).optional(),
  session_id: text(200).optional(),
  scope_id: uuid,
  granted_project_ids: z.union([z.literal('*'), z.array(id)]),
  granted_source_ids: z.union([z.literal('*'), z.array(id)]),
});
export const DataManifestSchema = z.strictObject({
  format: z.literal('zhaoye-data'),
  schema_version: z.literal(1),
  assistant_id: uuid,
  created_at: date,
});
export type DataManifest = z.infer<typeof DataManifestSchema>;
export type ActorContext = z.infer<typeof ActorContextSchema>;
export type IdentityUpdate = z.infer<typeof IdentityUpdateSchema>;
export type IdentityCommitRequest = z.infer<typeof IdentityCommitRequestSchema>;
export type IdentityRollbackRequest = z.infer<typeof IdentityRollbackRequestSchema>;
export interface AdapterManifest {
  host_id: 'dsh' | 'mcp' | 'cli';
  display_name: string;
  capabilities: Array<'tools' | 'prompt' | 'session' | 'approval' | 'notice' | 'worker'>;
  adapter_version: string;
  data_schema: 1;
}
export const IdentityCommitReceiptSchema = z.strictObject({
  assistant_id: uuid,
  revision,
  section_revisions: z.strictObject(
    Object.fromEntries(SECTION_NAMES.map((s) => [s, revision])) as Record<
      SectionName,
      typeof revision
    >,
  ),
  operation_id: uuid,
  applied_at: date,
  document_hash: z.string().regex(/^[a-f0-9]{64}$/),
  version_path: text(200),
  projection: z.strictObject({ path: text(200), bytes: z.number().int().nonnegative() }),
  warnings: z.array(z.string()),
});
export type IdentityCommitReceipt = z.infer<typeof IdentityCommitReceiptSchema>;
export interface IdentityCommitResult {
  receipt: IdentityCommitReceipt;
  replayed: boolean;
}
export interface IdentitySnapshot {
  document: IdentityDocument;
  revision: number;
  file_hash: string;
  projection_path: string;
}
export interface IdentityPreview {
  base_revision: number;
  next_revision: number;
  changes: Array<{ section: SectionName; added: string[]; removed: string[]; replaced: string[] }>;
  warnings: string[];
}
export const IdentityVersionRefSchema = z.strictObject({
  revision,
  at: date,
  section: SectionNameSchema,
  operation_id: uuid,
  reason: text(200),
  document_hash: z.string().regex(/^[a-f0-9]{64}$/),
  retained: z.boolean(),
});
export type IdentityVersionRef = z.infer<typeof IdentityVersionRefSchema>;
export const StoredOperationSchema = z.strictObject({
  operation_id: uuid,
  request_id: uuid,
  adapter_id: text(64),
  section: SectionNameSchema,
  evidence_refs: refs,
  confirmation_ref: text(200).optional(),
  revision,
  at: date,
  receipt: IdentityCommitReceiptSchema,
});
export type StoredOperation = z.infer<typeof StoredOperationSchema>;
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new ZhaoyeError('INVALID_INPUT', '输入不符合契约', { issues: result.error.issues });
  return result.data;
}
export function serializeIdentityDocument(input: IdentityDocument): string {
  const result = `${JSON.stringify(parseInput(IdentityDocumentSchema, input), null, 2)}\n`;
  if (new TextEncoder().encode(result).byteLength > LIMITS.identityBytes)
    throw new ZhaoyeError('INVALID_INPUT', '身份文档超过文件大小上限');
  return result;
}
