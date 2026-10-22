import os from 'node:os';
import path from 'node:path';

export type ResolvedConfig = {
  dataRoot: string;
  stateDir: string;
  autoInit: boolean;
  recoverStaleLock: boolean;
  projectMap: Record<string, string>;
  memoryIndexLimit: number;
  memoryIndexBudget: number;
  memoryTitleLength: number;
  pinnedLimit: number;
  pinnedBudget: number;
  pinnedItemBudget: number;
  identityBudget: number;
  recallBudget: number;
  workerPreset: string;
  delegateTimeoutMs: number;
  deniedTools: string[];
};

const DEFAULT_DENIED = [
  'memory_save', 'memory_search', 'memory_list', 'memory_get', 'memory_update',
  'memory_delete', 'memory_forget', 'memory_archive', 'memory_register_document',
  'memory_runtime', 'set_scope_state',
  'subagent', 'subagent_fork', 'list_agents', 'send_message',
];

export function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return fallback;
  return number;
}

function normalizeProjectMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(key)) throw new Error(`projectMap alias "${key}" is invalid`);
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`projectMap["${key}"] must be a non-empty path`);
    map[key] = path.resolve(expandHome(value.trim()));
  }
  return map;
}

export function resolvePluginConfig(raw: unknown = {}): ResolvedConfig {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const dataRoot = path.resolve(expandHome(typeof input.dataRoot === 'string' && input.dataRoot.trim() ? input.dataRoot.trim() : '~/.zhaoye'));
  const stateDir = path.resolve(expandHome(typeof input.stateDir === 'string' && input.stateDir.trim() ? input.stateDir.trim() : '~/.dsh/assistant-dsh'));
  return {
    dataRoot,
    stateDir,
    autoInit: input.autoInit !== false,
    recoverStaleLock: input.recoverStaleLock !== false,
    projectMap: normalizeProjectMap(input.projectMap),
    memoryIndexLimit: boundedInt(input.memoryIndexLimit, 5, 1, 50),
    memoryIndexBudget: boundedInt(input.memoryIndexBudget, 600, 200, 4000),
    memoryTitleLength: boundedInt(input.memoryTitleLength, 30, 10, 120),
    pinnedLimit: boundedInt(input.pinnedLimit, 3, 0, 10),
    pinnedBudget: boundedInt(input.pinnedBudget, 600, 0, 4000),
    pinnedItemBudget: boundedInt(input.pinnedItemBudget, 300, 80, 1000),
    identityBudget: boundedInt(input.identityBudget, 1600, 400, 8000),
    recallBudget: boundedInt(input.recallBudget, 4000, 200, 20000),
    workerPreset: typeof input.workerPreset === 'string' && input.workerPreset.trim() ? input.workerPreset.trim() : 'assistant-worker',
    delegateTimeoutMs: boundedInt(input.delegateTimeoutMs, 900_000, 10_000, 3_600_000),
    deniedTools: Array.isArray(input.deniedTools) && input.deniedTools.every((item) => typeof item === 'string')
      ? [...new Set(input.deniedTools.map((item) => String(item)))]
      : DEFAULT_DENIED,
  };
}
