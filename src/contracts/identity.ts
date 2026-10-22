import { z } from 'zod';
import { HabitsSchema, IdSchema, IdentityProfileSchema } from './schemas.js';
import { AssistantError } from './errors.js';

export const maxIdentityChars = 1600;
export const IdentityPatchSchema = z.object({
  kernel: z.string().min(1).max(maxIdentityChars).optional(),
  user_profile: IdentityProfileSchema.partial().strict().refine((value) => Object.keys(value).length > 0, '用户画像修改不能为空。').optional(),
  habits: HabitsSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, '画像修改不能为空。');

export const IdentityValuesSchema = z.object({ kernel: z.string().min(1).max(maxIdentityChars), user_profile: IdentityProfileSchema, habits: HabitsSchema }).strict();
export type IdentityValues = z.infer<typeof IdentityValuesSchema>;
export type IdentitySnapshot = IdentityValues & { revision: number; identity_hash: string };
export type IdentityPatch = z.infer<typeof IdentityPatchSchema>;
export type IdentityPreview = { proposal_id: string; expected_revision: number; before: IdentitySnapshot; after: IdentityValues };
export type IdentityUpdateReceipt = { proposal_id: string; revision: number; identity_hash: string };

export const AdapterContextSchema = z.object({ adapter_id: IdSchema, request_id: IdSchema }).strict();
export type AdapterContext = z.infer<typeof AdapterContextSchema>;
export const IdentityUpdateRequestSchema = z.object({
  operation_id: IdSchema.max(80), expected_revision: z.number().int().positive(), patch: IdentityPatchSchema,
}).strict();
export type IdentityUpdateRequest = z.infer<typeof IdentityUpdateRequestSchema>;

export function resolveIdentityPatch(current: IdentityValues, patch: IdentityPatch): IdentityValues {
  const resolved = IdentityValuesSchema.parse({
    kernel: patch.kernel ?? current.kernel,
    user_profile: patch.user_profile ? { ...current.user_profile, ...patch.user_profile } : current.user_profile,
    habits: patch.habits ?? current.habits,
  });
  const text = `${resolved.kernel}\n\n用户画像：${JSON.stringify(resolved.user_profile)}\n\n协作习惯：${JSON.stringify(resolved.habits)}`;
  if ([...text].length > maxIdentityChars) throw new AssistantError('BUDGET_EXCEEDED', '固定画像超过 1600 个 Unicode 码点，请减少填写内容。');
  return resolved;
}
