export type WorkerOutcome = 'reported_success' | 'reported_failure' | 'none';

export interface TaskPacket {
  task_id: string;
  goal: string;
  instructions: string[];
  read_scope: string[];
  write_scope: string[];
  attempt: number;
}

export interface EvidenceReference {
  path: string;
  start_line: number;
  end_line: number;
  sha256: string;
  quote: string;
}

export interface ArtifactReference {
  path: string;
  media_type?: string;
}

export interface WorkerReceipt {
  summary: string;
  outcome: WorkerOutcome;
  evidence_refs: EvidenceReference[];
  artifact_refs: ArtifactReference[];
  pending_questions: string[];
  degraded: boolean;
  truncated: boolean;
}
