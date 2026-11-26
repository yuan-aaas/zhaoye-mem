import { type AssetStore, ZhaoyeError } from '@zhaoye/contracts';
import { createAssetStore, openDataRoot } from '@zhaoye/storage';

export interface AssetQuery {
  query?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

function select<T>(items: T[], search: (item: T) => string, options: AssetQuery) {
  const { limit = 20, offset = 0, query = '' } = options;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    [...query].length > 200
  ) {
    throw new ZhaoyeError('INVALID_INPUT', '资产查询参数无效');
  }
  const terms = query.normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matching = items.filter((item) => {
    const haystack = search(item).normalize('NFKC').toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  return {
    items: matching.slice(offset, offset + limit),
    next_offset: offset + limit < matching.length ? offset + limit : null,
  };
}

export function createAssetReader(store: AssetStore) {
  return {
    list: async (options: AssetQuery = {}) => {
      const { assets } = await store.scan();
      return select(
        assets.map(({ asset_id, kind, name, version, description, files }) => ({
          asset_id,
          kind,
          name,
          version,
          description,
          file_count: files.length,
        })),
        (item) => [item.asset_id, item.name, item.description].join(' '),
        options,
      );
    },
    files: async (assetId: string, options: AssetQuery = {}) => {
      const asset = await store.resolveAsset(assetId);
      return select(asset.files, ({ path }) => path, options);
    },
    read: store.readFile,
    verify: store.verify,
  };
}

export async function openAssetLibrary(dataRoot?: string) {
  const { root } = await openDataRoot(dataRoot);
  return createAssetReader(createAssetStore(root));
}
