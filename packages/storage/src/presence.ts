import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ClockPort,
  type OwnerInfo,
  OwnerInfoSchema,
  type PresenceStore,
  ZhaoyeError,
} from '@zhaoye/contracts';
import { ensureDir, ioError, isMissing, readJson, readText, writeAtomic } from './atomic-fs.js';
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !(typeof e === 'object' && e !== null && 'code' in e && e.code === 'ESRCH');
  }
}
export function isStale(owner: OwnerInfo, now: Date): boolean {
  return now.getTime() - Date.parse(owner.heartbeat_at) > owner.heartbeat_interval_ms * 3;
}
export function createPresence(
  root: string,
  clock: ClockPort = { now: () => new Date() },
  alive = pidAlive,
): PresenceStore {
  const dir = join(root, 'presence');
  const ownerPath = join(dir, 'owner.json');
  const lockPath = join(dir, '.tmp-presence-lock');
  async function read() {
    return (await readText(ownerPath)) === null ? null : readJson(ownerPath, OwnerInfoSchema);
  }
  async function locked<T>(work: () => Promise<T>): Promise<T> {
    await ensureDir(dir);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(lockPath, 'wx');
    } catch (e) {
      if (!(typeof e === 'object' && e !== null && 'code' in e && e.code === 'EEXIST'))
        throw ioError(e, lockPath);
      // Recovery is serialized separately; it never steals a live process's short lock.
      const recovery = `${lockPath}-recovery`;
      let guard: Awaited<ReturnType<typeof open>>;
      try {
        guard = await open(recovery, 'wx');
      } catch {
        throw new ZhaoyeError('LOCKED', 'presence 正被其他操作修改', { path: lockPath });
      }
      try {
        const raw = await readText(lockPath);
        let pid: number | undefined;
        try {
          pid = Number(JSON.parse(raw ?? '{}').pid);
        } catch {
          /* incomplete lock requires explicit diagnosis */
        }
        if (!pid || alive(pid))
          throw new ZhaoyeError('LOCKED', 'presence 短期锁仍活跃或不完整', { path: lockPath });
        await unlink(lockPath);
        handle = await open(lockPath, 'wx');
      } finally {
        await guard.close();
        await unlink(recovery);
      }
    }
    let result: T | undefined;
    let failure: unknown;
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      await handle.sync();
      result = await work();
    } catch (e) {
      failure = e;
    }
    try {
      await handle.close();
      try {
        await unlink(lockPath);
      } catch (e) {
        if (!isMissing(e)) throw ioError(e, lockPath);
      }
    } catch (e) {
      failure ??= ioError(e, lockPath);
    }
    if (failure) throw failure;
    return result as T;
  }
  return {
    read,
    acquire: (owner) =>
      locked(async () => {
        const previous = await read();
        if (previous) {
          if (previous.pid === owner.pid)
            return previous.instance_id === owner.instance_id
              ? { status: 'reentered', owner: previous }
              : { status: 'blocked', owner: previous, reason: 'same_process' };
          if (alive(previous.pid)) return { status: 'blocked', owner: previous, reason: 'alive' };
          await writeAtomic(
            join(dir, 'last-released.json'),
            JSON.stringify({ owner: previous, at: clock.now().toISOString(), reason: 'pid_dead' }) +
              '\n',
          );
        }
        await writeAtomic(ownerPath, `${JSON.stringify(OwnerInfoSchema.parse(owner))}\n`);
        return previous ? { status: 'taken_over', owner, previous } : { status: 'acquired', owner };
      }),
    heartbeat: (instanceId) =>
      locked(async () => {
        const owner = await read();
        if (!owner || owner.instance_id !== instanceId)
          throw new ZhaoyeError('CONFLICT', 'presence 归属已变更');
        await writeAtomic(
          ownerPath,
          `${JSON.stringify({ ...owner, heartbeat_at: clock.now().toISOString() })}\n`,
        );
      }),
    release: (instanceId) =>
      locked(async () => {
        const owner = await read();
        if (!owner || owner.instance_id !== instanceId)
          throw new ZhaoyeError('CONFLICT', '无法释放其他实例的 presence');
        await writeAtomic(
          join(dir, 'last-released.json'),
          `${JSON.stringify({ owner, at: clock.now().toISOString(), reason: 'released' })}\n`,
        );
        try {
          await unlink(ownerPath);
        } catch (e) {
          throw ioError(e, ownerPath);
        }
      }),
  };
}
