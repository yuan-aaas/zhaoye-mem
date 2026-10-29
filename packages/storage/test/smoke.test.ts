import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packageName } from '@zhaoye/storage';

test('storage public entry is available', () => {
  assert.equal(packageName, '@zhaoye/storage');
});
