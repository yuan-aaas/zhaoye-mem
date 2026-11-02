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
