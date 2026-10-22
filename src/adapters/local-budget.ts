import { AssistantError } from '../contracts/errors.js';
import { maxIdentityChars } from '../contracts/identity.js';

// Budgets for the local prototype's model runtime; the data service owns no Agent loop.
export const Limits = {
  leadCallsPerRequest: 4, workerCallsPerAttempt: 6, maxLeadHistoryChars: 6000,
  maxUserInputChars: 4000, maxInjectedChars: 3000, maxIdentityChars,
  maxDirectoryChars: 400, maxEvidenceChars: 1000, maxModelOutputTokens: 800,
  maxWorkerTotalReadChars: 18000, maxWorkerSingleReadChars: 6000,
  maxWorkerSingleReadLines: 200, maxListFiles: 100, maxSearchMatches: 60,
  maxSearchFiles: 200, maxSearchBytes: 8 * 1024 * 1024,
  maxWorkerSummaryChars: 600,
} as const;

export function codePoints(text: string): number { return [...text].length; }

export function requireWithin(text: string, limit: number, label: string): void {
  if (codePoints(text) > limit) throw new AssistantError('BUDGET_EXCEEDED', `${label}超过 ${limit} 个 Unicode 码点。`);
}

export function truncateCodePoints(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, max).join('')}…`;
}
