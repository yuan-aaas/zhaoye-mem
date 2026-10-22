import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AssistantError } from '../contracts/errors.js';
import { HabitsSchema, IdentityProfileSchema } from '../contracts/schemas.js';
import { atomicWrite, readJson, syncDirectory, writeJson } from '../infrastructure/files.js';
import type { Runtime } from '../infrastructure/runtime.js';
import { verifyIdentity } from '../infrastructure/runtime.js';
import { canonicalize, sha256 } from '../infrastructure/stable-json.js';
import { AdapterContextSchema, IdentityPatchSchema, IdentityValuesSchema, resolveIdentityPatch, type AdapterContext, type IdentityPatch, type IdentityPreview, type IdentitySnapshot } from '../contracts/identity.js';

export type IdentityCommitHooks = { afterFileWrite?: (name: string) => Promise<void>; beforeVersionRename?: () => Promise<void>; beforePointerReplace?: () => Promise<void> };

export type { IdentityPatch } from '../contracts/identity.js';
type PreviewOptions = { proposal_id?: string; expected_revision?: number; source?: AdapterContext };

export async function previewIdentityPatch(runtime: Runtime, raw: unknown, options: PreviewOptions = {}): Promise<IdentityPreview> {
  const requested = IdentityPatchSchema.parse(raw);
  const proposalId = z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/).parse(options.proposal_id ?? randomUUID());
  const source = options.source ? AdapterContextSchema.parse(options.source) : undefined;
  const existing = runtime.events.findOp(`identity-proposal:${proposalId}`);
  if (existing) {
    const saved = existing.payload as { proposal_id: string; expected_revision: number; input_patch: unknown; before: IdentitySnapshot; after: IdentityPreview['after']; source?: AdapterContext };
    if (existing.kind !== 'identity.proposal' || canonicalize(saved.input_patch) !== canonicalize(requested) || saved.source?.adapter_id !== source?.adapter_id || (options.expected_revision !== undefined && saved.expected_revision !== options.expected_revision)) throw new AssistantError('CONFLICT', '同一画像操作 ID 已用于不同请求。');
    return { proposal_id: proposalId, expected_revision: saved.expected_revision, before: saved.before, after: saved.after };
  }
  const current = await currentIdentity(runtime);
  if (options.expected_revision !== undefined && options.expected_revision !== current.revision) throw new AssistantError('CONFLICT');
  const after = resolveIdentityPatch(current, requested);
  const patch: IdentityPatch = {
    ...(requested.kernel !== undefined ? { kernel: after.kernel } : {}),
    ...(requested.user_profile !== undefined ? { user_profile: after.user_profile } : {}),
    ...(requested.habits !== undefined ? { habits: after.habits } : {}),
  };
  const payload = { proposal_id: proposalId, expected_revision: current.revision, input_patch: requested, patch, before: current, after, ...(source ? { source } : {}), patch_hash: sha256(canonicalize(patch)), status: 'pending', created_at: new Date().toISOString() };
  await runtime.events.append({ op_id: `identity-proposal:${proposalId}`, kind: 'identity.proposal', payload });
  return { proposal_id: proposalId, expected_revision: current.revision, before: current, after };
}

