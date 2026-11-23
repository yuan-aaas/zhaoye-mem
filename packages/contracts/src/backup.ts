import { z } from 'zod';

export type SourceState = 'available' | 'unavailable' | 'stale' | 'suppressed';
export type Visibility = 'visible' | 'deleted' | 'unavailable';
export interface ImportBatch {
  batch_id: string;
  source_id: string;
  status: 'running' | 'complete' | 'partial' | 'failed';
  started_at: string;
  finished_at: string | null;
  converter_version: string;
}
export interface BackupRecord {
  record_id: string;
  source_id: string;
  native_id: string;
  project_id: string | null;
  visibility: Visibility;
  current_version_id: string | null;
}

const id = z.string().trim().min(1).max(256);
const nativeId = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim().length > 0);
const date = z.iso.datetime();
const jsonObject = z.record(z.string(), z.json());
const count = z.number().int().nonnegative();
export const BackupSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const BackupSourceSchema = z.strictObject({
  sourceId: id,
  kind: id,
  scopeId: id,
  displayName: id,
  policy: jsonObject,
});
export const StartBackupBatchSchema = z.strictObject({
  sourceId: id,
  scopeId: id,
  scopeKey: id,
  scope: jsonObject,
  operationId: id,
  adapterId: id,
  mode: z.enum(['live', 'historical']),
  format: id,
  converterVersion: id,
  inputKey: id.optional(),
});
export const BackupManifestSchema = z.strictObject({
  batchId: z.uuid(),
  sourceId: id,
  scopeKey: id,
  format: id,
  converterVersion: id,
  captureStartedAt: date,
  capturedAt: date,
  capturedAtKind: z.enum(['source', 'local']),
  declaredCoverage: z.enum(['complete', 'partial']),
  artifact: z.strictObject({
    name: z.enum(['source.sqlite', 'source.ndjson']),
    bytes: count,
    sha256: BackupSha256Schema,
  }),
});
export const BackupObservationSchema = z
  .strictObject({
    nativeId,
    content: z.strictObject({ kind: id, title: z.string(), body: z.string() }).nullable(),
    projectId: id.nullable(),
    searchAllowed: z.boolean(),
    visibility: z.enum(['visible', 'unavailable', 'deleted']),
    reason: id.nullable(),
    sourceUpdatedAt: date.nullable(),
    rawRef: id.nullable(),
    metadata: jsonObject,
  })
  .refine((row) => row.visibility !== 'visible' || row.content !== null, {
    message: '可见记录必须有内容',
  });
export const PublishBackupBatchSchema = z.strictObject({
  batchId: z.uuid(),
  status: z.enum(['complete', 'partial']),
  readCount: count,
  rejectedCount: count,
  records: z.array(BackupObservationSchema),
});
export const BackupBatchReceiptSchema = z.strictObject({
  batchId: z.uuid(),
  sourceId: id,
  scopeKey: id,
  status: z.enum(['complete', 'partial', 'failed']),
  capturedAt: date.nullable(),
  rawSha256: BackupSha256Schema.nullable(),
  readCount: count,
  rejectedCount: count,
  recordCount: count,
  newVersionCount: count,
  absentCount: count,
  previousCompleteBatchId: z.uuid().nullable(),
});

export type BackupSource = z.infer<typeof BackupSourceSchema>;
export type StartBackupBatch = z.infer<typeof StartBackupBatchSchema>;
export type BackupManifest = z.infer<typeof BackupManifestSchema>;
export type BackupObservation = z.infer<typeof BackupObservationSchema>;
export type PublishBackupBatch = z.infer<typeof PublishBackupBatchSchema>;
export type BackupBatchReceipt = z.infer<typeof BackupBatchReceiptSchema>;
export type BackupBatchState =
  | { batchId: string; status: 'running'; created: boolean }
  | BackupBatchReceipt;

/** Persistence port. The application authorizes the source and scope before calling it. */
export interface BackupDb {
  registerSource(source: BackupSource): void;
  startBatch(input: StartBackupBatch): BackupBatchState;
  publishBatch(input: PublishBackupBatch): Promise<BackupBatchReceipt>;
  failBatch(batchId: string, reason: string): BackupBatchReceipt;
  recoverInterruptedBatches(): number;
  getCompleteBatch(sourceId: string, scopeKey: string): string | null;
  rebuildIndex(): void;
  verify(): Promise<void>;
  snapshotTo(destination: string): Promise<void>;
  close(): void;
}
