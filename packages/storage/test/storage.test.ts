import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import {
  createDefaultIdentity,
  type OwnerInfo,
  StoredOperationSchema,
  serializeIdentityDocument,
} from '@zhaoye/contracts';
import {
  appendOperation,
  createPresence,
  ensureDataRoot,
  hashBytes,
  openDataRoot,
  openIdentityStore,
  readJson,
  readLines,
  writeAtomic,
} from '@zhaoye/storage';

const clock = { now: () => new Date('2026-11-02T00:00:00.000Z') };
async function root(t: TestContext) {
  const p = await mkdtemp(join(tmpdir(), '照夜 M1-'));
  t.after(() => rm(p, { recursive: true, force: true }));
  return p;
}
test('S-01 atomic replacement cleans temp files and preserves UTF-8', async (t) => {
  const p = await root(t);
  const f = join(p, '文档.json');
  await writeAtomic(f, 'one');
  await writeAtomic(f, '中文');
  assert.equal(await readFile(f, 'utf8'), '中文');
  assert.deepEqual(await readdir(p), ['文档.json']);
});
test('S-02 malformed JSON reports its path', async (t) => {
  const p = await root(t),
    f = join(p, 'bad');
  await writeFile(f, '{');
  await assert.rejects(
    readJson(f, { parse: (v) => v }),
    (e) =>
      !!e && typeof e === 'object' && 'details' in e && (e.details as { path: string }).path === f,
  );
});
test('S-03 rename failure reports storage failure and cleans temporary file', async (t) => {
  const p = await root(t),
    f = join(p, 'target');
  await mkdir(f);
  await assert.rejects(writeAtomic(f, 'x'), { code: 'STORAGE_FAILURE' });
  assert.deepEqual(await readdir(p), ['target']);
});
test('S-04/S-05 Chinese data root initialization and reopen', async (t) => {
  const p = await root(t);
  const first = await ensureDataRoot(p, clock, () => 'projection\n');
  const before = await readFile(join(p, 'identity/identity.json'), 'utf8');
  const again = await ensureDataRoot(p, clock, () => 'different');
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal((await openDataRoot(p)).manifest.assistant_id, first.manifest.assistant_id);
  assert.equal(await readFile(join(p, 'identity/identity.json'), 'utf8'), before);
  assert.equal(await readFile(join(p, 'identity/identity.md'), 'utf8'), 'projection\n');
});
test('S-05 missing manifest never replaces existing identity', async (t) => {
  const p = await root(t);
  await mkdir(join(p, 'identity'));
  await writeFile(join(p, 'identity/keep'), 'original');
  await assert.rejects(
    ensureDataRoot(p, clock, () => ''),
    { code: 'CORRUPT_DATA' },
  );
  assert.equal(await readFile(join(p, 'identity/keep'), 'utf8'), 'original');
  assert.deepEqual(await readdir(p), ['identity']);
});
test('S-06 legacy layout is refused', async (t) => {
  const p = await root(t);
  await mkdir(join(p, 'journal'));
  await assert.rejects(
    ensureDataRoot(p, clock, () => ''),
    { code: 'SCHEMA_MIGRATION_REQUIRED' },
  );
});
test('S-08 partial tail discarded but middle corruption rejected', async (t) => {
  const p = await root(t),
    f = join(p, 'lines');
  const schema = {
    parse: (v: unknown) => {
      if (typeof v !== 'number') throw new Error('bad');
      return v;
    },
  };
  await writeFile(f, '1\n{');
  assert.deepEqual(await readLines(f, schema, true), [1]);
  await writeFile(f, '1\n{\n2\n');
  await assert.rejects(readLines(f, schema, true), { code: 'CORRUPT_DATA' });
});
test('S-08 append repairs partial tail and rotates at bound', async (t) => {
  const p = await root(t),
    f = join(p, 'operations.jsonl');
  await writeFile(f, '1\n{');
  await appendOperation(f, 2);
  assert.equal(await readFile(f, 'utf8'), '1\n2\n');
  await writeFile(f, '1\n'.repeat(2000));
  await appendOperation(f, 3);
  assert.equal(await readFile(f, 'utf8'), '3\n');
  assert.equal((await readFile(join(p, 'operations.1.jsonl'), 'utf8')).split('\n').length, 2001);
});
const owner = (pid = 101): OwnerInfo => ({
  state: 'active',
  host: 'cli',
  host_name: 'test',
  pid,
  instance_id: randomUUID(),
  started_at: clock.now().toISOString(),
  heartbeat_at: clock.now().toISOString(),
  heartbeat_interval_ms: 60000,
  assistant_id: randomUUID(),
  adapter_version: '0.1.0',
});
test('S-09 presence acquire/reenter/same_process/release protection', async (t) => {
  const p = await root(t),
    presence = createPresence(p, clock, () => true),
    a = owner();
  assert.equal((await presence.acquire(a)).status, 'acquired');
  assert.equal((await presence.acquire(a)).status, 'reentered');
  const b = { ...a, instance_id: randomUUID() };
  assert.deepEqual(await presence.acquire(b), {
    status: 'blocked',
    owner: a,
    reason: 'same_process',
  });
  await assert.rejects(presence.release(b.instance_id), { code: 'CONFLICT' });
  await presence.release(a.instance_id);
  assert.equal(await presence.read(), null);
});
test('S-10 stale heartbeat with live PID never permits takeover', async (t) => {
  const p = await root(t),
    a = owner();
  const presence = createPresence(p, { now: () => new Date('2027-01-01T00:00:00Z') }, () => true);
  await presence.acquire(a);
  assert.equal((await presence.acquire(owner(102))).status, 'blocked');
});
test('S-10 dead PID is taken over and previous owner recorded', async (t) => {
  const p = await root(t),
    a = owner(),
    presence = createPresence(p, clock, () => false);
  await presence.acquire(a);
  const b = owner(102);
  assert.equal((await presence.acquire(b)).status, 'taken_over');
  await assert.rejects(presence.heartbeat(a.instance_id), { code: 'CONFLICT' });
  await presence.heartbeat(b.instance_id);
  assert.equal((await presence.read())?.instance_id, b.instance_id);
  assert.equal(
    JSON.parse(await readFile(join(p, 'presence/last-released.json'), 'utf8')).owner.instance_id,
    a.instance_id,
  );
});
test('S-02 truncated authoritative identity is never recreated', async (t) => {
  const p = await root(t);
  await ensureDataRoot(p, clock, () => '');
  await writeFile(join(p, 'identity/identity.json'), '{');
  await assert.rejects(openIdentityStore(p).read(), { code: 'CORRUPT_DATA' });
  await assert.rejects(
    ensureDataRoot(p, clock, () => ''),
    { code: 'CORRUPT_DATA' },
  );
  assert.equal(await readFile(join(p, 'identity/identity.json'), 'utf8'), '{');
});
test('stored operation schema validates receipts instead of trusting log JSON', () => {
  assert.equal(StoredOperationSchema.safeParse({ operation_id: randomUUID() }).success, false);
  assert.equal(
    createDefaultIdentity(randomUUID(), clock.now().toISOString()).user_profile.display_name,
    null,
  );
});
test('valid JSON log tail without newline is preserved on append', async (t) => {
  const p = await root(t),
    f = join(p, 'operations.jsonl');
  await writeFile(f, '1');
  await appendOperation(f, 2);
  assert.equal(await readFile(f, 'utf8'), '1\n2\n');
});
test('non-directory data root returns structured storage error', async (t) => {
  const p = await root(t),
    file = join(p, 'file');
  await writeFile(file, 'keep');
  await assert.rejects(
    ensureDataRoot(file, clock, () => ''),
    { code: 'STORAGE_FAILURE' },
  );
  assert.equal(await readFile(file, 'utf8'), 'keep');
});
test('WB-01 identity and version reads parse exactly the bytes whose hash was checked', async (t) => {
  const p = await root(t);
  const opened = await ensureDataRoot(p, clock, () => '');
  const before = createDefaultIdentity(opened.manifest.assistant_id, clock.now().toISOString());
  const newer = {
    ...before,
    revision: 2,
    user_profile: { ...before.user_profile, display_name: 'new' },
  };
  const newerBytes = serializeIdentityDocument(newer);
  let identityChanged = false,
    versionChanged = false;
  const store = openIdentityStore(p, {
    fault: async (point) => {
      if (point === 'after_identity_read' && !identityChanged) {
        identityChanged = true;
        await writeAtomic(join(p, 'identity/identity.json'), newerBytes);
      }
      if (point === 'after_version_read' && !versionChanged) {
        versionChanged = true;
        await writeAtomic(join(p, 'identity/versions/000000000001.json'), newerBytes);
      }
    },
  });
  const snapshot = await store.read();
  assert.equal(snapshot.document.revision, 1);
  assert.equal(snapshot.fileHash, hashBytes(serializeIdentityDocument(snapshot.document)));
  const historical = await store.readVersion(1);
  assert.deepEqual(historical, before);
  assert.equal(JSON.parse(await readFile(join(p, 'identity/identity.json'), 'utf8')).revision, 2);
});
test('WB-04 complete schema-invalid tail and malformed JSON are never discarded', async (t) => {
  const p = await root(t),
    file = join(p, 'lines');
  const schema = {
    parse: (v: unknown) => {
      if (typeof v !== 'number') throw new Error('number required');
      return v;
    },
  };
  for (const tail of ['{}', '{}\n', '{oops}', '01', '"\\q"']) {
    const raw = `1\n${tail}`;
    await writeFile(file, raw);
    await assert.rejects(readLines(file, schema, true), { code: 'CORRUPT_DATA' });
    await assert.rejects(appendOperation(file, 2, schema), { code: 'CORRUPT_DATA' });
    assert.equal(await readFile(file, 'utf8'), raw);
  }
});
test('WB-04 all truncated prefixes of a valid JSON record recover and remain readable after append', async (t) => {
  const p = await root(t),
    file = join(p, 'lines');
  const schema = { parse: (v: unknown) => v };
  const line = JSON.stringify({
    id: 'a',
    text: 'quote " and backslash \\ 中文',
    values: [true, false, null, 1.2e-8],
  });
  for (let i = 1; i < line.length; i++) {
    await writeFile(file, `1\n${line.slice(0, i)}`);
    assert.deepEqual(await readLines(file, schema, true), [1]);
    await appendOperation(file, 2, schema);
    assert.deepEqual(await readLines(file, schema, true), [1, 2]);
  }
});
