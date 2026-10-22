import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AssistantError } from '../contracts/errors.js';
import { sha256 } from './stable-json.js';

export async function ensureDir(dir: string): Promise<void> { await mkdir(dir, { recursive: true }); }

export type AtomicWriteHooks = { afterTempWrite?: (file: string) => Promise<void>; beforeRename?: (file: string) => Promise<void> };

export async function atomicWrite(file: string, data: string, hooks?: AtomicWriteHooks): Promise<void> {
  await ensureDir(path.dirname(file));
  const temp = `${file}.tmp-${randomUUID()}`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(data, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await hooks?.afterTempWrite?.(file);
    await hooks?.beforeRename?.(file);
    await rename(temp, file);
    await syncDirectory(path.dirname(file));
  } catch {
    await rm(temp, { force: true }).catch(() => undefined);
    throw new AssistantError('MAINTENANCE_REQUIRED', `无法原子替换 ${path.basename(file)}；旧版本已保留。`);
  }
}

export async function syncDirectory(dir: string): Promise<void> {
  let handle;
  try { handle = await open(dir, constants.O_RDONLY); await handle.sync(); }
  catch { /* Windows does not expose directory fsync consistently. File fsync and rename remain mandatory. */ }
  finally { await handle?.close().catch(() => undefined); }
}

export async function readJson<T>(file: string): Promise<T> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch { throw new AssistantError('CORRUPT_DATA', `无法读取或解析 ${path.basename(file)}。`); }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function assertSafeFile(root: string, relativePath: string, maxBytes: number): Promise<{ absolute: string; size: number }> {
  if (!relativePath || path.isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) throw new AssistantError('OUT_OF_SCOPE');
  const parts = relativePath.split(/[\\/]+/);
  if (parts.some((part) => part === '..' || part === '.' || part === '')) throw new AssistantError('OUT_OF_SCOPE');
  const base = await realpath(root);
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    const info = await lstat(current).catch(() => null);
    if (!info) throw new AssistantError('NOT_FOUND');
    if (info.isSymbolicLink()) throw new AssistantError('OUT_OF_SCOPE', 'Worker 不读取符号链接或重解析点。');
  }
  const absolute = await realpath(current);
  if (!absolute.startsWith(`${base}${path.sep}`)) throw new AssistantError('OUT_OF_SCOPE');
  const info = await stat(absolute);
  if (!info.isFile()) throw new AssistantError('INVALID_INPUT', '只能读取普通文件。');
  if (info.size > maxBytes) throw new AssistantError('BUDGET_EXCEEDED', `文件超过 ${maxBytes} 字节限制。`);
  return { absolute, size: info.size };
}

export async function assertSafeDirectory(root: string, relativePath: string): Promise<string> {
  const base = await realpath(root);
  if (!relativePath) return base;
  if (path.isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) throw new AssistantError('OUT_OF_SCOPE');
  const parts = relativePath.split(/[\\/]+/);
  if (parts.some((part) => part === '..' || part === '.' || part === '')) throw new AssistantError('OUT_OF_SCOPE');
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    const info = await lstat(current).catch(() => null);
    if (!info) throw new AssistantError('NOT_FOUND');
    if (info.isSymbolicLink()) throw new AssistantError('OUT_OF_SCOPE', 'Worker 不读取符号链接或重解析点。');
    if (!info.isDirectory()) throw new AssistantError('INVALID_INPUT', '目标必须是项目内目录。');
  }
  const absolute = await realpath(current);
  if (!absolute.startsWith(`${base}${path.sep}`)) throw new AssistantError('OUT_OF_SCOPE');
  return absolute;
}

export async function readLines(file: string, start: number, count: number): Promise<{ text: string; hash: string; totalLines: number }> {
  const body = await readFile(file, 'utf8');
  const lines = body.split(/\r?\n/);
  return { text: lines.slice(start - 1, start - 1 + count).join('\n'), hash: sha256(body), totalLines: lines.length };
}
