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
  journalEventBytes: 64 * 1024,
  localWorkerReadLines: 200,
  localWorkerReadCodePoints: 6000,
  modelRequestTokens: 8000,
} as const;

export type BudgetName = keyof typeof BUDGETS;
