import { z } from 'zod';

export const ERROR_CODES = [
  'ASSISTANT_PRESENT_ELSEWHERE',
  'ASSISTANT_SAME_PROCESS',
  'LOCKED',
  'CORRUPT_DATA',
  'COMMIT_UNKNOWN',
  'CONFLICT',
  'BUDGET_EXCEEDED',
  'MAINTENANCE_REQUIRED',
  'SCHEMA_MIGRATION_REQUIRED',
  'UNAUTHORIZED',
  'OUT_OF_SCOPE',
  'NOT_FOUND',
  'SESSION_CONTROLLER_UNAVAILABLE',
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const RETRY_ADVICES = ['never', 'safe', 'after_reconcile'] as const;
export type RetryAdvice = (typeof RETRY_ADVICES)[number];

export const ACTION_KINDS = [
  'run_doctor',
  'release_presence',
  'takeover',
  'retry_later',
  'reinit',
  'restore_backup',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export interface AssistantError {
  code: ErrorCode;
  message: string;
  retry: RetryAdvice;
  action?: ActionKind;
  details?: unknown;
}
