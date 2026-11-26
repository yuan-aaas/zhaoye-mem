import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createZhaoye } from '@zhaoye/app';
import {
  BUDGETS,
  createDefaultIdentity,
  DSH_PERSONA_CODE_POINTS,
  LIMITS,
  SECTION_NAMES,
} from '@zhaoye/contracts';
import { apply, type DshPluginContext } from 'dsh-plugin-zhaoye';
import { apply as mountAssistant } from 'dsh-plugin-zhaoye/assistant';
import type {
  DshAgent,
  DshApproval,
  InboxItem,
  SessionEvent,
  ToolDefinition,
} from '../dist/api.js';
import type { DshService } from '../dist/host.js';

test('DSH keeps profile details out of fixed instructions and reads complete bounded pages', async () => {
  const at = '2026-11-25T00:00:00.000Z';
  const document = createDefaultIdentity('00000000-0000-4000-8000-000000000001', at);
  document.safety_kernel.principles = [
    '甲'.repeat(LIMITS.principleText),
    '乙'.repeat(DSH_PERSONA_CODE_POINTS.kernel - LIMITS.principleText - 1),
  ];
  const voice = '像同事一样说话，先说重点，细节等追问。';
  const otherTrait = '按问题查看的详细性格条目';
  document.character_profile.traits.push(
    {
      id: 'reply-style',
      text: voice,
      source: 'user_explicit',
      confidence: 1,
      evidence_refs: [],
      updated_at: at,
    },
    {
      id: 'reply-detail',
      text: otherTrait,
      source: 'user_explicit',
      confidence: 1,
      evidence_refs: [],
      updated_at: at,
    },
  );
  const detail = '仅按需读取的项目说明';
  document.project_state.projects.push({
    project_id: 'project',
    name: detail,
    goal: '"\\\n🚀'.repeat(100),
    decisions: ['先读项目状态'],
    progress: [],
    blockers: [],
    next_steps: [],
    evidence_refs: ['mneme:example'],
    updated_at: at,
  });
  let prompt = () => '';
  const tools = new Map<string, ToolDefinition>();
  const agentContext = {};
  let activePreset: string | undefined = 'cordis';
  await mountAssistant({
    zhaoyeDsh: {
      async identity() {
        return { document, revision: document.revision, file_hash: '', projection_path: '' };
      },
      doctor: () => assert.fail('unexpected diagnostics call'),
      assets: () => assert.fail('unexpected asset call'),
      withTasks: () => assert.fail('unexpected task call'),
    },
    agentPresets: {
      composedPreset: (context) => (context === agentContext ? activePreset : undefined),
    },
    tools: { register: (definition) => tools.set(definition.name, definition) },
    systemPrompt: {
      section: (section) => {
        prompt = section.text;
      },
    },
    logger: { warn: (message) => assert.fail(message) },
  });
  assert.ok([...prompt()].length <= DSH_PERSONA_CODE_POINTS.fixed);
  for (const principle of document.safety_kernel.principles)
    assert.ok(prompt().includes(principle));
  assert.ok(!prompt().includes(detail));
  assert.ok(prompt().includes(voice));
  assert.ok(!prompt().includes(otherTrait));

  const tool = tools.get('zhaoye_identity_read') ?? assert.fail('missing identity read tool');
  const findTool = tools.get('zhaoye_identity_find') ?? assert.fail('missing identity find tool');
  const agent: DshAgent = {
    ctx: agentContext,
    session: {
      id: 'assistant',
      header: { agentPreset: 'cordis' },
      snapshotEvents: () => [],
    },
    status: 'idle',
    inbox: { nextStep: [], nextTurn: [] },
  };
  function read(args: object) {
    return Promise.resolve().then(() =>
      tool.execute(args, { agent, signal: new AbortController().signal, callId: 'identity' }),
    );
  }
  function find(args: object) {
    return Promise.resolve().then(() =>
      findTool.execute(args, { agent, signal: new AbortController().signal, callId: 'find' }),
    );
  }
  await assert.rejects(read({}), { code: 'UNAUTHORIZED' });
  await assert.rejects(find({ section: 'project_state', query: detail }), { code: 'UNAUTHORIZED' });
  activePreset = 'zhaoye-assistant';
  assert.deepEqual(await read({}), { revision: 1, sections: SECTION_NAMES });
  const style = document.character_profile.traits[0] ?? assert.fail('missing style fixture');
  style.source = 'model_inference';
  await read({});
  assert.ok(!prompt().includes(voice));
  style.source = 'user_confirmation';
  style.text = '长'.repeat(DSH_PERSONA_CODE_POINTS.replyStyle + 1);
  await read({});
  assert.ok(!prompt().includes(style.text));
  style.text = voice;
  const first = { section: 'project_state', revision: '1' };
  type Page = { revision: number; section: string; content: string; next_cursor: string | null };
  let page = (await read(first)) as Page;
  const firstCursor = page.next_cursor ?? assert.fail('expected multiple pages');
  const chunks: string[] = [];
  while (true) {
    assert.equal(page.revision, 1);
    assert.equal(page.section, 'project_state');
    assert.ok(page.content.length > 0);
    const [rendered] = tool.output.render({}, page);
    assert.ok(rendered);
    assert.ok([...rendered.text].length <= BUDGETS.toolResultCodePoints);
    chunks.push(page.content);
    if (!page.next_cursor) break;
    assert.ok(chunks.length < 10, 'pagination did not complete');
    page = (await read({ cursor: page.next_cursor })) as Page;
  }
  assert.deepEqual(JSON.parse(chunks.join('')), document.project_state);
  assert.ok(!prompt().includes(detail));
  await assert.rejects(read({ section: 'invalid' }), { code: 'INVALID_INPUT' });
  await assert.rejects(read({ cursor: 'project_state:1:999999' }), { code: 'INVALID_INPUT' });
  document.revision++;
  await assert.rejects(read(first), { code: 'CONFLICT' });
  await assert.rejects(read({ cursor: firstCursor }), { code: 'CONFLICT' });

  const template = document.project_state.projects[0] ?? assert.fail('missing project fixture');
  for (let index = 1; index < LIMITS.projects; index++) {
    document.project_state.projects.push({
      ...template,
      project_id: `project-${index}`,
      name: `同名项目 ${index}`,
      progress: Array.from({ length: 12 }, () => '进度'.repeat(100)),
      blockers: [`阻塞点 ${index}`],
    });
  }
  const section = 'project_state';
  const lastId = 'project-19';
  const unchanged = { section, item_id: lastId, revision: '2', field: 'blockers' };
  type FindResult = { status: string; hits: Array<{ item_id: string }>; more: boolean };
  const hits = (await find({ section, query: 'ＰＲＯＪＥＣＴ-19' })) as FindResult;
  assert.equal(hits.status, 'found');
  assert.equal(hits.hits[0]?.item_id, lastId);
  assert.deepEqual(JSON.parse(((await read(unchanged)) as Page).content), ['阻塞点 19']);
  const ambiguous = (await find({ section, query: '同名项目' })) as FindResult;
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.hits.length, 3);
  assert.equal(ambiguous.more, true);
  assert.ok([...JSON.stringify(ambiguous)].length <= DSH_PERSONA_CODE_POINTS.findResult);
  assert.equal(((await find({ section, query: '无匹配' })) as FindResult).status, 'no_match');
  await assert.rejects(read({ ...unchanged, item_id: 'missing' }), { code: 'NOT_FOUND' });
  await assert.rejects(read({ ...unchanged, field: '__proto__' }), { code: 'INVALID_INPUT' });
  await assert.rejects(read({ ...unchanged, cursor: firstCursor }), { code: 'INVALID_INPUT' });

  type ItemPage = { content: string; next_offset: string | null };
  const progress = { ...unchanged, field: 'progress' };
  let itemPage = (await read(progress)) as ItemPage;
  const progressChunks: string[] = [];
  const resume = itemPage.next_offset;
  while (true) {
    assert.ok([...JSON.stringify(itemPage)].length <= BUDGETS.toolResultCodePoints);
    progressChunks.push(itemPage.content);
    if (itemPage.next_offset === null) break;
    assert.ok(progressChunks.length < 10, 'item pagination did not complete');
    itemPage = (await read({ ...progress, offset: itemPage.next_offset })) as ItemPage;
  }
  assert.ok(resume);
  assert.deepEqual(
    JSON.parse(progressChunks.join('')),
    document.project_state.projects.at(-1)?.progress,
  );
  document.revision++;
  await assert.rejects(read({ ...progress, offset: resume }), { code: 'CONFLICT' });
  assert.ok(!prompt().includes('阻塞点 19'));

  document.safety_kernel.principles[1] += '超';
  await assert.rejects(read({}), { code: 'BUDGET_EXCEEDED' });
  assert.throws(() => prompt(), { code: 'BUDGET_EXCEEDED' });
  activePreset = undefined;
  agent.session.header.agentPreset = 'zhaoye-assistant';
  await assert.rejects(read({}), { code: 'UNAUTHORIZED' });
});

