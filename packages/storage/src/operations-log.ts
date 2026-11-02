import { open } from 'node:fs/promises';
import { LIMITS, ZhaoyeError } from '@zhaoye/contracts';
import { ioError, readText, writeAtomic } from './atomic-fs.js';
export async function readLines<T>(
  path: string,
  schema: { parse: (v: unknown) => T },
  allowPartialTail = false,
): Promise<T[]> {
  const raw = await readText(path);
  if (raw === null || raw === '') return [];
  const lines = raw.split('\n');
  const terminated = lines.at(-1) === '';
  if (terminated) lines.pop();
  const out: T[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      out.push(schema.parse(JSON.parse(lines[i] ?? '')));
    } catch (e) {
      if (allowPartialTail && !terminated && i === lines.length - 1) break;
      throw new ZhaoyeError('CORRUPT_DATA', '记录文件包含损坏行', {
        path,
        line: i + 1,
        cause: String(e),
      });
    }
  }
  return out;
}
export async function appendOperation(path: string, value: unknown): Promise<void> {
  try {
    let raw = (await readText(path)) ?? '';
    // A crash tail has already been validated by findOperation; discard only the incomplete last line.
    if (raw && !raw.endsWith('\n')) {
      try {
        JSON.parse(raw.slice(raw.lastIndexOf('\n') + 1));
        raw += '\n';
      } catch {
        raw = raw.slice(0, raw.lastIndexOf('\n') + 1);
      }
      await writeAtomic(path, raw);
    }
    if (raw.split('\n').length - 1 >= LIMITS.operationLines) {
      await writeAtomic(path.replace(/\.jsonl$/, '.1.jsonl'), raw);
      await writeAtomic(path, '');
    }
    const h = await open(path, 'a');
    try {
      await h.writeFile(`${JSON.stringify(value)}\n`);
      await h.sync();
    } finally {
      await h.close();
    }
  } catch (e) {
    throw ioError(e, path);
  }
}
