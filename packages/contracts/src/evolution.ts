import { z } from 'zod';
import { LIMITS } from './limits.js';

export const accessPreferenceId = 'ask-for-access';

export const PreferenceEvidenceSchema = z.strictObject({
  id: z.string().min(1).max(LIMITS.evidenceText),
  text: z.string().min(1).max(4000),
  at: z.iso.datetime({ offset: true }),
  sourceSession: z.string().max(256).optional(),
  project: z.string().max(256).optional(),
  scoped: z.boolean().optional(),
});
export type PreferenceEvidence = z.infer<typeof PreferenceEvidenceSchema>;

export const PreferenceCandidateSchema = z.strictObject({
  id: z.uuid(),
  evidence: PreferenceEvidenceSchema,
  key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  text: z.string().max(LIMITS.profileText),
  operation: z.enum(['remember', 'forget']),
  mode: z.enum(['explicit', 'candidate']),
  state: z.enum(['pending', 'applying', 'applied', 'unchanged', 'rejected']),
  revision: z.number().int().positive().optional(),
});
export type PreferenceCandidate = z.infer<typeof PreferenceCandidateSchema>;
export const PreferenceLedgerSchema = z.array(PreferenceCandidateSchema);
