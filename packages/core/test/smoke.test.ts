import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packageName } from '@zhaoye/core';

test('core public entry is available', () => {
  assert.equal(packageName, '@zhaoye/core');
});
