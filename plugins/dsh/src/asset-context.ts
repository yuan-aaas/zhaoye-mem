import type { openAssetLibrary } from '@zhaoye/app';
import { BUDGETS, ZhaoyeError } from '@zhaoye/contracts';
import { pageContent } from './identity-context.js';

type Library = Awaited<ReturnType<typeof openAssetLibrary>>;

function parseOffset(offset: string | undefined) {
  if (offset !== undefined && !/^(?:0|[1-9]\d{0,11})$/.test(offset)) {
    throw new ZhaoyeError('INVALID_INPUT', 'offset 必须是非负整数');
  }
  return Number(offset ?? 0);
}

export async function findAssets(
  library: Library,
  args: { asset_id?: string | undefined; query?: string | undefined; offset?: string | undefined },
) {
  const offset = parseOffset(args.offset);
  const options = { query: args.query, offset, limit: 3 };
  if (args.asset_id === undefined) {
    const page = await library.list(options);
    const items = page.items.map(({ asset_id, name, file_count }) => ({
      asset_id,
      name: [...name].slice(0, 32).join(''),
      file_count,
    }));
    return { items, next_offset: page.next_offset === null ? null : String(page.next_offset) };
  }
  const page = await library.files(args.asset_id, options);
  const result = {
    asset_id: args.asset_id,
    items: page.items.map(({ path }) => path),
    next_offset: page.next_offset === null ? null : String(page.next_offset),
  };
  while ([...JSON.stringify(result)].length > BUDGETS.toolResultCodePoints) {
    result.items.pop();
    result.next_offset = String(offset + result.items.length);
  }
  return result;
}

export async function readAsset(
  library: Library,
  args: {
    asset_id: string;
    path: string;
    sha256?: string | undefined;
    offset?: string | undefined;
  },
) {
  const offset = parseOffset(args.offset);
  if (
    (offset > 0 && args.sha256 === undefined) ||
    (args.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(args.sha256))
  ) {
    throw new ZhaoyeError('INVALID_INPUT', '资产续读需要有效的 sha256');
  }
  const { file, content } = await library.read(args.asset_id, args.path);
  if (args.sha256 !== undefined && args.sha256 !== file.sha256)
    throw new ZhaoyeError('CONFLICT', '资产版本已更新，请从文件开头读取');
  return pageContent(content, offset, (text, next) => ({
    sha256: file.sha256,
    content: text,
    next_offset: next === null ? null : String(next),
  }));
}
