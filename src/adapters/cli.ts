import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AssistantError, userMessage } from '../contracts/errors.js';
import { AttributionSchema } from '../contracts/schemas.js';
import type { Runtime } from '../infrastructure/runtime.js';
import { initRoot, openRuntime } from '../infrastructure/runtime.js';
import { MemoryCore } from '../memory-core/memory.js';
import { AssistantFramework } from '../framework/assistant.js';
import { IdentityPatchSchema } from '../contracts/identity.js';
import { ChatCompletionsModel } from './model-chat.js';
import { LocalWorker } from './local-worker.js';
import { TaskService } from './tasks.js';
import { LeadLoop, type TurnContext } from './local-lead-loop.js';
import { offerProfileSetup, runProfileSetup } from './profile-setup.js';

type Args = { command: string; root: string; projects: Map<string, string>; rest: string[] };
function parseArgs(args: string[]): Args {
  const command = args[0] ?? 'help';
  let root = './.local-data';
  const projects = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--root') { root = args[++i] ?? root; continue; }
    if (arg === '--project') {
      const spec = args[++i] ?? '';
      const at = spec.indexOf('=');
      if (at < 1) throw new AssistantError('INVALID_INPUT', '项目参数格式必须为 --project alias=path。');
      const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/).parse(spec.slice(0, at));
      if (projects.has(id)) throw new AssistantError('CONFLICT', `项目别名重复：${id}`);
      projects.set(id, spec.slice(at + 1)); continue;
    }
    rest.push(arg);
  }
  return { command, root, projects, rest };
}

function usage(): void {
  stdout.write(`助手最小版\n\n命令：\n  init --root <目录> [--template lead]\n  chat --root <目录> [--project alias=路径 ...]\n  doctor --root <目录>\n  identity preview --root <目录> --patch <json文件>\n  identity apply --root <目录> --proposal <id> --expected-revision <n>\n\nchat 命令：/profile、/remember、/recall、/replace、/archive、/tasks、/task、/retry、/cancel、/quit\n/profile：选择助手模板并自愿填写画像；各项可留空，预览后保存。\n`);
}

async function readOnlyDoctor(root: string): Promise<void> {
  const { validateManifest, verifyIdentity } = await import('../infrastructure/runtime.js');
  const manifest = await validateManifest(`${root}/manifest.json`);
  const identity = await verifyIdentity(root);
  const { Journal } = await import('../infrastructure/journal.js');
  const content = new Journal(`${root}/data/user-explicit/records.jsonl`, 10_000, 32 * 1024 * 1024);
  const events = new Journal(`${root}/state/events.jsonl`, 100_000, 64 * 1024 * 1024);
  const [contentEvents, metaEvents] = await Promise.all([content.replay(), events.replay()]);
  const lock = await import('node:fs/promises').then((fs) => fs.access(`${root}/.writer.lock`).then(() => true).catch(() => false));
  stdout.write(JSON.stringify({ root, assistant_id: manifest.assistant_id, identity_revision: identity.revision, content_events: contentEvents.length, metadata_events: metaEvents.length, writer_locked: lock, status: 'healthy_read_only' }, null, 2) + '\n');
}

function parseFlags(input: string): { flags: Map<string, string[]>; body: string } {
  const flags = new Map<string, string[]>();
  const rest: string[] = [];
  const parts = input.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (part.startsWith('--')) {
      const key = part.slice(2);
      const value = parts[i + 1];
      if (!value || value.startsWith('--')) throw new AssistantError('INVALID_INPUT', `缺少 --${key} 的值。`);
      const values = flags.get(key) ?? []; values.push(value.replace(/^"|"$/g, '')); flags.set(key, values); i += 1;
    } else rest.push(part.replace(/^"|"$/g, ''));
  }
  return { flags, body: rest.join(' ') };
}

function attribution(mode: string | undefined) {
  const entry = mode === 'user'
    ? { origin: 'user_direct', attributed_to: 'user', user_stance: 'not_stated', derivation: 'verbatim' }
    : mode === 'quote'
      ? { origin: 'user_quote', attributed_to: 'external_author', user_stance: 'not_stated', derivation: 'verbatim' }
      : mode === 'external'
        ? { origin: 'external', attributed_to: 'external_author', user_stance: 'not_stated', derivation: 'verbatim' }
        : { origin: 'unknown', attributed_to: 'unknown', user_stance: 'not_stated', derivation: 'unknown' };
  return AttributionSchema.parse(entry);
}

