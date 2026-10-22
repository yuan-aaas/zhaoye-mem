import { randomUUID } from 'node:crypto';
import { access, mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ManifestSchema, type Manifest } from '../contracts/schemas.js';
import { AssistantError } from '../contracts/errors.js';
import { ensureDir, readJson, syncDirectory, writeJson } from './files.js';
import { Journal } from './journal.js';
import { defaultLeadKernel } from '../memory-core/identity-templates.js';

export type Runtime = {
  root: string;
  assistantId: string;
  content: Journal;
  events: Journal;
  usageFile: string;
  close: () => Promise<void>;
};


async function exists(file: string): Promise<boolean> { try { await access(file); return true; } catch { return false; } }

export async function initRoot(rootPath: string): Promise<Manifest> {
  const root = path.resolve(rootPath);
  await mkdir(root, { recursive: true });
  const manifestFile = path.join(root, 'manifest.json');
  if (await exists(manifestFile)) {
    const existing = await validateManifest(manifestFile);
    await verifyIdentity(root);
    return existing;
  }
  const entries = await readdir(root);
  if (entries.length) throw new AssistantError('CONFLICT', '目标目录非空且没有有效 manifest.json；拒绝覆盖。');
  const manifest: Manifest = { format: 'assistant-data', schema_version: 2, assistant_id: randomUUID(), created_at: new Date().toISOString() };
  for (const dir of ['identity/versions/000001', 'config', 'data/user-explicit', 'state', 'index/user-explicit']) await ensureDir(path.join(root, dir));
  await writeFile(path.join(root, 'identity/versions/000001/kernel.md'), defaultLeadKernel, { flag: 'wx' });
  await writeJson(path.join(root, 'identity/versions/000001/user-profile.json'), { display_name: null, facts: [] });
  await writeJson(path.join(root, 'identity/versions/000001/habits.json'), { templates: ['lead-first', 'concise', 'show-evidence', 'ask-when-unclear'] });
  const hashes = await snapshotHashes(path.join(root, 'identity/versions/000001'));
  const identityHash = hashes.combined;
  await writeJson(path.join(root, 'identity/versions/000001/snapshot.json'), { revision: 1, identity_hash: identityHash, file_hashes: hashes.files, proposal_id: null, previous_revision: null, created_at: manifest.created_at });
  await writeJson(path.join(root, 'identity/current.json'), { revision: 1, identity_hash: identityHash });
  await writeJson(path.join(root, 'config/sources.json'), { schema_version: 2, sources: [{ source_id: 'user-explicit', provider_id: 'local-explicit', dataset_id: 'records', capabilities: { stableIds: true, revisions: true, generation: true, tombstones: true, incremental: true } }] });
  await writeFile(path.join(root, 'data/user-explicit/records.jsonl'), '', { flag: 'wx' });
  await writeFile(path.join(root, 'state/events.jsonl'), '', { flag: 'wx' });
  await writeFile(path.join(root, 'state/usage.jsonl'), '', { flag: 'wx' });
  await writeJson(manifestFile, manifest);
  return manifest;
}

export async function validateManifest(file: string): Promise<Manifest> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(file, 'utf8')); } catch { throw new AssistantError('CORRUPT_DATA', 'manifest.json 无法读取。'); }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) throw new AssistantError('CORRUPT_DATA', 'manifest.json 格式或版本不受支持。');
  return parsed.data;
}

async function snapshotHashes(dir: string): Promise<{ files: Record<string, string>; combined: string }> {
  const { readFile } = await import('node:fs/promises');
  const { sha256, canonicalize } = await import('./stable-json.js');
  const contents: Record<string, string> = {};
  for (const name of ['kernel.md', 'user-profile.json', 'habits.json']) contents[name] = sha256(await readFile(path.join(dir, name)));
  return { files: contents, combined: sha256(canonicalize(contents)) };
}

export async function verifyIdentity(root: string): Promise<{ revision: number; identity_hash: string; kernel: string; user_profile: unknown; habits: unknown }> {
  const pointer = await readJson<{ revision: number; identity_hash: string }>(path.join(root, 'identity/current.json'));
  if (!Number.isSafeInteger(pointer.revision) || pointer.revision < 1) throw new AssistantError('CORRUPT_DATA', '画像指针 revision 无效。');
  for (let revision = pointer.revision; revision >= 1; revision -= 1) {
    const versionDir = path.join(root, 'identity/versions', String(revision).padStart(6, '0'));
    const snapshot = await readJson<{ revision: number; identity_hash: string; file_hashes: Record<string, string>; previous_revision: number | null }>(path.join(versionDir, 'snapshot.json'));
    const actual = await snapshotHashes(versionDir);
    if (snapshot.revision !== revision || actual.combined !== snapshot.identity_hash || JSON.stringify(actual.files) !== JSON.stringify(snapshot.file_hashes)) throw new AssistantError('CORRUPT_DATA', `画像版本 ${revision} hash 校验失败；停止模型请求。`);
    if (revision === pointer.revision && snapshot.identity_hash !== pointer.identity_hash) throw new AssistantError('CORRUPT_DATA', '当前画像指针 hash 不匹配；停止模型请求。');
    if ((revision === 1 && snapshot.previous_revision !== null) || (revision > 1 && snapshot.previous_revision !== revision - 1)) throw new AssistantError('CORRUPT_DATA', '画像版本链断裂；停止模型请求。');
  }
  const dir = path.join(root, 'identity/versions', String(pointer.revision).padStart(6, '0'));
  const snapshot = await readJson<{ revision: number; identity_hash: string; file_hashes: Record<string, string> }>(path.join(dir, 'snapshot.json'));
  const actual = await snapshotHashes(dir);
  if (snapshot.revision !== pointer.revision || snapshot.identity_hash !== pointer.identity_hash || actual.combined !== pointer.identity_hash || JSON.stringify(actual.files) !== JSON.stringify(snapshot.file_hashes)) throw new AssistantError('CORRUPT_DATA', '当前画像快照 hash 校验失败；停止模型请求。');
  return { revision: pointer.revision, identity_hash: pointer.identity_hash, kernel: await readFile(path.join(dir, 'kernel.md'), 'utf8'), user_profile: await readJson(path.join(dir, 'user-profile.json')), habits: await readJson(path.join(dir, 'habits.json')) };
}

export async function openRuntime(rootPath: string): Promise<Runtime> {
  const root = path.resolve(rootPath);
  const manifest = await validateManifest(path.join(root, 'manifest.json'));
  await verifyIdentity(root);
  const lockPath = path.join(root, '.writer.lock');
  let acquired = false;
  try {
    await mkdir(lockPath);
    acquired = true;
    const handle = await open(path.join(lockPath, 'owner.json'), 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), assistant_id: manifest.assistant_id })); await handle.sync(); } finally { await handle.close(); }
  } catch {
    if (acquired) await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    throw new AssistantError('LOCKED', `数据目录已锁定。检查 ${lockPath}，不会自动抢占遗留锁。`);
  }
  const events = new Journal(path.join(root, 'state/events.jsonl'), 100_000, 64 * 1024 * 1024);
  const content = new Journal(path.join(root, 'data/user-explicit/records.jsonl'), 10_000, 32 * 1024 * 1024);
  try {
    await Promise.all([events.replay(), content.replay()]);
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return {
    root, assistantId: manifest.assistant_id, content, events,
    usageFile: path.join(root, 'state/usage.jsonl'),
    close: async () => { await rm(lockPath, { recursive: true, force: true }); },
  };
}
