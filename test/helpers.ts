import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { initRoot, openRuntime, type Runtime } from '../src/infrastructure/runtime.js';

export async function withRuntime(run: (runtime: Runtime) => Promise<void>): Promise<void> {
  const testRoot = path.join(process.cwd(), 'plugin_test', '.test-tmp');
  await mkdir(testRoot, { recursive: true });
  const base = await mkdtemp(path.join(testRoot, 'zhaoye-test-'));
  const root = path.join(base, 'data');
  await initRoot(root);
  const runtime = await openRuntime(root);
  try { await run(runtime); } finally { await runtime.close(); await rm(base, { recursive: true, force: true }); }
}
