#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function run(
  args: string[] = process.argv.slice(2),
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): number {
  if (args.length === 1 && args[0] === '--version') {
    const manifestUrl = new URL('../package.json', import.meta.url);
    const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as { version: string };
    write(manifest.version);
    return 0;
  }

  process.stderr.write('Usage: zhaoye --version\n');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run();
}
