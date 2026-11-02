import type { Visibility } from './backup.js';
export interface QueryContext {
  scope_id: string;
  project_ids: string[] | '*';
  source_ids: string[] | '*';
  time_range?: { from?: string; to?: string };
  limit: number;
  cursor?: string;
}
export interface BackupHit {
  record_id: string;
  version_id: string;
  source_id: string;
  project_id: string | null;
  snippet: string;
  content_hash: string;
  source_updated_at: string | null;
  visibility: Visibility;
  batch: { batch_id: string; finished_at: string | null; status: 'complete' | 'partial' };
}
export interface BackupResult {
  hits: BackupHit[];
  coverage: 'complete' | 'partial';
  next_cursor: string | null;
  batch_coverage: {
    oldest_complete_batch_at: string | null;
    newest_batch_at: string | null;
    includes_partial_batch: boolean;
  };
}
