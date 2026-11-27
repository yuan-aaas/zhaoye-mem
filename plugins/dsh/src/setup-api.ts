export const setupRoute = '/api/zhaoye/onboarding';

export interface SetupSkill {
  id: string;
  name: string;
  asset: string;
  installed: boolean;
}

export interface SetupStatus {
  dataRoot: string;
  identity: { path: string; ready: boolean };
  backup: { path: string; ready: boolean };
  assets: { path: string; ready: boolean };
  ready: boolean;
  canInitialize: boolean;
  issue: string | null;
  skillIssue: string | null;
  skills: SetupSkill[];
  skillsPath: string;
}
