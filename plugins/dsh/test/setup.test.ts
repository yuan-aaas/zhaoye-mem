import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createZhaoye } from '@zhaoye/app';
import { ZhaoyeError } from '@zhaoye/contracts';
import type { DshSession } from '../dist/api.js';
import { createSetup, type DshSetupConnection } from '../dist/setup.js';
import type { SetupStatus } from '../dist/setup-api.js';

test('DSH setup initializes a selected root, prepares chat, and installs a skill on request', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'zhaoye-setup-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const start = join(temp, 'default');
  const selected = join(temp, 'selected');
  const second = join(temp, 'other');
  const dshHome = join(temp, 'dsh');
  const active: DshSession = {
    id: 'assistant',
    header: { agentPreset: 'zhaoye-assistant' },
    snapshotEvents: () => [],
  };
  let busy = false;
  const options: Parameters<typeof createSetup>[0] = {
    defaultRoot: start,
    dshHome,
    async activate(_dataRoot, persist) {
      if (busy) throw new ZhaoyeError('LOCKED', '照夜还有任务在运行');
      await persist();
    },
    async initialize(dataRoot) {
      const app = await createZhaoye({
        dataRoot,
        initIfMissing: true,
        host: {
          host_id: 'dsh',
          display_name: 'Test',
          capabilities: [],
          adapter_version: '0.1.0',
          data_schema: 1,
        },
      });
      await app.close();
    },
    async prepareChat() {},
    async skills() {
      return [{ name: 'already-present' }];
    },
    session: (id) => (id === active.id ? active : undefined),
    async readyPreset() {
      return true;
    },
    logger: { warn: assert.fail },
  };
  function api() {
    const setup = createSetup(options);
    let handler!: Parameters<DshSetupConnection['fetch']['register']>[0]['fetch'];
    setup.bind({
      fetch: {
        register(route) {
          handler = route.fetch;
        },
      },
    });
    return async function request(input?: object) {
      const response = await handler(
        new Request(
          'http://127.0.0.1/api/zhaoye/onboarding',
          input
            ? {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(input),
              }
            : {},
        ),
      );
      return { code: response.status, data: await response.json() };
    };
  }
  const request = api();
  assert.equal((await request()).data.ready, false);
  assert.equal((await request({ action: 'start' })).code, 409);
  assert.equal((await request({ action: 'configure', dataRoot: '../relative' })).code, 409);
  const configured = await request({ action: 'configure', dataRoot: selected, initialize: true });
  assert.equal(configured.code, 200);
  const initial = configured.data as SetupStatus;
  assert.equal(initial.ready, true);
  assert.equal(initial.dataRoot, selected);
  assert.deepEqual(
    [initial.identity.path, initial.backup.path, initial.assets.path],
    [join(selected, 'identity'), join(selected, 'backup'), join(selected, 'assets')],
  );
  const bundle = join(selected, 'assets', 'files', 'config');
  for (const name of ['daily-report', 'already-present']) {
    const source = join(bundle, '01-skills', name);
    await mkdir(join(source, 'references'), { recursive: true });
    await writeFile(
      join(source, 'SKILL.md'),
      `---\nname: ${name}\ndescription: sample\n---\n# Hello\n`,
    );
    await writeFile(join(source, 'references', 'notes.md'), 'reference fixture');
  }
  assert.deepEqual(
    (await request()).data.skills.map((item: { installed: boolean }) => item.installed),
    [true, false],
  );
  assert.deepEqual((await request({ action: 'notice', sessionId: 'normal' })).data.missing, []);
  assert.deepEqual((await request({ action: 'notice', sessionId: active.id })).data.missing, [
    'daily-report',
  ]);
  assert.deepEqual((await request({ action: 'notice', sessionId: active.id })).data.missing, []);
  assert.equal((await request({ action: 'install', skillId: '../../unknown' })).code, 409);
  assert.equal((await request({ action: 'install', skillId: 'config/daily-report' })).code, 200);
  assert.equal(
    await readFile(join(dshHome, 'skills', 'daily-report', 'references', 'notes.md'), 'utf8'),
    'reference fixture',
  );
  assert.deepEqual((await request({ action: 'start' })).data, { preset: 'zhaoye-assistant' });
  const preview = await request({ action: 'configure', dataRoot: second });
  assert.equal(preview.data.canInitialize, true);
  assert.equal((await request()).data.dataRoot, selected);
  busy = true;
  assert.equal(
    (await request({ action: 'configure', dataRoot: second, initialize: true })).code,
    409,
  );
  assert.equal((await request()).data.dataRoot, selected);
  busy = false;
  const switched = await request({ action: 'configure', dataRoot: second });
  assert.equal(switched.code, 200);
  assert.equal(switched.data.dataRoot, second);
  assert.equal((await request({ action: 'start' })).code, 200);
  const restarted = await api()();
  assert.deepEqual([restarted.data.dataRoot, restarted.data.ready], [second, true]);
});
