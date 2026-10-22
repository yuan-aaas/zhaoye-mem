import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, utimes, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolvePluginConfig, expandHome } from '../lib/config.js';
import { projectForCwd, resolveWorkerDirectory } from '../lib/projects.js';
import { renderIdentity, renderMemoryIndex, renderPinnedMemories, isPinned, renderProfileInvitation, truncate } from '../lib/prompt.js';
import { parseWorkerReceipt } from '../lib/receipt.js';
import { TaskStore } from '../lib/task-store.js';
import { createHostService } from '../lib/host.js';
import { createAssistantTools } from '../lib/tools.js';
import { delegateTask, cancelTask } from '../lib/delegate.js';
import { apply as applyAgent } from '../lib/agent.js';
import { initializeAssistantData } from '../../../dist/src/index.js';

async function temp(prefix = 'assistant-dsh-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test('config resolves defaults, home paths, and project map', () => {
  const config = resolvePluginConfig({ dataRoot: '~/.zhaoye-test', projectMap: { demo: '~/demo' } });
  assert.equal(config.dataRoot, path.join(os.homedir(), '.zhaoye-test'));
  assert.equal(config.projectMap.demo, path.join(os.homedir(), 'demo'));
  assert.equal(config.workerPreset, 'assistant-worker');
  assert.equal(config.memoryIndexLimit, 5);
  assert.equal(config.memoryIndexBudget, 600);
  assert.equal(config.pinnedLimit, 3);
  assert.equal(config.pinnedBudget, 600);
  assert.equal(expandHome('~'), os.homedir());
  assert.throws(() => resolvePluginConfig({ projectMap: { '../bad': 'x' } }));
});

