import { access, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { createZhaoye } from '../../packages/app/dist/index.js';

const config = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8'));
let app;
try {
  app = await createZhaoye({
    dataRoot: config.root,
    initIfMissing: false,
    host: {
      host_id: 'cli',
      display_name: 'cross-process',
      capabilities: [],
      adapter_version: '0.1.0',
      data_schema: 1,
    },
  });
  await writeFile(config.ready, JSON.stringify({ ok: true, pid: process.pid }));
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      await access(config.stop);
      break;
    } catch {}
    await setTimeout(25);
  }
} catch (e) {
  await writeFile(
    config.ready,
    JSON.stringify({ ok: false, code: e.code ?? 'UNKNOWN', message: String(e) }),
  );
  process.exitCode = 1;
} finally {
  if (app) await app.close();
}
