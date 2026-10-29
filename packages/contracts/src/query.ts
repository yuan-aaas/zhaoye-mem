import type { MemoryItem } from './memory.js';

export interface QueryContext {
  scope_id: string;
  project_ids: string[] | '*';
  source_ids: string[] | '*';
  limit: number;
  cursor?: string;
}

export interface RouteEntry {
  record_id: string;
  revision: number;
  scope_id: string;
  project_id: string | null;
  source_id: string;
  status: 'active' | 'archived';
  title: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface LocateResult {
  hits: RouteEntry[];
  coverage: 'complete' | 'partial';
  next_cursor: string | null;
  context_digest: string;
}

export interface RecallResult {
  item: MemoryItem;
  context_digest: string;
}