export async function applyIdentityProposal(runtime: Runtime, proposalId: string, expectedRevision: number, hooks?: IdentityCommitHooks): Promise<{ revision: number; identity_hash: string }> {
  const appliedOperation = runtime.events.findOp(`identity-applied:${proposalId}`);
  if (appliedOperation) {
    const payload = appliedOperation.payload as { expected_revision: number; revision: number; identity_hash: string };
    if (payload.expected_revision !== expectedRevision) throw new AssistantError('CONFLICT');
    return { revision: payload.revision, identity_hash: payload.identity_hash };
  }
  const event = runtime.events.all().find((item) => item.kind === 'identity.proposal' && (item.payload as { proposal_id?: string }).proposal_id === proposalId);
  if (!event) throw new AssistantError('NOT_FOUND', '找不到画像维护提案。');
  const proposal = event.payload as { proposal_id: string; expected_revision: number; patch: IdentityPatch; patch_hash: string; status: string };
  if (proposal.status !== 'pending' || proposal.expected_revision !== expectedRevision) throw new AssistantError('CONFLICT');
  const current = await verifyIdentity(runtime.root);
  if (current.revision === expectedRevision + 1) {
    const currentSnapshot = await readJson<{ proposal_id: string | null; identity_hash: string }>(path.join(runtime.root, 'identity/versions', String(current.revision).padStart(6, '0'), 'snapshot.json'));
    if (currentSnapshot.proposal_id !== proposalId) throw new AssistantError('CONFLICT');
    await runtime.events.append({ op_id: `identity-applied:${proposalId}`, kind: 'identity.applied', payload: { proposal_id: proposalId, expected_revision: expectedRevision, revision: current.revision, identity_hash: current.identity_hash } });
    return { revision: current.revision, identity_hash: current.identity_hash };
  }
  if (current.revision !== expectedRevision) throw new AssistantError('CONFLICT');
  if (sha256(canonicalize(proposal.patch)) !== proposal.patch_hash) throw new AssistantError('CORRUPT_DATA', '画像提案内容 hash 不匹配。');
  const nextRevision = expectedRevision + 1;
  const dir = path.join(runtime.root, 'identity/versions', String(nextRevision).padStart(6, '0'));
  const kernel = proposal.patch.kernel ?? current.kernel;
  const profile = proposal.patch.user_profile ? { ...IdentityProfileSchema.parse(current.user_profile), ...proposal.patch.user_profile } : current.user_profile;
  const habits = proposal.patch.habits ?? current.habits;
  IdentityProfileSchema.parse(profile); HabitsSchema.parse(habits);
  const snapshotFile = path.join(dir, 'snapshot.json');
  const targetExists = await access(dir).then(() => true).catch(() => false);
  let identityHash: string;
  if (targetExists) {
    const snapshot = await readJson<{ revision: number; identity_hash: string; file_hashes: Record<string, string>; proposal_id: string | null }>(snapshotFile);
    const files: Record<string, string> = {};
    for (const name of ['kernel.md', 'user-profile.json', 'habits.json']) files[name] = sha256(await readFile(path.join(dir, name)));
    identityHash = sha256(canonicalize(files));
    if (snapshot.proposal_id !== proposalId || snapshot.revision !== nextRevision || snapshot.identity_hash !== identityHash || canonicalize(snapshot.file_hashes) !== canonicalize(files)) throw new AssistantError('CONFLICT', '目标画像版本目录已存在且与提案不匹配。');
  } else {
    const staging = path.join(runtime.root, 'identity/versions', `.${String(nextRevision).padStart(6, '0')}.staging-${proposalId}`);
    await mkdir(staging, { recursive: false });
    try {
      await atomicWrite(path.join(staging, 'kernel.md'), kernel); await hooks?.afterFileWrite?.('kernel.md');
      await writeJson(path.join(staging, 'user-profile.json'), profile); await hooks?.afterFileWrite?.('user-profile.json');
      await writeJson(path.join(staging, 'habits.json'), habits); await hooks?.afterFileWrite?.('habits.json');
      const files: Record<string, string> = {};
      for (const name of ['kernel.md', 'user-profile.json', 'habits.json']) files[name] = sha256(await readFile(path.join(staging, name)));
      identityHash = sha256(canonicalize(files));
      await writeJson(path.join(staging, 'snapshot.json'), { revision: nextRevision, identity_hash: identityHash, file_hashes: files, proposal_id: proposalId, previous_revision: expectedRevision, created_at: new Date().toISOString() });
      await hooks?.beforeVersionRename?.();
      await rename(staging, dir);
      await syncDirectory(path.dirname(dir));
    } catch {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw new AssistantError('MAINTENANCE_REQUIRED', '画像快照未完成，旧 current 仍有效；可恢复后重试。');
    }
  }
  const pointerTemp = path.join(runtime.root, 'identity', `current.${proposalId}.tmp`);
  await writeJson(pointerTemp, { revision: nextRevision, identity_hash: identityHash });
  try { await hooks?.beforePointerReplace?.(); await rename(pointerTemp, path.join(runtime.root, 'identity/current.json')); await syncDirectory(path.join(runtime.root, 'identity')); }
  catch { await rm(pointerTemp, { force: true }).catch(() => undefined); throw new AssistantError('MAINTENANCE_REQUIRED', '无法切换画像 current 指针；旧版本仍有效，可在恢复后重试。'); }
  await runtime.events.append({ op_id: `identity-applied:${proposalId}`, kind: 'identity.applied', payload: { proposal_id: proposalId, expected_revision: expectedRevision, revision: nextRevision, identity_hash: identityHash } });
  return { revision: nextRevision, identity_hash: identityHash };
}

export async function readIdentityPatchFile(file: string): Promise<IdentityPatch> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new AssistantError('INVALID_INPUT', '画像 patch 文件不是有效 JSON。'); }
  const parsed = IdentityPatchSchema.safeParse(raw);
  if (!parsed.success) throw new AssistantError('INVALID_INPUT', '画像 patch 字段或值不符合允许的 schema。');
  return parsed.data;
}

export async function currentIdentity(runtime: Runtime): Promise<IdentitySnapshot> {
  const snapshot = await verifyIdentity(runtime.root);
  return { ...snapshot, ...IdentityValuesSchema.parse({ kernel: snapshot.kernel, user_profile: snapshot.user_profile, habits: snapshot.habits }) };
}

