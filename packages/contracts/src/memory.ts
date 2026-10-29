export type MemoryStatus = 'active' | 'archived';
export type SourceState = 'available' | 'unavailable' | 'stale' | 'suppressed';

export interface MemorySource {
  source_id: string;
  native_id?: string;
}

export interface MemoryAttribution {
  origin: string;
  attributed_to: string;
  user_stance: string;
  derivation: string;
}

export interface MemoryEvidence {
  kind: string;
  ref: string;
}

export interface MemoryItem {
  record_id: string;
  revision: number;
  scope_id: string;
  project_id: string | null;
  source: MemorySource;
  status: MemoryStatus;
  content: string;
  tags: string[];
  attribution: MemoryAttribution;
  evidence: MemoryEvidence[];
  source_state: SourceState;
  occurred_at: string | null;
  created_at: string;
  updated_at: string;
}