test('project resolution uses the longest registered prefix', async () => {
  const root = await temp('assistant-dsh-projects-');
  try {
    const nested = path.join(root, 'nested');
    await mkdir(nested);
    assert.equal(projectForCwd(nested, { demo: root, inner: nested }), 'inner');
    const resolved = await resolveWorkerDirectory('demo', { demo: root }, undefined);
    assert.equal(resolved.projectId, 'demo');
    await assert.rejects(() => resolveWorkerDirectory('missing', { demo: root }, undefined));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prompt renderers stay within budget and include the index preview', () => {
  const identity = {
    revision: 1,
    identity_hash: 'x',
    kernel: '# Lead 内核\n你是助手。',
    user_profile: { display_name: '小林', facts: [{ key: 'role', value: '开发者' }] },
    habits: { templates: ['lead-first'] },
  };
  const text = renderIdentity(identity, 1600);
  assert.match(text, /助手规则/);
  assert.match(text, /小林/);
  assert.equal([...renderIdentity(identity, 80)].length <= 80, true);
  const item = {
    content: '回答请先给结论，不要长篇大论。', tags: ['communication'], created_at: '2026-10-21T00:00:00.000Z', occurred_at: null,
  };
  const index = renderMemoryIndex([item], 3, 1200);
  assert.match(index, /共 3 条/);
  assert.match(index, /回答请先给结论/);
  const longItem = { ...item, content: '甲'.repeat(80) };
  const longIndex = renderMemoryIndex([longItem], 1, 600, 30);
  const line = longIndex.split('\n')[1];
  assert.equal([...line.split(' ').at(-1)].length <= 31, true);
  const pinnedItem = { ...item, content: '置顶的完整偏好正文', tags: ['pin', 'preference'] };
  assert.equal(isPinned(pinnedItem), true);
  const pinned = renderPinnedMemories([pinnedItem], 600);
  assert.match(pinned, /置顶记忆/);
  assert.match(pinned, /置顶的完整偏好正文/);
  assert.match(renderProfileInvitation(), /第一条回复/);
  assert.equal(truncate('abcdef', 4), 'abc…');
});

test('worker receipt verification rejects traversal and mismatched quotes', async () => {
  const root = await temp('assistant-dsh-receipt-');
  try {
    await writeFile(path.join(root, 'a.txt'), '第一行\n第二行\n第三行\n');
    const good = await parseWorkerReceipt(JSON.stringify({
      summary: '读到了内容',
      evidence_refs: [{ path: 'a.txt', start_line: 1, end_line: 2, quote: '第二行' }],
      artifact_refs: ['a.txt'],
      pending_questions: [],
    }), root);
    assert.equal(good.evidence_refs[0].path, 'a.txt');
    assert.equal(good.evidence_refs[0].sha256.length, 64);
    assert.deepEqual(good.artifact_refs, ['a.txt']);
    await assert.rejects(() => parseWorkerReceipt(JSON.stringify({
      summary: '坏路径', evidence_refs: [{ path: '../a.txt', start_line: 1, end_line: 1 }], pending_questions: [],
    }), root));
    await assert.rejects(() => parseWorkerReceipt(JSON.stringify({
      summary: '坏产物', evidence_refs: [], artifact_refs: ['../a.txt'], pending_questions: [],
    }), root));
    await assert.rejects(() => parseWorkerReceipt(JSON.stringify({
      summary: '错引用', evidence_refs: [{ path: 'a.txt', start_line: 1, end_line: 1, quote: '第二行' }], pending_questions: [],
    }), root));
    await assert.rejects(() => parseWorkerReceipt('not json', root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('task store persists and reconciles running tasks after restart', async () => {
  const root = await temp('assistant-dsh-tasks-');
  try {
    const store = new TaskStore(root);
    const task = await store.create({
      parent_session_id: 's1', child_session_id: null, objective: '读 README', acceptance: '', necessary_context: '',
      project_id: null, cwd: root,
    });
    await store.update(task.task_id, { status: 'running', child_session_id: 'c1' });
    const reopened = new TaskStore(root);
    const loaded = await reopened.get(task.task_id);
    assert.equal(loaded.status, 'unknown');
    assert.equal(loaded.error_code, 'RESTARTED');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('agent tools use the framework API for memory and identity', async () => {
  const root = await temp('assistant-dsh-host-');
  try {
    const config = resolvePluginConfig({ dataRoot: root, stateDir: path.join(root, 'state'), autoInit: true, projectMap: {} });
    const service = createHostService(config);
    await service.ready;
    await service.refresh();
    assert.match(service.identityText, /助手规则/);
    assert.match(service.memoryText, /暂无明确保存/);
    const tools = createAssistantTools(service, service.tasks, {});
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const exec = { agent: { id: 's1', session: { id: 's1', header: { cwd: root } } } };
    const saved = await byName.get('assistant_remember').execute({ content: '用户明确保存的内容', tags: ['demo'] }, exec);
    assert.equal(saved.revision, 1);
    await byName.get('assistant_remember').execute({ content: '置顶正文：回答先给结论。', tags: ['pin', 'preference'] }, exec);
    assert.match(service.memoryText, /置顶记忆/);
    assert.match(service.memoryText, /置顶正文：回答先给结论/);
    assert.match(service.memoryText, /显式记忆目录/);
    const located = await byName.get('assistant_locate').execute({ query: '明确' }, exec);
    assert.equal(located.routes.length, 1);
    const recalled = await byName.get('assistant_recall').execute({ record_id: located.routes[0].record_id }, exec);
    assert.equal(recalled.content, '用户明确保存的内容');
    assert.match(service.memoryText, /用户明确保存的内容/);
    const preview = await byName.get('assistant_identity_preview').execute({ user_profile: { display_name: '小林' } }, exec);
    assert.equal(preview.before.user_profile.display_name, null);
    await byName.get('assistant_identity_commit').execute({ proposal_id: preview.proposal_id, expected_revision: preview.expected_revision }, exec);
    assert.equal(service.identity.user_profile.display_name, '小林');
    const archived = await byName.get('assistant_archive').execute({ record_id: saved.record_id, expected_revision: 1 }, exec);
    assert.equal(archived.status, 'saved');
    await service.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('delegate opens an independent worker session and records a verified receipt', async () => {
  const root = await temp('assistant-dsh-delegate-');
  try {
    await initializeAssistantData(root);
    await writeFile(path.join(root, 'README.md'), '# demo\nline two\nline three\n');
    const config = resolvePluginConfig({ dataRoot: root, stateDir: path.join(root, 'state'), autoInit: false, projectMap: {} });
    const service = createHostService(config);
    await service.ready;
    const notifications = [];
    const parent = {
      id: 'parent-1',
      session: { id: 'parent-1', header: { cwd: root } },
      followup(message) { notifications.push(message); },
      inject(message) { notifications.push(message); },
    };
    const receipt = {
      summary: 'README 说明这是 demo',
      evidence_refs: [{ path: 'README.md', start_line: 1, end_line: 2, quote: 'line two' }],
      artifact_refs: ['README.md'],
      pending_questions: [],
    };
    let events = [];
    const created = [];
    const prompted = [];
    const cancelled = [];
    const ctx = {
      sessionController: {
        async create(request) {
          created.push(request);
          return { sessionId: 'worker-1' };
        },
        async prompt(request) {
          prompted.push(request);
          events = [
            { seq: 0, type: 'turn/start', data: {} },
            { seq: 1, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(receipt) }] } } },
            { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
          ];
          return { accepted: true };
        },
        cancel(request) { cancelled.push(request); },
      },
      sessions: { get: (id) => (id === 'worker-1' ? { snapshotEvents: () => events } : undefined) },
      logger: { warn() {} },
    };
    const result = await delegateTask({ objective: '读 README', acceptance: '', necessaryContext: '', projectId: null }, { agent: parent }, { ctx, service, tasks: service.tasks });
    assert.equal(result.status, 'running');
    assert.equal(result.session_id, 'worker-1');
    assert.equal(created.length, 1);
    assert.equal(created[0].agentPreset, 'assistant-worker');
    assert.equal(created[0].workspaceId, undefined);
    assert.match(prompted[0].content[0].text, /独立的工作会话/);
    assert.equal(prompted[0].mode, 'queue');
    for (let index = 0; index < 300; index += 1) {
      const status = await service.tasks.get(result.task_id);
      if (status?.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const task = await service.tasks.get(result.task_id);
    assert.equal(task.status, 'completed');
    assert.equal(task.child_session_id, 'worker-1');
    assert.equal(task.receipt.evidence_refs[0].sha256.length, 64);
    assert.deepEqual(task.receipt.artifact_refs, ['README.md']);
    assert.match(notifications[0].content[0].text, /产物/);
    assert.match(notifications[0].content[0].text, /会话 worker-1/);
    assert.equal(notifications.length, 1);
    assert.equal(cancelled.length, 0);
    await service.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('delegate degrades a prose answer into a summary receipt', async () => {
  const root = await temp('assistant-dsh-degrade-');
  try {
    await initializeAssistantData(root);
    const config = resolvePluginConfig({ dataRoot: root, stateDir: path.join(root, 'state'), autoInit: false, projectMap: {} });
    const service = createHostService(config);
    await service.ready;
    const parent = { id: 'parent-2', session: { id: 'parent-2', header: { cwd: root } }, followup() {}, inject() {} };
    const prose = `${'结论很长。'.repeat(200)}`;
    let events = [];
    const ctx = {
      sessionController: {
        async create() { return { sessionId: 'worker-2' }; },
        async prompt() {
          events = [
            { seq: 0, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: prose }] } } },
            { seq: 1, type: 'turn/end', data: {} },
          ];
          return { accepted: true };
        },
        cancel() {},
      },
      sessions: { get: () => ({ snapshotEvents: () => events }) },
      logger: { warn() {} },
    };
    const result = await delegateTask({ objective: '随便看看', acceptance: '', necessaryContext: '', projectId: null }, { agent: parent }, { ctx, service, tasks: service.tasks });
    for (let index = 0; index < 300; index += 1) {
      const status = await service.tasks.get(result.task_id);
      if (status?.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const task = await service.tasks.get(result.task_id);
    assert.equal(task.status, 'completed');
    assert.equal(task.receipt.degraded, true);
    assert.equal([...task.receipt.summary].length <= 600, true);
    assert.deepEqual(task.receipt.evidence_refs, []);
    await service.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cancel asks the session controller to stop the worker session', async () => {
  const root = await temp('assistant-dsh-cancel-');
  try {
    await initializeAssistantData(root);
    const config = resolvePluginConfig({ dataRoot: root, stateDir: path.join(root, 'state'), autoInit: false, projectMap: {} });
    const service = createHostService(config);
    await service.ready;
    const parent = { id: 'parent-3', session: { id: 'parent-3', header: { cwd: root } }, followup() {}, inject() {} };
    const cancelled = [];
    const ctx = {
      sessionController: {
        async create() { return { sessionId: 'worker-3' }; },
        async prompt() { return { accepted: true }; },
        cancel(request) { cancelled.push(request); },
      },
      sessions: { get: () => ({ snapshotEvents: () => [] }) },
      logger: { warn() {} },
    };
    const result = await delegateTask({ objective: '慢慢来', acceptance: '', necessaryContext: '', projectId: null }, { agent: parent }, { ctx, service, tasks: service.tasks });
    const stopped = await cancelTask(result.task_id, { agent: parent }, { ctx, tasks: service.tasks });
    assert.equal(stopped.status, 'cancelled');
    assert.deepEqual(cancelled, [{ sessionId: 'worker-3' }]);
    await service.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('host clears a stale writer lock whose owner pid is dead', async () => {
  const root = await temp('assistant-dsh-stale-');
  try {
    await initializeAssistantData(root);
    await mkdir(path.join(root, '.writer.lock'));
    await writeFile(path.join(root, '.writer.lock', 'owner.json'), JSON.stringify({ pid: 999999, started_at: '2000-01-01T00:00:00.000Z', assistant_id: 'stale' }));
    const config = resolvePluginConfig({ dataRoot: root, stateDir: path.join(root, 'state'), autoInit: false, recoverStaleLock: true });
    const service = createHostService(config);
    await service.ready;
    await service.refresh();
    const owner = JSON.parse(await readFile(path.join(root, '.writer.lock', 'owner.json'), 'utf8'));
    assert.equal(owner.pid, process.pid);
    assert.match(service.identityText, /助手规则/);
    await service.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('host clears an empty lock directory after the grace window', async () => {
  const root = await temp('assistant-dsh-orphan-');
  try {
    await initializeAssistantData(root);
    const lockDir = path.join(root, '.writer.lock');
    await mkdir(lockDir);
    const past = new Date(Date.now() - 60_000);
    await utimes(lockDir, past, past);
    const config = resolvePluginConfig({ dataRoot: root, stateDir: path.join(root, 'state'), autoInit: false, recoverStaleLock: true });
    const service = createHostService(config);
    await service.ready;
    await service.refresh();
    assert.match(service.identityText, /助手规则/);
    await service.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('host waits for a same-process lock to be released', async () => {
  const root = await temp('assistant-dsh-retry-');
  try {
    await initializeAssistantData(root);
    const lockDir = path.join(root, '.writer.lock');
    await mkdir(lockDir);
    await writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), assistant_id: 'self' }));
    const timer = setTimeout(() => { void rm(lockDir, { recursive: true, force: true }); }, 100);
    const config = resolvePluginConfig({ dataRoot: root, stateDir: path.join(root, 'state'), autoInit: false, recoverStaleLock: true });
    const service = createHostService(config);
    await service.ready;
    clearTimeout(timer);
    const owner = JSON.parse(await readFile(path.join(lockDir, 'owner.json'), 'utf8'));
    assert.equal(owner.pid, process.pid);
    await service.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('agent apply restricts global tools on the created agent context', async () => {
  const root = await temp('assistant-dsh-restrict-');
  try {
    const config = resolvePluginConfig({ dataRoot: root, stateDir: path.join(root, 'state'), autoInit: false });
    const agentTools = {
      restrictCalls: [],
      guardCalls: [],
      register: () => () => {},
      schemas: () => ['memory_save', 'memory_search', 'canvas_add_note', 'assistant_locate', 'ask_user_question'].map((name) => ({ name })),
      restrict(filter) { this.restrictCalls.push(filter); },
      guard(fn) { this.guardCalls.push(fn); },
      get(name) { return name === 'assistant_locate' ? { name } : undefined; },
    };
    const globalTools = {
      register: () => () => {},
      schemas: () => [{ name: 'memory_save' }],
      restrict() { throw new Error('restrict requires a scoped context'); },
      guard() {},
      get() { return undefined; },
    };
    let created;
    const ctx = {
      assistant: {
        config,
        tasks: {},
        ready: Promise.resolve({}),
        identity: null,
        identityText: '身份',
        memoryText: '记忆',
        profileInvitation: () => '',
        projectForCwd: () => null,
      },
      logger: { warn() {} },
      tools: globalTools,
      systemPrompt: { section() {}, context() {} },
      effect: (fn) => fn(),
      on: (event, fn) => { if (event === 'agent/created') created = fn; },
      get: () => undefined,
    };
    applyAgent(ctx);
    assert.equal(typeof created, 'function');
    created({ agent: { id: 'a1', session: { id: 'a1' }, ctx: { tools: agentTools, get: (name) => name === 'agentPresets' ? { composedPreset: () => 'assistant' } : undefined } } });
    const denied = new Set(agentTools.restrictCalls.flatMap((filter) => filter.deny ?? []));
    assert.equal(denied.has('memory_save'), true);
    assert.equal(denied.has('canvas_add_note'), true);
    assert.equal(denied.has('assistant_locate'), false);
    assert.equal(denied.has('ask_user_question'), false);
    assert.equal(agentTools.guardCalls.length > 0, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
