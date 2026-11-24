import type {
  BackupAccess,
  BackupBatchReceipt,
  BackupBatchState,
  BackupSearchCriteria,
  BackupSource,
  PublishBackupBatch,
  StartBackupBatch,
} from './backup.js';
import type {
  IdentityCommitReceipt,
  IdentityDocument,
  IdentityVersionRef,
  StoredOperation,
} from './identity.js';
import type { OwnerInfo, PresenceState } from './presence.js';
import type { BackupBatchSummary, BackupDetail, BackupResult } from './query.js';

/** Persistence port. The application authorizes the source and scope before calling it. */
export interface BackupDb {
  registerSource(source: BackupSource): void;
  getSource(sourceId: string): BackupSource | null;
  startBatch(input: StartBackupBatch): BackupBatchState;
  publishBatch(input: PublishBackupBatch): Promise<BackupBatchReceipt>;
  failBatch(batchId: string, reason: string): BackupBatchReceipt;
  recoverInterruptedBatches(): number;
  getCompleteBatch(sourceId: string, scopeKey: string): string | null;
  listBatches(access: BackupAccess): BackupBatchSummary[];
  search(access: BackupAccess, input: BackupSearchCriteria): BackupResult;
  readRecords(access: BackupAccess, recordId?: string): BackupDetail[];
  rebuildIndex(): void;
  verify(): Promise<void>;
  snapshotTo(destination: string): Promise<void>;
  close(): void;
}
export type OperationTemplate = Omit<StoredOperation, 'receipt'> & {
  receipt: Omit<
    IdentityCommitReceipt,
    'document_hash' | 'version_path' | 'projection' | 'warnings'
  >;
};
export interface CommitInput {
  bytes: string;
  document: IdentityDocument;
  expectedRevision: number;
  operation: OperationTemplate;
  projectionMarkdown: string;
  reason: string;
}
export interface CommitOutput {
  fileHash: string;
  bytes: number;
  versionPath: string;
  projection: { path: string; bytes: number };
  warnings: string[];
  operation: StoredOperation;
  replayed: boolean;
}
export interface IdentityStore {
  read(): Promise<{ document: IdentityDocument; fileHash: string; bytes: number }>;
  commit(input: CommitInput): Promise<CommitOutput>;
  findOperation(operationId: string): Promise<StoredOperation | null>;
  listVersions(limit: number): Promise<IdentityVersionRef[]>;
  readVersion(revision: number): Promise<IdentityDocument>;
  readProjection(): Promise<string | null>;
}
export interface PresenceStore {
  acquire(owner: OwnerInfo): Promise<PresenceState>;
  heartbeat(instanceId: string): Promise<void>;
  release(instanceId: string): Promise<void>;
  read(): Promise<OwnerInfo | null>;
}
