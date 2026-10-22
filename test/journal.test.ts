import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Journal } from '../src/infrastructure/journal.js';
import { AssistantError } from '../src/contracts/errors.js';

test('journal append is durable, idempotent, and rejects op_id reuse', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zhaoye-journal-'));
  try {
    const file = path.join(dir, 'events.jsonl');
    const journal = new Journal(file, 10, 100_000);
    await journal.replay();
    const first = await journal.append({ op_id: 'op-1', kind: 'test.event', payload: { b: 2, a: 1 } });
    assert.equal(first.event.seq, 1);
    assert.equal((await journal.append({ op_id: 'op-1', kind: 'test.event', payload: { a: 1, b: 2 } })).replayed, true);
    await assert.rejects(() => journal.append({ op_id: 'op-1', kind: 'test.event', payload: { a: 3 } }), (error: unknown) => error instanceof AssistantError && error.code === 'CONFLICT');
    const replay = new Journal(file, 10, 100_000);
    assert.equal((await replay.replay()).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('journal refuses torn tails and checksum corruption', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zhaoye-journal-'));
  try {
    const file = path.join(dir, 'events.jsonl');
    const journal = new Journal(file, 10, 100_000); await journal.replay();
    await journal.append({ op_id: 'one', kind: 'test.event', payload: { value: 1 } });
    await writeFile(file, `${await readFile(file, 'utf8')}torn`);
    await assert.rejects(() => new Journal(file, 10, 100_000).replay(), (error: unknown) => error instanceof AssistantError && error.code === 'CORRUPT_DATA');
    const valid = (await readFile(file, 'utf8')).split('\n')[0]!.replace('"value":1', '"value":2');
    await writeFile(file, `${valid}\n`);
    await assert.rejects(() => new Journal(file, 10, 100_000).replay(), (error: unknown) => error instanceof AssistantError && error.code === 'CORRUPT_DATA');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
