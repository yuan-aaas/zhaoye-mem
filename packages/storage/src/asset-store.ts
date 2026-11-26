import { createHash } from 'node:crypto';
import { open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  type AssetFile,
  AssetIdSchema,
  type AssetManifest,
  AssetManifestSchema,
  AssetPathSchema,
  type AssetRecord,
  type AssetStore,
  ConfigBundleManifestSchema,
  ConfigBundleWriteSchema,
  parseInput,
  ZhaoyeError,
} from '@zhaoye/contracts';
import { ensureDir, ioError, writeAtomic } from './atomic-fs.js';
import { inspectAssetPath as inspect } from './internal/asset-paths.js';
import { runBundleWrite } from './internal/config-bundle-cli.js';
import { createMutex } from './internal/mutex.js';

const bundleModules = [
  '01-skills',
  '02-rules',
  '03-memory',
  '04-commands',
  '05-snippets',
  '06-work',
  '07-knowledge',
] as const;
const bundleEntries = [
  { kind: 'readme', path: 'README.md', description: '配置包说明' },
  { kind: 'context', path: 'CONTEXT.md', description: '配置包的原始上下文文档' },
  { kind: 'cli-doc', path: '_cli/README.md', description: '原项目 CLI 的文档' },
  { kind: 'migration', path: '_meta/MIGRATION.md', description: '原项目迁移说明' },
];
const textReadBytes = 128 * 1024;
const catalogBytes = 16 * 1024 * 1024;

async function requirePath(base: string, path: string, type: 'file' | 'directory') {
  const item = await inspect(base, path);
  if (!item) throw new ZhaoyeError('NOT_FOUND', '资产路径不存在', { path });
  if (type === 'file' ? !item.info.isFile() : !item.info.isDirectory())
    throw new ZhaoyeError('INVALID_INPUT', '资产路径的类型不正确', { path, type });
  return item.absolute;
}

async function readBytes(
  absolute: string,
  maxBytes?: number,
  range?: { start: number; end: number },
) {
  try {
    const handle = await open(absolute, 'r');
    try {
      const hash = createHash('sha256');
      let bytes = 0;
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const chunks: Buffer[] = [];
      while (true) {
        const start = bytes;
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        bytes += bytesRead;
        if (maxBytes !== undefined && bytes > maxBytes)
          throw new ZhaoyeError('BUDGET_EXCEEDED', '文本超过资产读取上限', { maxBytes });
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        if (maxBytes !== undefined) chunks.push(Buffer.from(chunk));
        if (range && start < range.end && bytes > range.start)
          chunks.push(
            Buffer.from(
              chunk.subarray(
                Math.max(0, range.start - start),
                Math.min(bytesRead, range.end - start),
              ),
            ),
          );
      }
      return { bytes, sha256: hash.digest('hex'), content: Buffer.concat(chunks) };
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw ioError(error, absolute);
  }
}

function decode(raw: Buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new ZhaoyeError('INVALID_INPUT', '资产正文需要以 UTF-8 读取；其他格式可读取字节');
  }
}

function parseJson<T>(content: Buffer, absolute: string, schema: { parse(input: unknown): T }) {
  try {
    return schema.parse(JSON.parse(decode(content)));
  } catch {
    throw new ZhaoyeError('CORRUPT_DATA', '资产清单无法读取或格式不受支持', { path: absolute });
  }
}

async function scanBundlePaths(
  bundle: string,
  manifest: ReturnType<typeof ConfigBundleManifestSchema.parse>,
) {
  const paths: string[] = [];
  async function walk(directory = '') {
    const absolute = directory ? await requirePath(bundle, directory, 'directory') : bundle;
    const entries = await readdir(absolute, { withFileTypes: true }).catch((e: unknown) => {
      throw ioError(e, absolute);
    });
    for (const entry of entries) {
      if (entry.name.toLowerCase() === '.git') continue;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      parseInput(AssetPathSchema, path);
      if (entry.isDirectory()) await walk(path);
      else {
        await requirePath(bundle, path, 'file');
        paths.push(path);
        if (paths.length > 10000)
          throw new ZhaoyeError('BUDGET_EXCEEDED', '资产文件数超过清单上限');
      }
    }
  }
  for (const module of bundleModules) {
    const entry = manifest.modules[module];
    if (!entry) continue;
    if (entry.path !== module && entry.path !== `${module}/`)
      throw new ZhaoyeError('CORRUPT_DATA', '配置包模块路径与目录约定不一致', { module });
    await requirePath(bundle, module, 'directory');
  }
  await walk();
  return paths.sort();
}

