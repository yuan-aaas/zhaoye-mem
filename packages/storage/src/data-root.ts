import { randomUUID } from 'node:crypto';
import { open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ClockPort,
  createDefaultIdentity,
  type DataManifest,
  DataManifestSchema,
  IdentityDocumentSchema,
  serializeIdentityDocument,
  ZhaoyeError,
} from '@zhaoye/contracts';
import {
  ensureDir,
  hashBytes,
  ioError,
  isMissing,
  readJson,
  readText,
  writeAtomic,
} from './atomic-fs.js';
import { resolveDataRoot } from './paths.js';
export async function openDataRoot(
  dataRoot?: string,
): Promise<{ root: string; manifest: DataManifest }> {
  const root = resolveDataRoot(dataRoot);
  let names: string[];
  try {
    names = await readdir(root);
  } catch (e) {
    if (isMissing(e)) throw new ZhaoyeError('NOT_FOUND', '数据根不存在', { path: root });
    throw ioError(e, root);
  }
  if (names.includes('journal') || names.includes('projections'))
    throw new ZhaoyeError('SCHEMA_MIGRATION_REQUIRED', '检测到旧版数据根', { path: root });
  const raw = await readText(join(root, 'manifest.json'));
  if (raw === null) throw new ZhaoyeError('CORRUPT_DATA', '数据根缺少 manifest', { path: root });
  let version: unknown;
  try {
    version = (JSON.parse(raw) as { schema_version: unknown }).schema_version;
  } catch {
    throw new ZhaoyeError('CORRUPT_DATA', 'manifest 损坏', { path: root });
  }
  if (version !== 1)
    throw new ZhaoyeError('SCHEMA_MIGRATION_REQUIRED', '数据根 schema 版本不支持', { path: root });
  const manifest = await readJson(join(root, 'manifest.json'), DataManifestSchema);
  const identity = await readJson(join(root, 'identity/identity.json'), IdentityDocumentSchema);
  if (identity.assistant_id !== manifest.assistant_id)
    throw new ZhaoyeError('CORRUPT_DATA', '身份与数据根不匹配', { path: root });
  return { root, manifest };
}
export async function ensureDataRoot(
  dataRoot: string | undefined,
  clock: ClockPort,
  render: (doc: ReturnType<typeof createDefaultIdentity>) => string,
) {
  const root = resolveDataRoot(dataRoot);
  await ensureDir(root);
  const lockPath = join(root, '.tmp-init-lock');
  let lock: Awaited<ReturnType<typeof open>>;
  try {
    lock = await open(lockPath, 'wx');
  } catch (e) {
    if (!(typeof e === 'object' && e !== null && 'code' in e && e.code === 'EEXIST'))
      throw ioError(e, lockPath);
    throw new ZhaoyeError('LOCKED', '数据根正在初始化或存在中断的初始化锁', { path: lockPath });
  }
  try {
    let names: string[] = [];
    try {
      names = (await readdir(root)).filter((n) => n !== '.tmp-init-lock');
    } catch (e) {
      if (!isMissing(e)) throw ioError(e, root);
    }
    if (names.length) {
      if (names.every((n) => n.startsWith('.tmp-')))
        throw new ZhaoyeError('CORRUPT_DATA', '存在未完成的初始化', { path: root });
      return { ...(await openDataRoot(root)), created: false };
    }
    await ensureDir(root);
    const at = clock.now().toISOString();
    const assistant_id = randomUUID();
    const manifest: DataManifest = {
      format: 'zhaoye-data',
      schema_version: 1,
      assistant_id,
      created_at: at,
    };
    const doc = createDefaultIdentity(assistant_id, at);
    const bytes = serializeIdentityDocument(doc);
    await ensureDir(join(root, 'presence'));
    await writeAtomic(join(root, 'identity/identity.json'), bytes);
    await writeAtomic(join(root, 'identity/versions/000000000001.json'), bytes);
    await writeAtomic(
      join(root, 'identity/versions/index.jsonl'),
      `${JSON.stringify({
        revision: 1,
        at,
        section: 'safety_kernel',
        operation_id: randomUUID(),
        reason: 'init',
        document_hash: hashBytes(bytes),
        retained: true,
      })}\n`,
    );
    await writeAtomic(join(root, 'identity/operations.jsonl'), '');
    await writeAtomic(join(root, 'identity/identity.md'), render(doc));
    // Manifest is the final marker: interrupted initialization is never silently retried as empty.
    await writeAtomic(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return { root, manifest, created: true };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
