export const ERROR_POLICY = {
  INVALID_INPUT: ['never', null],
  UNAUTHORIZED: ['never', null],
  OUT_OF_SCOPE: ['never', null],
  NOT_FOUND: ['never', null],
  CONFLICT: ['after_reconcile', 'run_doctor'],
  CORRUPT_DATA: ['never', 'restore_backup'],
  STORAGE_FAILURE: ['safe', 'run_doctor'],
  COMMIT_UNKNOWN: ['after_reconcile', 'run_doctor'],
  INTEGRITY_FAILED: ['never', 'restore_backup'],
  IMPORT_INCOMPLETE: ['safe', 'retry_later'],
  SOURCE_UNAVAILABLE: ['safe', 'retry_later'],
  SCHEMA_MIGRATION_REQUIRED: ['never', 'reinit'],
  BUDGET_EXCEEDED: ['never', null],
  ASSISTANT_PRESENT_ELSEWHERE: ['safe', 'release_presence'],
  ASSISTANT_SAME_PROCESS: ['never', 'release_presence'],
  LOCKED: ['safe', 'retry_later'],
} as const;
export type ErrorCode = keyof typeof ERROR_POLICY;
export class ZhaoyeError extends Error {
  readonly retry;
  readonly action;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ZhaoyeError';
    [this.retry, this.action] = ERROR_POLICY[code];
  }
}
