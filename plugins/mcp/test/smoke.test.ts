import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packageName } from '@zhaoye/mcp';

test('MCP plugin public entry is available', () => {
  assert.equal(packageName, '@zhaoye/mcp');
});