async function handleChatCommand(command: string, runtime: Runtime, framework: AssistantFramework, tasks: TaskService, projectId: string | null): Promise<boolean> {
  const [name, ...tokens] = command.trim().split(/\s+/);
  if (name === '/quit' || name === '/exit') return false;
  if (name === '/help') { usage(); return true; }
  if (name === '/remember') {
    const { flags, body } = parseFlags(tokens.join(' '));
    if (!body) throw new AssistantError('INVALID_INPUT', '用法：/remember [--as user|quote|external] [--tag 标签] 内容');
    const opId = flags.get('op-id')?.[0] ?? randomUUID();
    const result = await framework.rememberMemory({ content: body, tags: flags.get('tag') ?? [], attribution: attribution(flags.get('as')?.[0]) }, { adapter_id: 'cli', request_id: randomUUID() }, { project_id: projectId, operation_id: opId });
    stdout.write(`${JSON.stringify({ status: result.status, record_id: result.item.record_id, revision: result.item.revision, attribution: result.item.attribution, op_id: result.op_id })}\n`);
    return true;
  }
  if (name === '/recall') {
    const { flags, body } = parseFlags(tokens.join(' '));
    if (flags.has('id')) {
      const item = await framework.recallMemory(flags.get('id')![0]!, projectId, body);
      stdout.write(`${JSON.stringify({ record_id: item.record_id, revision: item.revision, status: item.status, occurred_at: item.occurred_at, attribution: item.attribution, content: item.content, coverage: 'complete', source_id: item.source_id })}\n`);
    } else {
      const project = flags.get('project')?.[0] ?? projectId ?? undefined;
      const routes = await framework.locateMemory(body, project ?? null);
      const items = await Promise.all(routes.map((route) => framework.recallMemory(route.route_id, project ?? null)));
      stdout.write(`${JSON.stringify({ items: items.map((item) => ({ record_id: item.record_id, revision: item.revision, project_id: item.project_id, occurred_at: item.occurred_at, attribution: item.attribution, content: item.content })), coverage: 'complete', source_state: 'available' })}\n`);
    }
    return true;
  }
  if (name === '/replace') {
    const { flags, body } = parseFlags(tokens.join(' '));
    const id = flags.get('id')?.[0]; const revision = Number(flags.get('revision')?.[0]);
    if (!id || !Number.isSafeInteger(revision) || revision < 1 || !body) throw new AssistantError('INVALID_INPUT', '用法：/replace --id <id> --revision <n> [--as user|quote|external] 内容');
    const result = await framework.replaceMemory(id, revision, { content: body, tags: flags.get('tag') ?? [], attribution: attribution(flags.get('as')?.[0]) }, { adapter_id: 'cli', request_id: randomUUID() }, { project_id: projectId, operation_id: flags.get('op-id')?.[0] ?? randomUUID() });
    stdout.write(`${JSON.stringify({ status: result.status, record_id: result.item.record_id, revision: result.item.revision, op_id: result.op_id })}\n`); return true;
  }
  if (name === '/archive') {
    const { flags } = parseFlags(tokens.join(' ')); const id = flags.get('id')?.[0]; const revision = Number(flags.get('revision')?.[0]);
    if (!id || !Number.isSafeInteger(revision) || revision < 1) throw new AssistantError('INVALID_INPUT', '用法：/archive --id <id> --revision <n>');
    const result = await framework.archiveMemory(id, revision, { adapter_id: 'cli', request_id: randomUUID() }, { project_id: projectId, operation_id: flags.get('op-id')?.[0] ?? randomUUID() });
    stdout.write(`${JSON.stringify({ status: result.status, record_id: result.item.record_id, revision: result.item.revision, op_id: result.op_id })}\n`); return true;
  }
  if (name === '/tasks') { stdout.write(`${JSON.stringify(tasks.list().map(({ task_id, attempt_id, revision, status, project_id, receipt }) => ({ task_id, attempt_id, revision, status, project_id, summary: receipt?.summary })), null, 2)}\n`); return true; }
  if (name === '/task') { const task = tasks.get(tokens[0] ?? ''); if (task.owner_id !== runtime.assistantId) throw new AssistantError('OUT_OF_SCOPE'); stdout.write(`${JSON.stringify(task, null, 2)}\n`); return true; }
  if (name === '/retry') { const receipt = await tasks.retry(tokens[0] ?? ''); stdout.write(`${JSON.stringify(receipt, null, 2)}\n`); return true; }
  if (name === '/cancel') { stdout.write(`${JSON.stringify(await tasks.cancel(tokens[0] ?? ''), null, 2)}\n`); return true; }
  if (command.startsWith('/')) throw new AssistantError('INVALID_INPUT', '未知命令。输入 /help 查看帮助。');
  return false;
}

