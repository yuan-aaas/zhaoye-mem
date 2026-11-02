import type {
  IdentityCommitReceipt,
  IdentityDocument,
  IdentityVersionRef,
  StoredOperation,
} from './identity.js';
import type { OwnerInfo, PresenceState } from './presence.js';
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
