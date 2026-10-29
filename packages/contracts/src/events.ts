import { z } from 'zod';

export const EVENT_KINDS = [
  'kernel.proposed',
  'kernel.applied',
  'profile.evolved',
  'memory.recorded',
  'memory.revised',
  'memory.archived',
  'index.hint',
  'settings.updated',
  'presence.entered',
  'presence.released',
  'presence.takeover',
  'maintenance.repaired',
  'maintenance.migrated',
  'maintenance.exported',
] as const;

export const EventKindSchema = z.enum(EVENT_KINDS);
export type EventKind = z.infer<typeof EventKindSchema>;

const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/i, 'Expected a 64-character SHA-256 hex digest');

export const EventActorSchema = z
  .object({
    adapter_id: z.string().min(1),
    host: z.string().min(1).optional(),
    session_id: z.string().min(1).optional(),
  })
  .strict();

export const EventEnvelopeSchema = z
  .object({
    v: z.literal(3),
    seq: z.number().int().positive(),
    id: z.string().uuid(),
    at: z.string().datetime({ offset: true }),
    op: z.string().min(1),
    fingerprint: Sha256Schema,
    prev: Sha256Schema,
    digest: Sha256Schema,
    kind: EventKindSchema,
    actor: EventActorSchema,
    payload: z.unknown(),
  })
  .strict();

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
