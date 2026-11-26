import type { IdentityUpdate } from './identity.js';
import type { TaskPacket } from './receipts.js';

export interface ClockPort {
  now(): Date;
}

export interface ModelRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  max_tokens: number;
}

export interface ModelResponse {
  content: string;
  reported_input_tokens?: number;
  reported_output_tokens?: number;
}

export interface ModelPort {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export interface ProfileEvolutionInput {
  assistant_id: string;
  base_revision: number;
  evidence_refs: readonly string[];
  trigger: { kind: 'user' | 'session'; id: string };
}

export interface ProfileEvolutionCandidate {
  update: Extract<IdentityUpdate, { section: 'user_profile' | 'character_profile' }>;
  confidence: number;
  evidence_refs: readonly string[];
}

export interface ProfileEvolutionPort {
  propose(input: ProfileEvolutionInput): Promise<readonly ProfileEvolutionCandidate[]>;
}

export interface WorkerStatus {
  state: 'created' | 'dispatched' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  detail?: string;
}

export interface WorkerPort {
  start(packet: TaskPacket): Promise<{ taskId: string; handle: string }>;
  inspect(handle: string): Promise<WorkerStatus>;
  cancel(handle: string): Promise<void>;
  close?(): Promise<void>;
}

export interface SourceItem {
  id: string;
  title: string;
  updated_at?: string;
}

export interface SourceContent {
  id: string;
  content: string;
  content_hash: string;
}

export interface SourcePort {
  list(): Promise<SourceItem[]>;
  read(id: string): Promise<SourceContent>;
}

export interface Notice {
  title: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
}

export interface HostPort {
  notify(notice: Notice): Promise<void>;
  openPath?(path: string): Promise<void>;
}
