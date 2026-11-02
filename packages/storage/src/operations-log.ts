import { open } from 'node:fs/promises';
import { LIMITS, ZhaoyeError } from '@zhaoye/contracts';
import { ioError, readText, writeAtomic } from './atomic-fs.js';

type LineSchema<T> = { parse: (v: unknown) => T };

// Node 24 reports truncated JSON either as unexpected EOF or as an error at the
// end offset. Errors inside the input and schema errors are corruption, not crash tails.
function incompleteJson(error: unknown, text: string): boolean {
  if (!(error instanceof SyntaxError)) return false;
  if (error.message.includes('Unexpected end of JSON input')) return true;
  const position = /at position (\d+)/.exec(error.message);
  return position !== null && Number(position[1]) >= text.length;
}
function decodeLines<T>(
  raw: string,
  path: string,
  schema: LineSchema<T>,
  allowPartialTail: boolean,
) {
  const values: T[] = [];
  if (!raw) return { values, completeRaw: '' };
  const lines = raw.split('\n');
  const terminated = lines.at(-1) === '';
  if (terminated) lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (e) {
      if (allowPartialTail && !terminated && i === lines.length - 1 && incompleteJson(e, line)) {
        return { values, completeRaw: i === 0 ? '' : `${lines.slice(0, i).join('\n')}\n` };
      }
      throw new ZhaoyeError('CORRUPT_DATA', '记录文件包含损坏行', {
        path,
        line: i + 1,
        cause: String(e),
      });
    }
    try {
      values.push(schema.parse(value));
    } catch (e) {
      throw new ZhaoyeError('CORRUPT_DATA', '记录文件不符合契约', {
        path,
        line: i + 1,
        cause: String(e),
      });
    }
  }
  return { values, completeRaw: terminated ? raw : `${raw}\n` };
}
export async function readLines<T>(
  path: string,
  schema: LineSchema<T>,
  allowPartialTail = false,
): Promise<T[]> {
  return decodeLines((await readText(path)) ?? '', path, schema, allowPartialTail).values;
}
export async function appendOperation(
  path: string,
  value: unknown,
  schema: LineSchema<unknown> = { parse: (v) => v },
): Promise<void> {
  try {
    const original = (await readText(path)) ?? '';
    // Reading and repairing use the same distinction between crash tails and corruption.
    const decoded = decodeLines(original, path, schema, true);
    schema.parse(value);
    if (decoded.completeRaw !== original) await writeAtomic(path, decoded.completeRaw);
    if (decoded.values.length >= LIMITS.operationLines) {
      await writeAtomic(path.replace(/\.jsonl$/, '.1.jsonl'), decoded.completeRaw);
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
