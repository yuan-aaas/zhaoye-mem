import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packageName } from 'dsh-plugin-zhaoye';

test('DSH plugin public entry is available', () => {
  assert.equal(packageName, 'dsh-plugin-zhaoye');
});
