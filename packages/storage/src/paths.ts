import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { ZhaoyeError } from '@zhaoye/contracts';
export const resolveDataRoot = (path?: string) => resolve(path ?? resolve(homedir(), '.zhaoye'));
export function resolveRelative(root: string, path: string): string {
  if (isAbsolute(path) || /^[a-z]:/i.test(path) || path.split(/[\\/]/).includes('..'))
    throw new ZhaoyeError('INVALID_INPUT', '路径必须在数据根内', { path });
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new ZhaoyeError('INVALID_INPUT', '路径越界', { path });
  return target;
}
