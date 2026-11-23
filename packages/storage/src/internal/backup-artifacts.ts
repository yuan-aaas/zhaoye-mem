import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type BackupManifest, BackupManifestSchema, ZhaoyeError } from '@zhaoye/contracts';
import { readJson } from '../atomic-fs.js';

export const backupManifestPath = (batchId: string) => `backup/exports/${batchId}/manifest.json`;

export async function fileDigest(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest('hex') };
}

export async function readBackupManifest(root: string, batchId: string): Promise<BackupManifest> {
  if (!BackupManifestSchema.shape.batchId.safeParse(batchId).success)
    throw new ZhaoyeError('INTEGRITY_FAILED', '批次原件路径的 ID 不合法');
  const relative = backupManifestPath(batchId);
  const path = join(root, relative);
  try {
    for (const part of ['backup', 'backup/exports', `backup/exports/${batchId}`]) {
      if (!(await lstat(join(root, part))).isDirectory())
        throw new ZhaoyeError('INTEGRITY_FAILED', '原件目录不合法', { path: part });
    }
    if (!(await lstat(path)).isFile())
      throw new ZhaoyeError('INTEGRITY_FAILED', '原件清单必须为普通文件', { path: relative });
    const manifest = await readJson(path, BackupManifestSchema);
    if (manifest.batchId !== batchId)
      throw new ZhaoyeError('INTEGRITY_FAILED', '原件与批次不匹配', { path: relative });
    const artifact = join(dirname(path), manifest.artifact.name);
    if (!(await lstat(artifact)).isFile())
      throw new ZhaoyeError('INTEGRITY_FAILED', '批次原件必须为普通文件', { path: relative });
    const actual = await fileDigest(artifact);
    if (actual.sha256 !== manifest.artifact.sha256 || actual.bytes !== manifest.artifact.bytes)
      throw new ZhaoyeError('INTEGRITY_FAILED', '原件摘要或大小不一致', { path: relative });
    return manifest;
  } catch (error) {
    if (error instanceof ZhaoyeError && error.code === 'INTEGRITY_FAILED') throw error;
    throw new ZhaoyeError('INTEGRITY_FAILED', '批次原件缺失或无法核验', { path: relative });
  }
}

export async function copyBackupArtifacts(
  root: string,
  destination: string,
  manifest: BackupManifest,
): Promise<void> {
  const relative = backupManifestPath(manifest.batchId);
  const target = join(destination, relative);
  await mkdir(dirname(target), { recursive: true });
  const files = [relative, join(dirname(relative), manifest.artifact.name)];
  for (const file of files)
    await copyFile(join(root, file), join(destination, file), constants.COPYFILE_EXCL);
}
