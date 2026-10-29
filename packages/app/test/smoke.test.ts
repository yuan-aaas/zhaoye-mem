import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packageName } from '@zhaoye/app';

test('app public entry is available', () => {
  assert.equal(packageName, '@zhaoye/app');
});
