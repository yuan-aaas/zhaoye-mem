import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  type ActorContext,
  type BackupObservation,
  type ClockPort,
  type IdentityStore,
  LIMITS,
  type PreferenceCandidate,
  type PreferenceEvidence,
  PreferenceEvidenceSchema,
  PreferenceLedgerSchema,
  parseInput,
  ZhaoyeError,
} from '@zhaoye/contracts';
import { explicitPreference, type IdentityService } from '@zhaoye/core';
import { hashBytes, readJson, readText, writeAtomic } from '@zhaoye/storage';

export function createEvolution(
  root: string,
  identity: IdentityService,
  store: IdentityStore,
  clock: ClockPort,
  assertOwner: () => Promise<void>,
) {
  const file = join(root, 'identity', 'evolution.json');
  let tail: Promise<unknown> = Promise.resolve();
  function serialize<T>(work: () => Promise<T>) {
    const job = tail.then(work);
    tail = job.catch(() => {});
    return job;
  }
  async function read(): Promise<PreferenceCandidate[]> {
    return (await readText(file)) === null ? [] : readJson(file, PreferenceLedgerSchema);
  }
  async function persist(rows: PreferenceCandidate[]) {
    await assertOwner();
    await writeAtomic(file, `${JSON.stringify(rows, null, 2)}\n`);
  }
  async function apply(
    rows: PreferenceCandidate[],
    item: PreferenceCandidate,
    actor: ActorContext,
  ) {
    if (item.evidence.scoped)
      throw new ZhaoyeError('OUT_OF_SCOPE', '这条偏好仅适用于来源范围，可在原记忆中查用');
    const snapshot = await identity.read(actor);
    if (item.state === 'applying') {
      const op = await store.findOperation(item.id);
      if (op) {
        item.state = 'applied';
        item.revision = op.revision;
        await persist(rows);
        return item;
      }
    }
    const current = snapshot.document.user_profile.preferences.find(
      (entry) => entry.id === item.key,
    );
    const newer = rows.some(
      (row) =>
        row.id !== item.id &&
        row.key === item.key &&
        row.state === 'applied' &&
        Date.parse(row.evidence.at) > Date.parse(item.evidence.at),
    );
    const alreadyMatches = item.operation === 'forget' ? !current : current?.text === item.text;
    if (alreadyMatches || newer) {
      item.state = 'unchanged';
      item.revision = snapshot.revision;
      await persist(rows);
      return item;
    }
    if (
      item.operation === 'remember' &&
      !current &&
      snapshot.document.user_profile.preferences.length >= LIMITS.preferences
    ) {
      item.state = 'pending';
      await persist(rows);
      return item;
    }
    if (item.state !== 'applying') {
      item.state = 'applying';
      await persist(rows);
    }
    const change =
      item.operation === 'forget'
        ? { op: 'remove' as const, id: item.key }
        : {
            op: 'upsert' as const,
            entry: {
              id: item.key,
              text: item.text,
              confidence: 1,
              source: 'user_confirmation' as const,
              evidence_refs: [item.evidence.id],
              updated_at: clock.now().toISOString(),
            },
          };
    const result = await identity.commit(
      {
        request_id: item.id,
        operation_id: item.id,
        expected_revision: snapshot.revision,
        update: { section: 'user_profile', preferences: [change] },
        reason: '更新用户确认的长期协作偏好',
        evidence_refs: [item.evidence.id],
      },
      actor,
    );
    item.state = 'applied';
    item.revision = result.receipt.revision;
    await persist(rows);
    return item;
  }
  async function submit(
    input: PreferenceEvidence,
    actor: ActorContext,
    mode: 'explicit' | 'candidate',
  ) {
    return serialize(async () => {
      await identity.read(actor);
      const evidence = parseInput(PreferenceEvidenceSchema, input);
      const rows = await read();
      const existing = rows.find((row) => row.evidence.id === evidence.id);
      if (existing) {
        if (existing.evidence.text !== evidence.text)
          throw new ZhaoyeError('CONFLICT', '同一个证据引用对应不同内容');
        if (existing.state === 'applying') return apply(rows, existing, actor);
        return existing;
      }
      const explicit = mode === 'explicit' ? explicitPreference(evidence.text) : null;
      if (mode === 'explicit' && !explicit)
        throw new ZhaoyeError('INVALID_INPUT', '这条用户消息没有可确认的长期记忆指令');
      const canonical = explicit ?? explicitPreference(`以后${evidence.text}`);
      const text =
        canonical?.operation === 'remember'
          ? canonical.text
          : (explicit?.text ?? [...evidence.text.trim()].slice(0, LIMITS.profileText).join(''));
      const key =
        canonical?.id ||
        `pref-${hashBytes(text.normalize('NFKC').replace(/\s+/g, ' ').trim()).slice(0, 24)}`;
      const duplicate =
        mode === 'candidate' &&
        rows.find(
          (row) =>
            row.key === key &&
            row.text === text &&
            row.evidence.project === evidence.project &&
            row.evidence.scoped === evidence.scoped &&
            ['pending', 'applied', 'unchanged'].includes(row.state),
        );
      if (duplicate) return duplicate;
      const item: PreferenceCandidate = {
        id: randomUUID(),
        evidence,
        key,
        text,
        operation: explicit?.operation ?? 'remember',
        mode,
        state: mode === 'explicit' ? 'applying' : 'pending',
      };
      rows.push(item);
      await persist(rows);
      return mode === 'explicit' ? apply(rows, item, actor) : item;
    });
  }
  function inScope(row: PreferenceCandidate, actor: ActorContext) {
    const project = row.evidence.project;
    return (
      !project || actor.granted_project_ids === '*' || actor.granted_project_ids.includes(project)
    );
  }
  return {
    remember: (evidence: PreferenceEvidence, actor: ActorContext) =>
      submit(evidence, actor, 'explicit'),
    propose: (evidence: PreferenceEvidence, actor: ActorContext) =>
      submit(evidence, actor, 'candidate'),
    proposeDistilled(source: string, row: BackupObservation, actor: ActorContext) {
      const body = row.content?.body.trim();
      if (!body) return Promise.resolve();
      const sourceSession =
        typeof row.metadata.source === 'string'
          ? /^session:([a-zA-Z0-9_-]{1,200})$/.exec(row.metadata.source)?.[1]
          : undefined;
      return submit(
        {
          id:
            'mneme:' +
            hashBytes(
              JSON.stringify([
                source,
                row.nativeId,
                row.content,
                row.projectId,
                row.metadata.agent_scope,
                row.metadata.workspace_scope,
                sourceSession,
              ]),
            ),
          text: [...body].slice(0, 1000).join(''),
          at: row.sourceUpdatedAt ?? new Date(0).toISOString(),
          sourceSession,
          project: row.projectId ?? undefined,
          scoped:
            Boolean(row.projectId || row.metadata.agent_scope || row.metadata.workspace_scope) ||
            undefined,
        },
        actor,
        'candidate',
      ).then(() => undefined);
    },
    async list(actor: ActorContext) {
      await identity.read(actor);
      return (await read())
        .filter(
          (row) => inScope(row, actor) && (row.state === 'pending' || row.state === 'applying'),
        )
        .reverse();
    },
    review(id: string, decision: 'apply' | 'reject', actor: ActorContext) {
      return serialize(async () => {
        await identity.read(actor);
        const rows = await read();
        const item = rows.find((row) => row.id === id);
        if (!item || !inScope(item, actor)) throw new ZhaoyeError('NOT_FOUND', '没有这条偏好候选');
        if (item.state !== 'pending' && item.state !== 'applying') return item;
        if (decision === 'apply') return apply(rows, item, actor);
        if (item.state === 'applying')
          throw new ZhaoyeError('COMMIT_UNKNOWN', '请核对这条偏好已发起的提交');
        item.state = 'rejected';
        await persist(rows);
        return item;
      });
    },
  };
}