async function chat(args: Args): Promise<void> {
  const root = await import('node:path').then((p) => p.resolve(args.root));
  const runtime = await openRuntime(root);
  try {
    const projects = new Map<string, string>();
    for (const [id, dir] of args.projects) {
      const checked = await import('node:fs/promises').then(async (fs) => ({ absolute: await fs.realpath(dir), info: await fs.stat(dir) }));
      if (!checked.info.isDirectory()) throw new AssistantError('INVALID_INPUT', `项目 ${id} 不是目录。`);
      projects.set(id, checked.absolute);
    }
    const memory = new MemoryCore(runtime); await memory.repairIndex();
    const framework = new AssistantFramework(runtime);
    const model = new ChatCompletionsModel(runtime.usageFile);
    const tasks = new TaskService(runtime, new LocalWorker(model), projects); await tasks.reconcileAfterRestart();
    const lead = new LeadLoop(runtime, memory, tasks, model);
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    const context: TurnContext = { scopeId: runtime.assistantId, projectId: projects.keys().next().value ?? null, ownerId: runtime.assistantId, projects };
    stdout.write(`本地 Lead 已启动。数据目录：${root}\n项目：${[...projects.keys()].join(', ') || '未登记'}\n输入 /help 查看命令，/quit 退出。\n`);
    try {
      await offerProfileSetup(runtime, (text) => { stdout.write(text); });
      while (true) {
        const line = await rl.question('你> ').catch(() => '/quit');
        if (!line.trim()) continue;
        if (/^\/(quit|exit)(\s|$)/.test(line.trim())) break;
        try {
          if (line.trim() === '/profile') {
            await runProfileSetup(runtime, { question: (prompt) => rl.question(prompt), write: (text) => { stdout.write(text); } });
            continue;
          }
          const commandHandled = await handleChatCommand(line, runtime, framework, tasks, context.projectId);
          if (commandHandled) continue;
          const answer = await lead.turn(line, context);
          stdout.write(`Lead> ${answer}\n`);
        } catch (error) { stdout.write(`${userMessage(error)}\n`); }
      }
    } finally { rl.close(); }
  } finally { await runtime.close(); }
}

export async function runCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  try {
    if (args.command === 'help' || args.command === '--help' || args.command === '-h') { usage(); return; }
    if (args.command === 'init') {
      const manifest = await initRoot(args.root);
      stdout.write(`已初始化：${await import('node:path').then((p) => p.resolve(args.root))}\nassistant_id: ${manifest.assistant_id}\n模板：Lead；用户画像为空。\n`); return;
    }
    if (args.command === 'doctor') { await readOnlyDoctor(await import('node:path').then((p) => p.resolve(args.root))); return; }
    if (args.command === 'identity') {
      if (args.rest[0] === 'preview') {
        const runtime = await openRuntime(args.root);
        try {
          const file = args.rest[1] === '--patch' ? args.rest[2] : undefined;
          if (!file) throw new AssistantError('INVALID_INPUT', '用法：identity preview --root <dir> --patch <file>');
          const { readFile } = await import('node:fs/promises');
          let raw: unknown;
          try { raw = JSON.parse(await readFile(file, 'utf8')); }
          catch { throw new AssistantError('INVALID_INPUT', '画像 patch 文件不是有效 JSON。'); }
          const patch = IdentityPatchSchema.parse(raw);
          const framework = new AssistantFramework(runtime);
          const current = await framework.readIdentity();
          const result = await framework.previewIdentityUpdate({ operation_id: randomUUID(), expected_revision: current.revision, patch }, { adapter_id: 'cli', request_id: randomUUID() });
          stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        }
        finally { await runtime.close(); }
        return;
      }
      if (args.rest[0] === 'apply') {
        const runtime = await openRuntime(args.root);
        try { const opts = new Map(args.rest.slice(1).reduce<string[][]>((out, item, i, all) => { if (item.startsWith('--')) out.push([item, all[i + 1] ?? '']); return out; }, []).map(([k, v]) => [k!, v!] as const)); const proposal = opts.get('--proposal'); const revision = Number(opts.get('--expected-revision')); if (!proposal || !Number.isSafeInteger(revision)) throw new AssistantError('INVALID_INPUT'); stdout.write(`${JSON.stringify(await new AssistantFramework(runtime).commitIdentityUpdate(proposal, revision, { adapter_id: 'cli', request_id: randomUUID() }))}\n`); }
        finally { await runtime.close(); }
        return;
      }
      throw new AssistantError('INVALID_INPUT', 'identity 仅支持 preview 和 apply。');
    }
    if (args.command === 'chat') { await chat(args); return; }
    throw new AssistantError('INVALID_INPUT', `未知命令：${args.command}`);
  } catch (error) { stdout.write(`${userMessage(error)}\n`); process.exitCode = 1; }
}
