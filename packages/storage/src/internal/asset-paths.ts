import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { AssetPathSchema, parseInput, ZhaoyeError } from '@zhaoye/contracts';
import { ioError, isMissing } from '../atomic-fs.js';

// Inspect every component to reject junctions and symlinks.
export async function inspectAssetPath(base: string, path: string) {
  const parts = path.split('/');
  let absolute = base;
  for (const [index, part] of parts.entries()) {
    absolute = join(absolute, parseInput(AssetPathSchema, part));
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink())
        throw new ZhaoyeError('INVALID_INPUT', '资产路径含符号链接或目录联接', { path });
      if (index === parts.length - 1) return { absolute, info };
      if (!info.isDirectory())
        throw new ZhaoyeError('NOT_FOUND', '资产路径中的目录不存在', { path });
    } catch (error) {
      if (isMissing(error)) return null;
      throw ioError(error, absolute);
    }
  }
  return null;
}
