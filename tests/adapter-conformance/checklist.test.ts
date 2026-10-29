import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertErrorPassThrough, assertPublicEntrySpecifier, createFakeHost } from './harness.js';

test('adapter conformance imports public package entrypoints', () => {
  for (const specifier of ['@zhaoye/app', '@zhaoye/adapter-kit', '@zhaoye/contracts']) {
    assertPublicEntrySpecifier(specifier);
  }
  assert.throws(() => assertPublicEntrySpecifier('../src/internal/service.js'));
});

test('adapter conformance preserves the original error', async () => {
  const host = createFakeHost();
  host.registerTool('assistant_probe', () => undefined);
  assert.deepEqual(host.registeredTools, ['assistant_probe']);

  const expectedError = Object.assign(new Error('host failure'), { action: 'run_doctor' });
  await assertErrorPassThrough(async () => {
    throw expectedError;
  }, expectedError);
});
