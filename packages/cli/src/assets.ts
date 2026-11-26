import { parseArgs } from 'node:util';
import { createZhaoye, openAssetLibrary } from '@zhaoye/app';
import { ZhaoyeError } from '@zhaoye/contracts';
import { cliHost } from './backup.js';

const commands = {
  init: [0, []],
  'register-config-bundle': [1, []],
  list: [0, ['query', 'limit', 'offset']],
  files: [1, ['query', 'limit', 'offset']],
  read: [2, []],
  verify: [1, []],
} as const;

function parseOptions(args: string[]) {
  try {
    return parseArgs({
      args,
      allowPositionals: true,
      options: {
        'data-root': { type: 'string' },
        json: { type: 'boolean' },
        query: { type: 'string' },
        limit: { type: 'string' },
        offset: { type: 'string' },
      },
    });
  } catch {
    throw new ZhaoyeError('INVALID_INPUT', 'assets 命令参数无效');
  }
}

export async function runAssets(args: string[]) {
  const [command, ...rest] = args;
  if (command === undefined || !Object.hasOwn(commands, command))
    throw new ZhaoyeError('INVALID_INPUT', '未知 assets 子命令');
  const [arity, allowed] = commands[command as keyof typeof commands];
  const { positionals, values } = parseOptions(rest);
  const keys: readonly string[] = ['data-root', 'json', ...allowed];
  if (positionals.length !== arity || Object.keys(values).some((key) => !keys.includes(key)))
    throw new ZhaoyeError('INVALID_INPUT', 'assets 命令参数不匹配');
  const dataRoot = values['data-root'];
  if (dataRoot === '') throw new ZhaoyeError('INVALID_INPUT', '--data-root 缺少路径');
  const [assetId = '', path = ''] = positionals;
  if (command === 'init' || command === 'register-config-bundle') {
    const app = await createZhaoye({
      host: cliHost,
      initIfMissing: false,
      ...(dataRoot !== undefined ? { dataRoot } : {}),
    });
    try {
      if (command === 'init') return await app.assets.initialize();
      const asset = await app.assets.registerConfigBundle(assetId);
      return { asset_id: asset.asset_id, version: asset.version, files: asset.files.length };
    } finally {
      await app.close();
    }
  }
  const assets = await openAssetLibrary(dataRoot);
  const options = {
    query: values.query,
    limit: pageNumber(values.limit),
    offset: pageNumber(values.offset),
  };
  if (command === 'list') return assets.list(options);
  if (command === 'files') return assets.files(assetId, options);
  if (command === 'read') return assets.read(assetId, path);
  return assets.verify(assetId);
}

function pageNumber(value: string | undefined) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new ZhaoyeError('INVALID_INPUT', '分页参数必须为非负整数');
  return Number(value);
}
