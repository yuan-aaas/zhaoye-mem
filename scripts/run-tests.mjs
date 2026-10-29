import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const testFiles = [];

async function collectTests(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectTests(path);
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      testFiles.push(path);
    }
  }
}

for (const rootDirectory of ['packages', 'plugins']) {
  const parent = resolve(root, rootDirectory);
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (entry.isDirectory()) await collectTests(resolve(parent, entry.name, 'dist-test'));
  }
}

await collectTests(resolve(root, 'tests-dist'));
testFiles.sort();

if (testFiles.length === 0) {
  process.stderr.write('No compiled test files found under packages/*/dist-test or tests-dist.\n');
  process.exitCode = 1;
} else {
  for (const testFile of testFiles) await import(pathToFileURL(testFile).href);
}
