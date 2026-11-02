import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { createZhaoye, doctor, renderIdentityMarkdown } from '@zhaoye/app';
import {
  type ActorContext,
  createDefaultIdentity,
  type IdentityCommitRequest,
  type IdentityRollbackRequest,
  type IdentityUpdate,
} from '@zhaoye/contracts';
import { createIdentityService } from '@zhaoye/core';
import { openIdentityStore } from '@zhaoye/storage';

const host = {
  host_id: 'cli' as const,
  display_name: 'Test',
  capabilities: [] as [],
  adapter_version: '0.1.0',
  data_schema: 1 as const,
};
const clock = { now: () => new Date('2026-11-02T00:00:00.000Z') };
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'zhaoye-m1-'));
  const app = await createZhaoye({ dataRoot: root, host, clock });
  t.after(async () => {
    await app.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const ctx: ActorContext = {
    adapter_id: 'cli',
    scope_id: app.assistantId,
    granted_project_ids: '*',
    granted_source_ids: '*',
  };
  return { root, app, ctx };
}
const entry = (text = '偏好简洁') => ({
  id: 'brief',
  text,
  confidence: 1,
  source: 'user_explicit' as const,
  evidence_refs: ['user:message'],
  updated_at: clock.now().toISOString(),
});
const request = (
  revision = 1,
  update: IdentityUpdate = { section: 'user_profile', facts: [{ op: 'upsert', entry: entry() }] },
): IdentityCommitRequest => ({
  request_id: randomUUID(),
  operation_id: randomUUID(),
  expected_revision: revision,
  update,
  reason: '用户明确要求',
  evidence_refs: ['user:message'],
});
test('K-01 preview has no side effects and commit changes only target revision', async (t) => {
  const { app, ctx, root } = await fixture(t);
  const req = request();
  const before = await readFile(join(root, 'identity/identity.json'), 'utf8');
  const preview = await app.identity.preview(req, ctx);
  assert.deepEqual(preview.changes[0]?.added, ['brief']);
  assert.equal(await readFile(join(root, 'identity/identity.json'), 'utf8'), before);
  const result = await app.identity.commit(req, ctx);
  assert.equal(result.receipt.revision, 2);
  assert.equal(result.replayed, false);
  const snapshot = await app.identity.read(ctx);
  assert.equal(snapshot.document.user_profile.revision, 2);
  assert.equal(snapshot.document.safety_kernel.revision, 1);
  assert.equal(snapshot.file_hash, result.receipt.document_hash);
  assert.equal((await app.identity.listVersions(ctx))[0]?.reason, req.reason);
});
test('K-02 concurrent CAS accepts one request; stale writes preserve hash', async (t) => {
  const { app, ctx } = await fixture(t);
  const result = await Promise.allSettled([
    app.identity.commit(request(), ctx),
    app.identity.commit(request(), ctx),
  ]);
  assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = result.find((r) => r.status === 'rejected');
  assert.equal(rejected?.status === 'rejected' && rejected.reason.code, 'CONFLICT');
  const before = (await app.identity.read(ctx)).file_hash;
  await assert.rejects(app.identity.commit(request(), ctx), { code: 'CONFLICT' });
  assert.equal((await app.identity.read(ctx)).file_hash, before);
});
test('K-03 retries, including concurrent duplicates, return exact original receipt', async (t) => {
  const { app, ctx } = await fixture(t);
  const req = request();
  const results = await Promise.all([app.identity.commit(req, ctx), app.identity.commit(req, ctx)]);
  assert.deepEqual(results[0]?.receipt, results[1]?.receipt);
  assert.equal(results.filter((r) => r.replayed).length, 1);
  assert.deepEqual((await app.identity.commit(req, ctx)).receipt, results[0]?.receipt);
  assert.equal((await app.identity.read(ctx)).revision, 2);
});
test('K-03 replay cannot bypass scope or adapter ownership', async (t) => {
  const { app, ctx } = await fixture(t);
  const req = request();
  await app.identity.commit(req, ctx);
  await assert.rejects(app.identity.commit(req, { ...ctx, scope_id: randomUUID() }), {
    code: 'OUT_OF_SCOPE',
  });
  await assert.rejects(app.identity.commit(req, { ...ctx, adapter_id: 'mcp' }), {
    code: 'UNAUTHORIZED',
  });
});
test('K-04 kernel requires confirmation AND dedicated entrypoint', async (t) => {
  const { app, ctx } = await fixture(t);
  const req = request(1, {
    section: 'safety_kernel',
    principles: ['用户确认的新原则'],
    user_confirmed: { confirmation_ref: 'user:approved' },
  });
  const invalid = structuredClone(req);
  delete (invalid.update as unknown as Record<string, unknown>).user_confirmed;
  await assert.rejects(app.identity.commitKernel(invalid, ctx), { code: 'UNAUTHORIZED' });
  await assert.rejects(app.identity.commit(req, ctx), { code: 'UNAUTHORIZED' });
  const result = await app.identity.commitKernel(req, ctx);
  assert.equal(result.receipt.section_revisions.safety_kernel, 2);
});
test('K-05 deleted projection does not affect read; pure render is repeatable', async (t) => {
  const { app, ctx, root } = await fixture(t);
  const before = await readFile(join(root, 'identity/identity.md'), 'utf8');
  await unlink(join(root, 'identity/identity.md'));
  const doc = (await app.identity.read(ctx)).document;
  assert.equal(renderIdentityMarkdown(doc), before);
  assert.equal((await doctor(root)).checks.find((c) => c.id === 'projection')?.status, 'warn');
});
test('K-06 rollback creates new revision and preserves historical bytes', async (t) => {
  const { app, ctx, root } = await fixture(t);
  await app.identity.commit(request(), ctx);
  const history = await readFile(join(root, 'identity/versions/000000000002.json'), 'utf8');
  await app.identity.commit(
    request(2, { section: 'user_profile', facts: [{ op: 'upsert', entry: entry('详细说明') }] }),
    ctx,
  );
  const req: IdentityRollbackRequest = {
    request_id: randomUUID(),
    operation_id: randomUUID(),
    expected_revision: 3,
    section: 'user_profile',
    to_revision: 2,
    reason: '恢复用户偏好',
  };
  await app.identity.rollback(req, ctx);
  const doc = (await app.identity.read(ctx)).document;
  assert.equal(doc.revision, 4);
  assert.equal(doc.user_profile.facts[0]?.text, entry().text);
  assert.equal(await readFile(join(root, 'identity/versions/000000000002.json'), 'utf8'), history);
});
test('K-07 upsert replaces by id; missing remove and duplicate ops rejected', async (t) => {
  const { app, ctx } = await fixture(t);
  await app.identity.commit(request(), ctx);
  await assert.rejects(
    app.identity.commit(
      request(2, { section: 'user_profile', facts: [{ op: 'remove', id: 'missing' }] }),
      ctx,
    ),
    { code: 'NOT_FOUND' },
  );
  await assert.rejects(
    app.identity.commit(
      request(2, {
        section: 'user_profile',
        facts: [
          { op: 'upsert', entry: entry('x') },
          { op: 'remove', id: 'brief' },
        ],
      }),
      ctx,
    ),
    { code: 'INVALID_INPUT' },
  );
  await app.identity.commit(
    request(2, { section: 'user_profile', facts: [{ op: 'remove', id: 'brief' }] }),
    ctx,
  );
  assert.deepEqual((await app.identity.read(ctx)).document.user_profile.facts, []);
});
test('K-08 low confidence inference cannot overwrite explicit fact', async (t) => {
  const { app, ctx } = await fixture(t);
  await app.identity.commit(request(), ctx);
  await assert.rejects(
    app.identity.commit(
      request(2, {
        section: 'user_profile',
        facts: [
          { op: 'upsert', entry: { ...entry('推断'), source: 'model_inference', confidence: 0.5 } },
        ],
      }),
      ctx,
    ),
    { code: 'UNAUTHORIZED' },
  );
});
test('A-01/A-03 duplicate open rejected; close idempotent and closed service cannot write', async (t) => {
  const { app, ctx, root } = await fixture(t);
  await assert.rejects(createZhaoye({ dataRoot: root, host }), { code: 'ASSISTANT_SAME_PROCESS' });
  await app.close();
  await app.close();
  await assert.rejects(app.identity.commit(request(), ctx), { code: 'CONFLICT' });
  const reopened = await createZhaoye({ dataRoot: root, host });
  assert.equal(reopened.created, false);
  assert.equal(reopened.assistantId, app.assistantId);
  await reopened.close();
});
test('A-02 doctor stays read-only on corrupt data and can inspect an occupied root', async (t) => {
  const { root } = await fixture(t);
  assert.equal(
    (await doctor(root)).checks.some((c) => c.status === 'fail'),
    false,
  );
  await writeFile(join(root, 'identity/identity.json'), '{');
  const before = (await stat(join(root, 'identity/identity.json'))).mtimeMs;
  const report = await doctor(root);
  assert.equal(
    report.checks.some((c) => c.status === 'fail'),
    true,
  );
  assert.equal((await stat(join(root, 'identity/identity.json'))).mtimeMs, before);
  assert.equal(await readFile(join(root, 'identity/identity.json'), 'utf8'), '{');
});
for (const point of [
  'before_identity',
  'after_identity',
  'version',
  'operation',
  'projection',
] as const) {
  test(`failure injection: ${point}`, async (t) => {
    const { app, root, ctx } = await fixture(t);
    const service = createIdentityService(
      openIdentityStore(root, {
        fault: (p) => {
          if (p === point) throw new Error('injected');
        },
      }),
      clock,
    );
    if (point === 'before_identity') {
      await assert.rejects(service.commit(request(), ctx));
      assert.equal((await app.identity.read(ctx)).revision, 1);
    } else if (point === 'after_identity' || point === 'operation') {
      await assert.rejects(service.commit(request(), ctx), { code: 'COMMIT_UNKNOWN' });
      assert.equal((await app.identity.read(ctx)).revision, 2);
    } else {
      const req = request();
      const result = await service.commit(req, ctx);
      assert.equal(result.receipt.revision, 2);
      assert.ok(result.receipt.warnings.includes(`${point}_failed`));
      assert.deepEqual((await service.commit(req, ctx)).receipt, result.receipt);
    }
  });
}
test('K-01 no-op rejected rather than inventing a revision', async (t) => {
  const { app, ctx } = await fixture(t);
  await assert.rejects(
    app.identity.commit(request(1, { section: 'user_profile', display_name: null }), ctx),
    { code: 'INVALID_INPUT' },
  );
});
test('K-04 kernel rollback cannot bypass confirmation', async (t) => {
  const { app, ctx } = await fixture(t);
  const req = {
    request_id: randomUUID(),
    operation_id: randomUUID(),
    expected_revision: 1,
    section: 'safety_kernel' as const,
    to_revision: 1,
    reason: 'rollback',
  };
  await assert.rejects(app.identity.rollbackKernel(req, ctx), { code: 'UNAUTHORIZED' });
});
test('S-07 retention preserves initial kernel snapshot and drops oldest ordinary snapshot', async (t) => {
  const { app, ctx, root } = await fixture(t);
  for (let i = 1; i <= 202; i++)
    await app.identity.commit(
      request(i, { section: 'user_profile', display_name: `name-${i}` }),
      ctx,
    );
  const store = openIdentityStore(root);
  const versions = await store.listVersions(1000);
  assert.equal(versions.find((v) => v.revision === 1)?.retained, true);
  assert.equal(versions.find((v) => v.revision === 2)?.retained, false);
  assert.equal(versions.filter((v) => v.retained && v.section !== 'safety_kernel').length, 200);
  await assert.rejects(store.readVersion(2), { code: 'CONFLICT' });
  assert.deepEqual(
    (await store.readVersion(1)).safety_kernel,
    createDefaultIdentity(app.assistantId, clock.now().toISOString()).safety_kernel,
  );
});
test('kernel confirmations and request evidence survive reopen in operation audit', async (t) => {
  const { app, ctx, root } = await fixture(t);
  const req = request(1, {
    section: 'safety_kernel',
    principles: ['用户要求的原则'],
    user_confirmed: { confirmation_ref: 'user-message-42' },
  });
  await app.identity.commitKernel(req, ctx);
  const op = await openIdentityStore(root).findOperation(req.operation_id);
  assert.equal(op?.confirmation_ref, 'user-message-42');
  assert.deepEqual(op?.evidence_refs, req.evidence_refs);
  await app.close();
  const reopened = await createZhaoye({ dataRoot: root, host, initIfMissing: false });
  try {
    assert.deepEqual((await reopened.identity.commitKernel(req, ctx)).receipt, op?.receipt);
  } finally {
    await reopened.close();
  }
});
test('unavailable current snapshot is reported instead of fabricated historical recovery', async (t) => {
  const { app, ctx, root } = await fixture(t);
  await app.identity.commit(request(), ctx);
  await unlink(join(root, 'identity/versions/000000000002.json'));
  const report = await doctor(root);
  assert.equal(report.checks.find((c) => c.id === 'version_2')?.status, 'fail');
});
test('preexisting future snapshot cannot be overwritten by commit', async (t) => {
  const { app, ctx, root } = await fixture(t);
  const path = join(root, 'identity/versions/000000000002.json');
  await writeFile(path, 'immutable');
  await assert.rejects(app.identity.commit(request(), ctx), { code: 'CORRUPT_DATA' });
  assert.equal((await app.identity.read(ctx)).revision, 1);
  assert.equal(await readFile(path, 'utf8'), 'immutable');
});
test('close drains in-flight operations before releasing the data root', async (t) => {
  const { app, ctx, root } = await fixture(t);
  const pending = Promise.allSettled([app.identity.commit(request(), ctx)]);
  await app.close();
  await pending;
  const reopened = await createZhaoye({ dataRoot: root, host, initIfMissing: false });
  try {
    assert.equal((await reopened.presence())?.pid, process.pid);
    await assert.rejects(app.identity.read(ctx), { code: 'CONFLICT' });
  } finally {
    await reopened.close();
  }
});
for (const mode of ['missing', 'empty', 'lost-prefix'] as const) {
  test(`WB-02 ${mode} version index blocks commits without altering identity or historical snapshots`, async (t) => {
    const { app, ctx, root } = await fixture(t);
    await app.identity.commit(request(), ctx);
    const file = join(root, 'identity/versions/index.jsonl');
    const original = await readFile(file, 'utf8');
    const before = (await app.identity.read(ctx)).file_hash;
    const initialSnapshot = await readFile(
      join(root, 'identity/versions/000000000001.json'),
      'utf8',
    );
    if (mode === 'missing') await unlink(file);
    else await writeFile(file, mode === 'empty' ? '' : original.split('\n').slice(1).join('\n'));
    await assert.rejects(
      app.identity.commit(request(2, { section: 'user_profile', display_name: 'blocked' }), ctx),
      { code: 'CORRUPT_DATA' },
    );
    await assert.rejects(app.identity.listVersions(ctx), { code: 'CORRUPT_DATA' });
    assert.equal((await app.identity.read(ctx)).file_hash, before);
    assert.equal(
      await readFile(join(root, 'identity/versions/000000000001.json'), 'utf8'),
      initialSnapshot,
    );
    assert.equal(
      (await doctor(root)).checks.some((c) => c.status === 'fail'),
      true,
    );
    await writeFile(file, original);
    await app.identity.commit(
      request(2, { section: 'user_profile', display_name: 'recovered' }),
      ctx,
    );
    assert.deepEqual(
      (await app.identity.listVersions(ctx)).map((v) => v.revision),
      [3, 2, 1],
    );
  });
}
test('WB-03 concurrent close calls share an attempt; transient failure can be retried without reopening writes', async (t) => {
  const { app, ctx, root } = await fixture(t);
  const lock = join(root, 'presence/.tmp-presence-lock');
  await writeFile(lock, JSON.stringify({ pid: process.pid }));
  const first = app.close();
  const concurrent = app.close();
  assert.equal(concurrent, first);
  await assert.rejects(first, { code: 'LOCKED' });
  assert.ok(await app.presence());
  await assert.rejects(app.identity.read(ctx), { code: 'CONFLICT' });
  await unlink(lock);
  const retry = app.close();
  assert.notEqual(retry, first);
  await retry;
  await app.close();
  assert.equal(await app.presence(), null);
  const reopened = await createZhaoye({ dataRoot: root, host, initIfMissing: false });
  await reopened.close();
});
test('WB-04 invalid complete receipt tail is rejected before the authoritative commit', async (t) => {
  const { app, ctx, root } = await fixture(t);
  await app.identity.commit(request(), ctx);
  const log = join(root, 'identity/operations.jsonl'),
    before = (await app.identity.read(ctx)).file_hash;
  const original = await readFile(log, 'utf8');
  await writeFile(log, `${original}{}`);
  await assert.rejects(
    app.identity.commit(request(2, { section: 'user_profile', display_name: 'blocked' }), ctx),
    { code: 'CORRUPT_DATA' },
  );
  assert.equal((await app.identity.read(ctx)).file_hash, before);
  assert.equal(await readFile(log, 'utf8'), `${original}{}`);
  await writeFile(log, original);
  await app.identity.commit(request(2, { section: 'user_profile', display_name: 'allowed' }), ctx);
  await app.identity.commit(request(3, { section: 'user_profile', display_name: 'again' }), ctx);
});
