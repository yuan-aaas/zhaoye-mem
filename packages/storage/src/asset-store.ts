import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { extname, join } from 'node:path';
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
  parseInput,
  ZhaoyeError,
} from '@zhaoye/contracts';
import { ensureDir, ioError, isMissing, writeAtomic } from './atomic-fs.js';
import { createMutex } from './internal/mutex.js';

const bundleModules = [
  '01-skills',
  '02-rules',
  '03-memory',
  '04-commands',
  '05-snippets',
  '07-knowledge',
] as const;
const bundleEntries = [
  { kind: 'readme', path: 'README.md', description: '配置包说明' },
  { kind: 'context', path: 'CONTEXT.md', description: '配置包的原始上下文文档' },
  { kind: 'cli-doc', path: '_cli/README.md', description: '原项目 CLI 的文档' },
  { kind: 'migration', path: '_meta/MIGRATION.md', description: '原项目迁移说明' },
];
const omittedDirectories = new Set(['__pycache__', 'node_modules']);
const omittedExtensions = new Set(['.bak', '.pyc']);
const textExtensions = new Set([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.css',
  '.html',
  '.js',
  '.ts',
  '.py',
  '.ps1',
  '.sh',
  '.dart',
  '.vue',
  '.xml',
  '.toml',
  '.csv',
]);
const textReadBytes = 128 * 1024;
const catalogBytes = 16 * 1024 * 1024;

// Check every component to reject directory junctions and symlinks as well as linked files.
async function inspect(base: string, path: string) {
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

async function requirePath(base: string, path: string, type: 'file' | 'directory') {
  const item = await inspect(base, path);
  if (!item) throw new ZhaoyeError('NOT_FOUND', '资产路径不存在', { path });
  if (type === 'file' ? !item.info.isFile() : !item.info.isDirectory())
    throw new ZhaoyeError('INVALID_INPUT', '资产路径的类型不正确', { path, type });
  return item.absolute;
}

async function readBytes(absolute: string, maxBytes?: number) {
  try {
    const handle = await open(absolute, 'r');
    try {
      const hash = createHash('sha256');
      let bytes = 0;
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const chunks: Buffer[] = [];
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        bytes += bytesRead;
        if (maxBytes !== undefined && bytes > maxBytes)
          throw new ZhaoyeError('BUDGET_EXCEEDED', '文本超过资产读取上限', { maxBytes });
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        if (maxBytes !== undefined) chunks.push(Buffer.from(chunk));
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
    throw new ZhaoyeError('INVALID_INPUT', '资产正文必须是 UTF-8 文本');
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
  const paths = ['manifest.json'];
  for (const { path } of bundleEntries) {
    if (await inspect(bundle, path)) paths.push(path);
  }
  async function walk(directory: string) {
    const absolute = await requirePath(bundle, directory, 'directory');
    const entries = await readdir(absolute, { withFileTypes: true }).catch((e: unknown) => {
      throw ioError(e, absolute);
    });
    for (const entry of entries) {
      const name = entry.name.toLowerCase();
      if (
        name.startsWith('.') ||
        omittedDirectories.has(name) ||
        (directory === '07-knowledge' && name === 'daily') ||
        omittedExtensions.has(extname(name))
      )
        continue;
      const path = `${directory}/${entry.name}`;
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
    await walk(module);
  }
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
  async function verifyFile(base: string, id: string, file: AssetFile, maxBytes?: number) {
    const absolute = await requirePath(base, `assets/files/${id}/${file.path}`, 'file');
    const actual = await readBytes(absolute, maxBytes);
    if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes)
      throw new ZhaoyeError('INTEGRITY_FAILED', '资产文件与登记摘要不一致', { path: file.path });
    return actual.content;
  }
  return {
    scan,
    resolveAsset,
    readFile: async (assetId, path) => {
      const key = parseInput(AssetPathSchema, path);
      const asset = await resolveAsset(assetId);
      const file = asset.files.find((entry) => entry.path === key);
      if (!file) throw new ZhaoyeError('NOT_FOUND', '资产文件未登记', { path: key });
      if (asset.kind === 'config' && key === 'manifest.json')
        throw new ZhaoyeError('UNAUTHORIZED', '原生配置包清单包含机器路径，仅登记摘要');
      if (!textExtensions.has(extname(key).toLowerCase()))
        throw new ZhaoyeError('INVALID_INPUT', '该格式仅支持资产定位和摘要校验', { path: key });
      return {
        file,
        content: decode(await verifyFile(await root(), assetId, file, textReadBytes)),
      };
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
    registerConfigBundle: (inputId) =>
      serialized(async () => {
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
      }),
  };
}
