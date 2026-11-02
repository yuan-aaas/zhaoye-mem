import { z } from 'zod';
export const OwnerInfoSchema = z.strictObject({
  state: z.literal('active'),
  host: z.string().min(1),
  host_name: z.string().min(1),
  pid: z.number().int().positive(),
  instance_id: z.uuid(),
  session_id: z.string().optional(),
  started_at: z.iso.datetime({ offset: true }),
  heartbeat_at: z.iso.datetime({ offset: true }),
  heartbeat_interval_ms: z.number().int().positive(),
  assistant_id: z.uuid(),
  adapter_version: z.string(),
});
export type OwnerInfo = z.infer<typeof OwnerInfoSchema>;
export type PresenceState =
  | { status: 'acquired' | 'reentered'; owner: OwnerInfo }
  | { status: 'taken_over'; owner: OwnerInfo; previous: OwnerInfo }
  | { status: 'blocked'; owner: OwnerInfo; reason: 'same_process' | 'alive' };
