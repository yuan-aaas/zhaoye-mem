import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageDirectories = [
  'packages/contracts',
  'packages/storage',
  'packages/core',
  'packages/app',
  'packages/adapter-kit',
  'packages/cli',
  'plugins/dsh',
  'plugins/mcp',
];

async function readManifest(path) {
  return JSON.parse(await readFile(resolve(root, path), 'utf8'));
}

const rootManifest = await readManifest('package.json');
const mismatches = [];

for (const directory of packageDirectories) {
  const manifest = await readManifest(`${directory}/package.json`);
  if (manifest.version !== rootManifest.version) {
    mismatches.push(`${directory}: ${manifest.version} (root: ${rootManifest.version})`);
  }
}

if (mismatches.length > 0) {
  process.stderr.write(`Package versions must match root ${rootManifest.version}:\n`);
  process.stderr.write(`${mismatches.map((item) => `- ${item}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`All 8 workspace packages use version ${rootManifest.version}.\n`);
}
