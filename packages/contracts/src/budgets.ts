import { ZhaoyeError } from './errors.js';

export const BUDGETS = {
  identityCodePoints: 1600,
  personaCodePoints: 400,
  memoryDirectoryCodePoints: 600,
  memoryDirectoryItems: 5,
  memoryTitleCodePoints: 30,
  pinnedMemoryCodePoints: 600,
  pinnedMemoryItems: 3,
  pinnedMemoryItemCodePoints: 300,
  fixedInjectionCodePoints: 2800,
  toolResultCodePoints: 1000,
  receiptSummaryCodePoints: 600,
  localWorkerReadLines: 200,
  localWorkerReadCodePoints: 6000,
  modelRequestTokens: 8000,
} as const;

export type BudgetName = keyof typeof BUDGETS;

// Text limits used until DSH exposes a model-specific tokenizer to the adapter.
export const DSH_PERSONA_CODE_POINTS = {
  kernel: 320,
  instructions: 128,
  replyStyle: 50,
  fixed: 512,
  findResult: 512,
} as const;

export function renderBoundedSafetyKernel(principles: readonly string[]): string {
  const text = principles.join('\n');
  const actual = [...text].length;
  if (actual > DSH_PERSONA_CODE_POINTS.kernel) {
    throw new ZhaoyeError('BUDGET_EXCEEDED', '安全内核超出码点预算，请通过人格入口修订原文', {
      unit: 'code_points',
      actual,
      limit: DSH_PERSONA_CODE_POINTS.kernel,
    });
  }
  return text;
}
