import type { AssistantApi, IdentitySnapshot } from '../../../dist/src/index.js';
import { initializeAssistantData, openAssistantFramework } from '../../../dist/src/index.js';
import os from 'node:os';
import path from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import { resolvePluginConfig, type ResolvedConfig } from './config.js';
import { renderIdentity, renderMemoryIndex, renderPinnedMemories, isPinned, renderProfileInvitation, truncate, codePoints } from './prompt.js';
import { projectForCwd } from './projects.js';
import { TaskStore } from './task-store.js';

export type HostService = {
  config: ResolvedConfig;
  tasks: TaskStore;
  ready: Promise<AssistantApi>;
  identity: IdentitySnapshot | null;
  identityText: string;
  memoryText: string;
  refresh(): Promise<void>;
  profileInvitation(agentId: string, empty: boolean): string;
  projectForCwd(cwd: string | undefined): string | null;
  close(): Promise<void>;
};

function isProfileEmpty(identity: IdentitySnapshot | null): boolean {
  if (!identity) return false;
  const profile = identity.user_profile as { display_name?: string | null; facts?: unknown[] };
  return !profile.display_name?.trim() && (!Array.isArray(profile.facts) || profile.facts.length === 0);
}

/**
 * Remove a writer lock only when its recorded owner process is gone, or when
 * the lock is an empty/corrupt leftover older than the grace window. The
 * framework itself never steals a lock; this adapter opts in on behalf of a
 * crashed DSH host, and only after `process.kill(pid, 0)` proves the PID dead.
 */
const LOCK_RETRY_ATTEMPTS = 8;
const LOCK_RETRY_MS = 250;
const ORPHAN_LOCK_GRACE_MS = 15_000;

type LockOwner = { pid: number };

async function readLockOwner(root: string): Promise<LockOwner | null> {
  try {
    const owner = JSON.parse(await readFile(path.join(root, '.writer.lock', 'owner.json'), 'utf8')) as { pid?: unknown };
    const pid = Number(owner.pid);
    return Number.isInteger(pid) && pid > 0 ? { pid } : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return !(code === 'ESRCH' || code === 'EINVAL');
  }
}

async function clearLockIfOrphan(root: string, logger?: { warn?: (message: string) => void }): Promise<boolean> {
  const lockDir = path.join(root, '.writer.lock');
  const owner = await readLockOwner(root);
  if (owner) {
    if (owner.pid === process.pid || pidAlive(owner.pid)) return false;
    await rm(lockDir, { recursive: true, force: true });
    logger?.warn?.(`[assistant-dsh] 清理了遗留写锁：owner pid ${owner.pid} 已退出。`);
    return true;
  }
  try {
    const info = await stat(lockDir);
    if (Date.now() - info.mtimeMs < ORPHAN_LOCK_GRACE_MS) return false;
    await rm(lockDir, { recursive: true, force: true });
    logger?.warn?.('[assistant-dsh] 清理了空/损坏的遗留写锁（超过宽限期）。');
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Open the framework, tolerating two real-world cases:
 *  - a dead owner left a lock (clear it and retry);
 *  - HMR is replacing this plugin in the same process and the old instance is
 *    still releasing the lock (wait, never delete a live lock).
 */
async function openWithRecovery(root: string, recoverStaleLock: boolean, logger?: { warn?: (message: string) => void; info?: (message: string) => void }) {
  let lastError: unknown;
  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await openAssistantFramework(root);
    } catch (error) {
      lastError = error;
      if ((error as { code?: string })?.code !== 'LOCKED') throw error;
      if (attempt === LOCK_RETRY_ATTEMPTS - 1) break;
      const owner = await readLockOwner(root);
      if (owner?.pid === process.pid) {
        await delay(LOCK_RETRY_MS);
        continue;
      }
      if (recoverStaleLock && await clearLockIfOrphan(root, logger)) continue;
      throw error;
    }
  }
  throw lastError;
}

function registerExitCleanup(root: string): void {
  process.once('exit', () => {
    try {
      const lockDir = path.join(root, '.writer.lock');
      const owner = JSON.parse(readFileSync(path.join(lockDir, 'owner.json'), 'utf8')) as { pid?: unknown };
      if (Number(owner.pid) !== process.pid) return;
      rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // no lock or already removed
    }
  });
}