export function createAssetStore(
  dataRoot: string,
  {
    now = () => new Date(),
    assertOwner = async () => {},
  }: {
    now?: () => Date;
    assertOwner?: () => Promise<void>;
  } = {},
): AssetStore {
  const serialized = createMutex();
  async function root() {
    return realpath(dataRoot).catch((e: unknown) => {
      throw ioError(e, dataRoot);
    });
  }
  async function existing(base: string): Promise<AssetManifest | null> {
    const file = await inspect(base, 'assets/manifest.json');
    if (!file) return null;
    if (!file.info.isFile()) throw new ZhaoyeError('CORRUPT_DATA', '资产清单路径必须是文件');
    const { content } = await readBytes(file.absolute, catalogBytes);
    return parseJson(content, file.absolute, AssetManifestSchema);
  }
  async function directories(base: string) {
    for (const folder of ['assets', 'assets/files']) {
      if (!(await inspect(base, folder))) await ensureDir(join(base, folder));
      await requirePath(base, folder, 'directory');
    }
  }
  async function scan() {
    const manifest = await existing(await root());
    if (!manifest) throw new ZhaoyeError('NOT_FOUND', '个人资产库尚未初始化');
    return manifest;
  }
  async function resolveAsset(assetId: string) {
    const id = parseInput(AssetIdSchema, assetId);
    const asset = (await scan()).assets.find((entry) => entry.asset_id === id);
    if (!asset) throw new ZhaoyeError('NOT_FOUND', '资产未登记', { assetId });
    return asset;
  }
  async function verifyFile(
    base: string,
    id: string,
    file: AssetFile,
    maxBytes?: number,
    range?: { start: number; end: number },
  ) {
    const absolute = await requirePath(base, `assets/files/${id}/${file.path}`, 'file');
    const actual = await readBytes(absolute, maxBytes, range);
    if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes)
      throw new ZhaoyeError('INTEGRITY_FAILED', '资产文件与登记摘要不一致', { path: file.path });
    return actual.content;
  }
  async function findFile(assetId: string, path: string) {
    const key = parseInput(AssetPathSchema, path);
    const asset = await resolveAsset(assetId);
    const file = asset.files.find((entry) => entry.path === key);
    if (!file) throw new ZhaoyeError('NOT_FOUND', '资产文件未登记', { path: key });
    return file;
  }
  async function register(inputId: string) {
    await assertOwner();
    const assetId = parseInput(AssetIdSchema, inputId);
    const base = await root();
    const bundle = await requirePath(base, `assets/files/${assetId}`, 'directory');
    const manifestPath = await requirePath(bundle, 'manifest.json', 'file');
    const nativeManifest = await readBytes(manifestPath, 1024 * 1024);
    const source = parseJson(nativeManifest.content, manifestPath, ConfigBundleManifestSchema);
    const paths = await scanBundlePaths(bundle, source);
    const files: AssetFile[] = [];
    for (const path of paths) {
      const { bytes, sha256 } =
        path === 'manifest.json'
          ? nativeManifest
          : await readBytes(await requirePath(bundle, path, 'file'));
      files.push({ path, bytes, sha256 });
    }
    const registered = (await existing(base)) ?? { schema_version: 1, assets: [] };
    const former = registered.assets.find((asset) => asset.asset_id === assetId);
    const at = now().toISOString();
    const entry: AssetRecord = {
      asset_id: assetId,
      kind: 'config',
      name: source.name,
      version: source.version,
      description: source.description,
      source: `files/${assetId}/manifest.json`,
      files,
      entrypoints: bundleEntries.filter(({ path }) => paths.includes(path)),
      dependencies: [],
      permissions: ['read'],
      created_at: former?.created_at ?? at,
      updated_at: former?.updated_at ?? at,
    };
    if (isDeepStrictEqual(entry, former)) return entry;
    entry.updated_at = at;
    const assets = former
      ? registered.assets.map((asset) => (asset.asset_id === assetId ? entry : asset))
      : [...registered.assets, entry];
    const manifest = parseInput(AssetManifestSchema, { schema_version: 1, assets });
    const encoded = `${JSON.stringify(manifest, null, 2)}\n`;
    if (Buffer.byteLength(encoded) > catalogBytes)
      throw new ZhaoyeError('BUDGET_EXCEEDED', '资产清单超过存储上限');
    await assertOwner();
    await writeAtomic(join(base, 'assets/manifest.json'), encoded);
    return entry;
  }
  return {
    scan,
    resolveAsset,
    readFile: async (assetId, path) => {
      const file = await findFile(assetId, path);
      return {
        file,
        content: decode(await verifyFile(await root(), assetId, file, textReadBytes)),
      };
    },
    readBytes: async (assetId, path, offset, length) => {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 1 ||
        length > 4096
      )
        throw new ZhaoyeError('INVALID_INPUT', '字节读取范围无效');
      const file = await findFile(assetId, path);
      if (offset > file.bytes) throw new ZhaoyeError('INVALID_INPUT', '字节偏移超出文件大小');
      const end = Math.min(file.bytes, offset + length);
      const bytes = await verifyFile(await root(), assetId, file, undefined, {
        start: offset,
        end,
      });
      return { file, base64: bytes.toString('base64'), next_offset: end < file.bytes ? end : null };
    },
    verify: async (assetId) => {
      const asset = await resolveAsset(assetId);
      const base = await root();
      for (const file of asset.files) await verifyFile(base, assetId, file);
      return { asset_id: assetId, files: asset.files.length, verified: true };
    },
    initialize: () =>
      serialized(async () => {
        await assertOwner();
        const base = await root();
        const manifest = await existing(base);
        await directories(base);
        if (manifest) return { created: false };
        await assertOwner();
        await writeAtomic(join(base, 'assets/manifest.json'), '{"schema_version":1,"assets":[]}\n');
        return { created: true };
      }),
    registerConfigBundle: (id) => serialized(() => register(id)),
    writeConfigBundle: (id, input, python) =>
      serialized(async () => {
        await assertOwner();
        const operation = parseInput(ConfigBundleWriteSchema, input);
        const asset = await resolveAsset(id);
        if (asset.asset_id !== 'ai-config-bundle' || asset.kind !== 'config')
          throw new ZhaoyeError('INVALID_INPUT', '该资产没有配置包写入接口');
        const base = await root();
        const bundle = await requirePath(base, `assets/files/${asset.asset_id}`, 'directory');
        const script = await findFile(id, '_cli/bundle.py');
        const native = await findFile(id, 'manifest.json');
        await verifyFile(base, id, script);
        const metadata = parseJson(
          await verifyFile(base, id, native, 1024 * 1024),
          native.path,
          ConfigBundleManifestSchema,
        );
        if (operation.action !== 'archive') {
          const module = operation.path.split('/')[0];
          if (
            module === undefined ||
            !bundleModules.some((m) => m === module) ||
            !metadata.modules[module]
          )
            throw new ZhaoyeError('INVALID_INPUT', '写入路径必须属于原生清单声明的模块');
        }
        if (operation.action === 'update' || operation.action === 'delete') {
          const file = await findFile(id, operation.path);
          if (operation.sha256 !== file.sha256)
            throw new ZhaoyeError('CONFLICT', '资产版本已变化，请重新读取文件');
          await verifyFile(base, id, file);
        }
        const path = await runBundleWrite(bundle, python, operation);
        try {
          await register(id);
        } catch {
          throw new ZhaoyeError('COMMIT_UNKNOWN', '配置包已写入，资产清单需重新登记', { path });
        }
        return { asset_id: id, action: operation.action, path };
      }),
  };
}
