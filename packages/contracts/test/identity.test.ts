import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  createDefaultIdentity,
  DEFAULT_SAFETY_KERNEL_PRINCIPLES,
  IdentityCommitRequestSchema,
  IdentityDocumentSchema,
  LIMITS,
  parseInput,
  serializeIdentityDocument,
} from '@zhaoye/contracts';

const doc = () =>
  createDefaultIdentity('8a585ec7-d3a3-4322-939e-5540dfaa9137', '2026-11-02T00:00:00.000Z');
test('C-01 golden identity roundtrips with stable nested key order', () => {
  const d = doc();
  const raw = serializeIdentityDocument(d);
  assert.deepEqual(IdentityDocumentSchema.parse(JSON.parse(raw)), d);
  assert.equal(raw, serializeIdentityDocument(JSON.parse(raw)));
  assert.equal(raw.endsWith('\n'), true);
});
for (const [name, change] of Object.entries({
  unknown: (d: Record<string, unknown>) => {
    d.extra = true;
  },
  missing: (d: Record<string, unknown>) => {
    delete d.user_profile;
  },
  version: (d: Record<string, unknown>) => {
    d.schema_version = 2;
  },
  revision: (d: Record<string, unknown>) => {
    d.revision = 0;
  },
  nested: (d: Record<string, unknown>) => {
    (d.safety_kernel as Record<string, unknown>).unknown = true;
  },
})) {
  test(`C-01 rejects ${name}`, () => {
    const d = doc();
    change(d);
    assert.throws(() => parseInput(IdentityDocumentSchema, d), { code: 'INVALID_INPUT' });
  });
}
test('C-02 principle count and Unicode codepoint boundary', () => {
  const d = doc();
  d.safety_kernel.principles = ['🙂'.repeat(200)];
  assert.doesNotThrow(() => serializeIdentityDocument(d));
  d.safety_kernel.principles = ['x'.repeat(201)];
  assert.throws(() => serializeIdentityDocument(d), { code: 'INVALID_INPUT' });
  d.safety_kernel.principles = Array(13).fill('x');
  assert.throws(() => serializeIdentityDocument(d), { code: 'INVALID_INPUT' });
});
test('C-02 duplicate ids and per-section list limits rejected', () => {
  const d = doc();
  const e = {
    id: 'fact',
    text: 'hello',
    confidence: 1,
    source: 'user_explicit' as const,
    evidence_refs: [],
    updated_at: d.updated_at,
  };
  d.user_profile.facts = [e];
  d.user_profile.preferences = [e];
  assert.equal(IdentityDocumentSchema.safeParse(d).success, false);
  d.user_profile.preferences = [];
  d.user_profile.facts = Array.from({ length: LIMITS.facts + 1 }, (_, i) => ({
    ...e,
    id: `f${i}`,
  }));
  assert.equal(IdentityDocumentSchema.safeParse(d).success, false);
});
test('C-02 request rejects unknown fields and missing provenance', () => {
  assert.equal(IdentityCommitRequestSchema.safeParse({ operation_id: 'x' }).success, false);
});
test('C-04 confirmed defaults match preset verbatim', async () => {
  const text = await readFile(new URL('../../../presets/kernel.md', import.meta.url), 'utf8');
  assert.deepEqual(
    text
      .split(/\r?\n/)
      .filter((l) => /^\d\. /.test(l))
      .map((l) => l.slice(3)),
    [...DEFAULT_SAFETY_KERNEL_PRINCIPLES],
  );
});