test('DSH routes multiple independent tasks to ordinary sessions and preserves their turn receipts', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'zhaoye-dsh-test-')));
  const agents = new Map<string, DshAgent>();
  const activePresets = new WeakMap<object, string>();
  const headers = new Map<string, DshAgent['session']['header']>();
  const logs = new Map<string, SessionEvent[]>();
  let sessionEvent = (_session: DshAgent['session'], _event: SessionEvent) => {};
  let claimEvent = (_event: { agent: DshAgent; message: InboxItem; turn: number }) => {};
  let approvalOutcome: Awaited<ReturnType<DshApproval['request']>> = 'rejected';
  let approvalRequests = 0;
  let dispose = async () => {};
  let mounted: DshService | undefined;
  let accepted = 0;
  let cancelled = 0;
  const signal = new AbortController().signal;

  function agent(id: string, preset: string) {
    const history: SessionEvent[] = [];
    logs.set(id, history);
    const created: DshAgent = {
      ctx: {},
      session: { id, header: { cwd: root, agentPreset: preset }, snapshotEvents: () => history },
      status: 'idle',
      inbox: { nextTurn: [], nextStep: [] },
    };
    activePresets.set(created.ctx, preset);
    agents.set(id, created);
    headers.set(id, created.session.header);
    return created;
  }

  function append(subject: DshAgent, type: string, data: SessionEvent['data']) {
    const history = logs.get(subject.session.id) ?? assert.fail('missing history');
    const event = { seq: history.length, type, data };
    history.push(event);
    sessionEvent(subject.session, event);
  }

  const ctx: DshPluginContext = {
    agents,
    sessions: { get: (id) => agents.get(id)?.session },
    workspaceRegistry: { resolveByPath: async () => undefined },
    get: () => ({
      async request({ reason }) {
        assert.match(reason, /existing-chat/);
        approvalRequests++;
        return approvalOutcome;
      },
    }),
    sessionController: {
      async create(request) {
        agent(request.sessionId, request.agentPreset);
        return { sessionId: request.sessionId };
      },
      async prompt() {
        accepted++;
        return { accepted: true };
      },
      cancel() {
        cancelled++;
        return { accepted: true };
      },
      async updateQueue() {
        return { accepted: true };
      },
      async events(request) {
        return {
          records: (logs.get(request.address.sessionId) ?? []).map((event) => ({ event })),
          hasMore: false,
        };
      },
      async *follow(request) {
        const header = headers.get(request.address.sessionId) ?? assert.fail('missing session');
        assert.equal(request.activate, false);
        yield { type: 'snapshot', header };
      },
    },
    reflect: {
      provide: (_name, service) => {
        mounted = service;
      },
    },
    effect(register) {
      dispose = register();
    },
    on: ((event: string, listener: typeof sessionEvent | typeof claimEvent) => {
      if (event === 'session/event') sessionEvent = listener as typeof sessionEvent;
      if (event === 'agent/inbox/claimed') claimEvent = listener as typeof claimEvent;
    }) as DshPluginContext['on'],
    logger: { warn: (message) => assert.fail(message) },
  };
  const tools = new Map<string, ToolDefinition>();

  async function mount() {
    apply(ctx, { dataRoot: root, initIfMissing: true });
    const service = mounted ?? assert.fail('service missing');
    await mountAssistant({
      zhaoyeDsh: service,
      agentPresets: { composedPreset: (context) => activePresets.get(context) },
      tools: { register: (definition) => tools.set(definition.name, definition) },
      systemPrompt: {
        section(section) {
          assert.match(section.text(), /安全内核/);
          assert.ok([...section.text()].length <= DSH_PERSONA_CODE_POINTS.fixed);
        },
      },
      logger: ctx.logger,
    });
    return service;
  }

  const caller = agent('assistant', 'cordis');
  activePresets.set(caller.ctx, 'zhaoye-assistant');
  const outsider = agent('other-assistant', 'zhaoye-assistant');
  function invoke(name: string, input: object, asAgent = caller, callId = name) {
    const tool = tools.get(name) ?? assert.fail(`missing tool ${name}`);
    return Promise.resolve().then(() => tool.execute(input, { agent: asAgent, callId, signal }));
  }
  const input = { goal: '读取项目文件', acceptance: '报告结果' };
  try {
    const rootOwner = await createZhaoye({
      dataRoot: root,
      host: {
        host_id: 'cli',
        display_name: 'Test',
        capabilities: [],
        adapter_version: '0.1.0',
        data_schema: 1,
      },
    });
    const assetId = 'config';
    const assetBody = '"\\\n🚀'.repeat(300);
    try {
      const bundle = join(root, 'assets', 'files', assetId);
      await mkdir(bundle);
      await writeFile(
        join(bundle, 'manifest.json'),
        '{"name":"Config","description":"","version":"1.0.0","modules":{}}',
      );
      await writeFile(join(bundle, 'README.md'), assetBody);
      await rootOwner.assets.registerConfigBundle(assetId);
    } finally {
      await rootOwner.close();
    }
    const service = await mount();
    assert.equal((await service.doctor()).presence.state, 'active');
    const diagnostics = (await invoke('zhaoye_doctor', {})) as Awaited<
      ReturnType<DshService['doctor']>
    >;
    assert.equal(diagnostics.presence.state, 'active');
    const find = 'zhaoye_asset_find';
    const read = 'zhaoye_asset_read';
    assert.deepEqual(await invoke(find, { asset_id: assetId, query: 'readme' }), {
      asset_id: assetId,
      items: ['README.md'],
      next_offset: null,
    });
    const loc = { asset_id: assetId, path: 'README.md' };
    type Page = { content: string; sha256: string; next_offset: string | null };
    let page = (await invoke(read, loc)) as Page;
    assert.ok(page.next_offset);
    await assert.rejects(invoke(read, { ...loc, offset: page.next_offset }), {
      code: 'INVALID_INPUT',
    });
    await assert.rejects(
      invoke(read, { ...loc, offset: page.next_offset, sha256: '0'.repeat(64) }),
      { code: 'CONFLICT' },
    );
    const chunks: string[] = [];
    while (true) {
      assert.ok([...JSON.stringify(page)].length <= BUDGETS.toolResultCodePoints);
      chunks.push(page.content);
      if (page.next_offset === null) break;
      assert.ok(chunks.length < 10);
      page = (await invoke(read, {
        ...loc,
        offset: page.next_offset,
        sha256: page.sha256,
      })) as Page;
    }
    assert.equal(chunks.join(''), assetBody);
    await assert.rejects(invoke('zhaoye_delegate', { ...input, cwd: root }), {
      code: 'INVALID_INPUT',
    });
    const launched = (await invoke('zhaoye_delegate', input)) as {
      task_id: string;
      target_session_id: string;
      request_id: string;
      status: string;
    };
    assert.equal(launched.status, 'queued');
    assert.deepEqual(await invoke('zhaoye_delegate', input), launched);
    assert.equal(accepted, 1);
    const worker = agents.get(launched.target_session_id) ?? assert.fail('target missing');
    assert.equal(worker.session.header.agentPreset, 'standard');
    const query = { task_id: launched.task_id };
    await assert.rejects(invoke('zhaoye_identity_read', {}, worker), { code: 'UNAUTHORIZED' });
    await assert.rejects(invoke(find, {}, worker), { code: 'UNAUTHORIZED' });
    await assert.rejects(invoke('zhaoye_task_status', query, outsider), { code: 'NOT_FOUND' });
    const crossProject = agent('cross-project', 'standard');
    crossProject.session.header.cwd = dirname(root);
    const subagent = agent('child', 'standard');
    subagent.session.header.origin = 'subagent';
    for (const [target, code] of [
      [caller, 'INVALID_INPUT'],
      [crossProject, 'UNAUTHORIZED'],
      [subagent, 'UNAUTHORIZED'],
    ] as const) {
      await assert.rejects(
        invoke(
          'zhaoye_delegate',
          { ...input, target_session_id: target.session.id },
          caller,
          target.session.id,
        ),
        { code },
      );
    }
    const existing = agent('existing-chat', 'minimal');
    agents.delete(existing.session.id);
    const request = { ...input, target_session_id: existing.session.id };
    await assert.rejects(invoke('zhaoye_delegate', request, caller, 'deny-existing'), {
      code: 'UNAUTHORIZED',
    });
    assert.equal(accepted, 1);
    approvalOutcome = 'allowed-once';
    const directed = (await invoke(
      'zhaoye_delegate',
      request,
      caller,
      'send-to-existing',
    )) as typeof launched;
    agents.set(existing.session.id, existing);
    assert.equal(directed.target_session_id, existing.session.id);
    assert.equal(existing.session.header.agentPreset, 'minimal');
    assert.equal(accepted, 2);
    assert.equal(approvalRequests, 2);
    approvalOutcome = 'rejected';
    await assert.rejects(invoke('zhaoye_delegate', request, caller, 'new-existing-request'), {
      code: 'UNAUTHORIZED',
    });
    assert.equal(accepted, 2);

    append(worker, 'turn/start', { turn: 1 });
    append(worker, 'user/message', { source: { rpcId: 'previous-input' } });
    append(worker, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    assert.equal(
      ((await invoke('zhaoye_task_status', query)) as { status: string }).status,
      'queued',
    );
    append(worker, 'turn/start', { turn: 2 });
    worker.status = 'running';
    claimEvent({
      agent: worker,
      turn: 2,
      message: { id: 'delegated-input', source: { kind: 'user', rpcId: launched.request_id } },
    });
    claimEvent({
      agent: worker,
      turn: 2,
      message: { id: 'direct-input', source: { kind: 'user' } },
    });
    await assert.rejects(invoke('zhaoye_task_cancel', query), { code: 'CONFLICT' });
    assert.equal(cancelled, 0);
    append(worker, 'user/message', { source: { rpcId: launched.request_id } });
    append(existing, 'turn/start', { turn: 1 });
    append(existing, 'user/message', { source: { rpcId: directed.request_id } });
    assert.equal(
      ((await invoke('zhaoye_task_status', { task_id: directed.task_id })) as { status: string })
        .status,
      'running',
    );
    append(existing, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    append(worker, 'user/message', { source: { kind: 'user', rpcId: 'additional-user-input' } });
    await assert.rejects(invoke('zhaoye_task_cancel', query), { code: 'CONFLICT' });
    assert.equal(
      ((await invoke('zhaoye_task_status', query)) as { status: string }).status,
      'running',
    );

    await dispose();
    assert.equal((await service.doctor()).presence.state, 'none');
    sessionEvent = () => {};
    append(worker, 'turn/end', { turn: 2, reason: { kind: 'completed' } });
    append(worker, 'turn/start', { turn: 3 });
    append(worker, 'user/message', { source: { rpcId: 'direct-followup' } });
    agents.delete(worker.session.id);
    await mount();
    const status = await invoke('zhaoye_task_status', query);
    assert.deepEqual(
      { ...(status as { status: string; turn_id: number }), updated_at: undefined },
      {
        ...launched,
        status: 'completed',
        turn_id: 2,
        reason: 'completed',
        updated_at: undefined,
      },
    );
    assert.deepEqual(await invoke('zhaoye_task_cancel', query), status);
    assert.equal(cancelled, 0);
    assert.equal(caller.session.snapshotEvents().length, 0);
  } finally {
    await dispose();
    await rm(root, { recursive: true, force: true });
  }
});
