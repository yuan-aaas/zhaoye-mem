import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packageName } from '@zhaoye/adapter-kit';

test('adapter-kit public entry is available', () => {
  assert.equal(packageName, '@zhaoye/adapter-kit');
});