export function createHostService(config: ResolvedConfig, logger?: { warn?: (message: string) => void; info?: (message: string) => void }): HostService {
  const invited = new Set<string>();
  const tasks = new TaskStore(config.stateDir);
  let identityRevision = -1;
  let memoryKey: string | null = null;
  const service: HostService = {
    config,
    tasks,
    ready: Promise.resolve(null as unknown as AssistantApi),
    identity: null,
    identityText: '',
    memoryText: '【显式记忆目录】数据尚未就绪。',
    async refresh(): Promise<void> {
      const api = await service.ready;
      const identity = await api.readIdentity();
      if (identity.revision !== identityRevision) {
        service.identity = identity;
        service.identityText = renderIdentity(identity, config.identityBudget);
        identityRevision = identity.revision;
      }
      const all = await api.listMemories(100, null);
      const pinned = all.filter(isPinned).slice(0, config.pinnedLimit);
      const pinnedIds = new Set(pinned.map((item) => item.record_id));
      const indexItems = all.filter((item) => !pinnedIds.has(item.record_id)).slice(0, config.memoryIndexLimit);
      // A stable key keeps the injected text identical between turns, so the
      // request prefix (and its provider-side cache) does not churn.
      const nextKey = all.map((item) => `${item.record_id}:${item.revision}`).join('|');
      if (nextKey !== memoryKey) {
        const pinnedText = renderPinnedMemories(pinned, config.pinnedBudget, config.pinnedItemBudget);
        const indexText = renderMemoryIndex(indexItems, all.length, config.memoryIndexBudget, config.memoryTitleLength, pinned.length);
        service.memoryText = [pinnedText, indexText].filter(Boolean).join('\n\n');
        memoryKey = nextKey;
      }
    },
    profileInvitation(agentId: string, empty: boolean): string {
      if (!empty) return '';
      if (invited.has(agentId)) return '';
      invited.add(agentId);
      return renderProfileInvitation();
    },
    projectForCwd(cwd: string | undefined): string | null {
      return projectForCwd(cwd, config.projectMap);
    },
    async close(): Promise<void> {
      const api = await service.ready.catch(() => null);
      if (api) await api.close();
      await tasks.close();
    },
  };

  service.ready = (async () => {
    if (config.autoInit) {
      try {
        await initializeAssistantData(config.dataRoot);
      } catch (error) {
        logger?.warn?.(`[assistant-dsh] 数据目录初始化失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const api = await openWithRecovery(config.dataRoot, config.recoverStaleLock, logger);
    logger?.info?.(`[assistant-dsh] 助手数据已打开：${config.dataRoot}`);
    return api;
  })();

  service.ready.then(() => {
    registerExitCleanup(config.dataRoot);
    return service.refresh();
  }).catch((error) => {
    const detail = (error instanceof Error ? error.message : String(error)).replace(/[。.!！]+$/, '');
    service.identityText = `【助手数据不可用】${detail}。请确认 ~/.zhaoye 没有被另一个进程占用，并完整重启 DSH。`;
    service.memoryText = '【显式记忆目录】数据不可用。';
    logger?.warn?.(`[assistant-dsh] 助手数据初始化失败：${detail}`);
  });

  return service;
}

export const name = 'assistant-dsh';
export const provide = ['assistant'];

export const apply = (ctx: any, rawConfig: unknown = {}): void => {
  const config = resolvePluginConfig(rawConfig);
  const service = createHostService(config, ctx.logger);
  ctx.effect(() => {
    const dispose = ctx.provide('assistant', service);
    return async () => {
      if (typeof dispose === 'function') await dispose();
      await service.close();
    };
  }, 'assistant-dsh: framework lifetime');
};

export function emptyProfile(identity: IdentitySnapshot | null): boolean {
  return isProfileEmpty(identity);
}

export function boundedText(text: string, budget: number): string {
  return truncate(text, budget);
}

export function textSize(text: string): number {
  return codePoints(text);
}

export const homeDirectory = os.homedir;
