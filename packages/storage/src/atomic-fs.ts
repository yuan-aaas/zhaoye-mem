import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ZhaoyeError } from '@zhaoye/contracts';
export const hashBytes = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
export const isMissing = (e: unknown) =>
  !!e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT';
export function ioError(e: unknown, path: string): ZhaoyeError {
  return e instanceof ZhaoyeError
    ? e
    : new ZhaoyeError('STORAGE_FAILURE', '文件操作失败', { path, cause: String(e) });
}
export async function ensureDir(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true });
  } catch (e) {
    throw ioError(e, path);
  }
}
export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if (isMissing(e)) return null;
    throw ioError(e, path);
  }
}
export async function readJson<T>(
  path: string,
  schema: { parse: (input: unknown) => T },
): Promise<T> {
  const raw = await readText(path);
  try {
    if (raw === null) throw new Error('missing');
    return schema.parse(JSON.parse(raw));
  } catch (e) {
    throw new ZhaoyeError('CORRUPT_DATA', '文件缺失、解析失败或不符合契约', {
      path,
      cause: String(e),
    });
  }
}
export async function writeAtomic(path: string, bytes: string): Promise<void> {
  const dir = dirname(path);
  await ensureDir(dir);
  const prefix = `.${basename(path)}.tmp-`;
  try {
    for (const name of await readdir(dir))
      if (name.startsWith(prefix)) await unlink(join(dir, name));
  } catch (e) {
    throw ioError(e, path);
  }
  const tmp = join(dir, `${prefix + process.pid}-${randomUUID()}`);
  let renamed = false;
  try {
    const handle = await open(tmp, 'wx');
    try {
      await handle.writeFile(bytes, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
    renamed = true;
    // Windows cannot fsync directories. File sync + rename is the strongest portable guarantee here.
    if (process.platform !== 'win32') {
      const parent = await open(dir, 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  } catch (e) {
    if (renamed)
      throw new ZhaoyeError('COMMIT_UNKNOWN', '替换已完成但目录持久化结果未知', {
        path,
        cause: String(e),
      });
    throw ioError(e, path);
  } finally {
    try {
      await unlink(tmp);
    } catch {
      // Preserve the original failure; the next write cleans up any residual temporary file.
    }
  }
}
export const writeAtomicDurable = writeAtomic;
