import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEnvelopeSchema } from '@zhaoye/contracts';

const validEvent = {
  v: 3,
  seq: 1,
  id: '0192f0c5-4f7b-7c1e-9a2d-45e6a8c0b123',
  at: '2026-10-26T10:00:00.000Z',
  op: 'op-1',
  fingerprint: 'a'.repeat(64),
  prev: '0'.repeat(64),
  digest: 'b'.repeat(64),
  kind: 'memory.recorded',
  actor: { adapter_id: 'test', host: 'node' },
  payload: { record_id: 'record-1' },
};

test('contracts accepts a valid event envelope', () => {
  assert.equal(EventEnvelopeSchema.parse(validEvent).seq, 1);
});

test('contracts rejects an invalid event envelope', () => {
  assert.equal(EventEnvelopeSchema.safeParse({ ...validEvent, seq: 0 }).success, false);
});
