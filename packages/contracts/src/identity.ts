export interface UserProfile {
  display_name: string;
  facts: string[];
}

export interface CharacterProfile {
  revision: number;
  traits: Array<{
    key: string;
    value: string;
    evidence_refs: string[];
    confidence: number;
    updated_at: string;
  }>;
}

export interface SafetyKernel {
  revision: number;
  principles: string[];
}

export interface IdentitySnapshot {
  revision: number;
  safety_kernel: SafetyKernel;
  character_profile: CharacterProfile;
  user_profile: UserProfile;
  habits: string[];
}

export interface KernelProposal {
  proposal_id: string;
  adapter_id: string;
  expected_revision: number;
  proposed: SafetyKernel;
}

export interface KernelCommit {
  revision: number;
  applied_seq: number;
  kernel_hash: string;
}

export interface ProfileEvolutionRequest {
  expected_revision: number;
  operation_id: string;
  strategy_revision: string;
  evidence_refs: string[];
  proposed_traits: CharacterProfile['traits'];
}

export interface ProfileCommit {
  revision: number;
  applied_seq: number;
  profile_hash: string;
}
