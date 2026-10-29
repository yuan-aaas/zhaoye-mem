import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packageName, run } from '@zhaoye/cli';

test('cli public entry is available', () => {
  assert.equal(packageName, '@zhaoye/cli');
});

test('cli reports its version flag', () => {
  const output: string[] = [];
  assert.equal(
    run(['--version'], (line) => output.push(line)),
    0,
  );
  assert.deepEqual(output, ['0.1.0']);
});
