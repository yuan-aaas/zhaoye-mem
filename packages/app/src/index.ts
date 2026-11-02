import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  type AdapterManifest,
  type ClockPort,
  type OwnerInfo,
  ZhaoyeError,
} from '@zhaoye/contracts';
import { createIdentityService, renderIdentityMarkdown } from '@zhaoye/core';
import {
  createPresence,
  ensureDataRoot,
  ioError,
  openDataRoot,
  openIdentityStore,
} from '@zhaoye/storage';
import { doctor } from './doctor.js';
export const packageName = '@zhaoye/app' as const;
export { renderIdentityMarkdown } from '@zhaoye/core';
export * from './doctor.js';
export interface ZhaoyeConfig {
  dataRoot?: string;
  host: AdapterManifest;
  clock?: ClockPort;
  initIfMissing?: boolean;
}
export async function createZhaoye(config: ZhaoyeConfig) {
  if (config.host.data_schema !== 1)
    throw new ZhaoyeError('SCHEMA_MIGRATION_REQUIRED', '宿主数据 schema 不兼容');
  const clock = config.clock ?? { now: () => new Date() };
  let data: Awaited<ReturnType<typeof ensureDataRoot>>;
  try {
    data =
      config.initIfMissing === false
        ? { ...(await openDataRoot(config.dataRoot)), created: false }
        : await ensureDataRoot(config.dataRoot, clock, renderIdentityMarkdown);
  } catch (e) {
    throw ioError(e, config.dataRoot ?? '~/.zhaoye');
  }
  const { root, manifest, created } = data;
  const presence = createPresence(root, clock);
  const now = clock.now().toISOString();
  const instanceId = randomUUID();
  const owner: OwnerInfo = {
    state: 'active',
    host: config.host.host_id,
    host_name: hostname(),
    pid: process.pid,
    instance_id: instanceId,
    started_at: now,
    heartbeat_at: now,
    heartbeat_interval_ms: 60000,
    assistant_id: manifest.assistant_id,
    adapter_version: config.host.adapter_version,
  };
  const state = await presence.acquire(owner);
  if (state.status === 'blocked')
    throw new ZhaoyeError(
      state.reason === 'same_process' ? 'ASSISTANT_SAME_PROCESS' : 'ASSISTANT_PRESENT_ELSEWHERE',
      '数据根已被其他实例持有',
      { owner: state.owner },
    );
  let closed = false;
  let lost: unknown;
  let closing: Promise<void> | undefined;
  let released = false;
  const assertOpen = () => {
    if (closed) throw new ZhaoyeError('CONFLICT', '实例已关闭');
    if (lost)
      throw new ZhaoyeError('CONFLICT', 'presence 心跳失败，请关闭后重新打开', {
        cause: String(lost),
      });
  };
  async function assertOwner() {
    assertOpen();
    const current = await presence.read();
    if (current?.instance_id !== instanceId)
      throw new ZhaoyeError('CONFLICT', 'presence 归属已变化');
  }
  const store = openIdentityStore(root, { assertOwner });
  const inFlight = new Set<Promise<unknown>>();
  function track<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
    return async (...args: A): Promise<R> => {
      assertOpen();
      const promise = fn(...args);
      inFlight.add(promise);
      try {
        return await promise;
      } finally {
        inFlight.delete(promise);
      }
    };
  }
  const service = createIdentityService(store, clock, assertOpen);
  const identity = {
    read: track(service.read),
    preview: track(service.preview),
    commit: track(service.commit),
    commitKernel: track(service.commitKernel),
    rollback: track(service.rollback),
    rollbackKernel: track(service.rollbackKernel),
    listVersions: track(service.listVersions),
  };
  let heartbeat: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    heartbeat = presence.heartbeat(instanceId).catch((e) => {
      lost = e;
    });
  }, 60000);
  timer.unref();
  return {
    assistantId: manifest.assistant_id,
    dataRoot: root,
    created,
    identity,
    presence: () => presence.read(),
    doctor: () => doctor(root),
    close: (): Promise<void> => {
      if (released) return Promise.resolve();
      if (closing) return closing;
      closed = true;
      clearInterval(timer);
      closing = Promise.allSettled([...inFlight])
        .then(() => heartbeat)
        .then(async () => {
          // A previous attempt may have removed owner.json before a later I/O failure.
          if (await presence.read()) await presence.release(instanceId);
          released = true;
        })
        .finally(() => {
          closing = undefined;
        });
      return closing;
    },
  };
}
export type Zhaoye = Awaited<ReturnType<typeof createZhaoye>>;
