import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { doctor } from '@zhaoye/app';
import { IdentityDocumentSchema, renderBoundedSafetyKernel, ZhaoyeError } from '@zhaoye/contracts';
import { assistantPreset, type DshSession } from './api.js';
import { setupRoute } from './setup-api.js';
import { inspectSkills, installAssetSkill } from './setup-skills.js';

interface SetupOptions {
  defaultRoot: string;
  dshHome: string;
  activate(root: string, persist: () => Promise<void>): Promise<void>;
  initialize(root: string): Promise<void>;
  prepareChat(): Promise<void>;
  skills(): Promise<ReadonlyArray<{ name: string }>>;
  session(id: string): DshSession | undefined;
  readyPreset(): Promise<boolean>;
  logger: { warn(message: string): void };
}

export interface DshSetupConnection {
  fetch: {
    register(route: {
      path: string;
      methods: string[];
      requestBody: 'buffered';
      fetch(request: Request): Promise<Response>;
    }): void;
  };
}

function noFile(error: unknown, code = 'ENOENT') {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function localPath(value: unknown) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 1024 ||
    value.includes('\0') ||
    !isAbsolute(value.trim()) ||
    (process.platform === 'win32' && !/^[a-z]:[\\/]/iu.test(value.trim()))
  )
    throw new ZhaoyeError('INVALID_INPUT', '请输入本机的绝对目录路径');
  return resolve(value.trim());
}

function equalPaths(a: string, b: string) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function createSetup(options: SetupOptions) {
  const code = createHash('sha256').update(options.defaultRoot).digest('hex').slice(0, 16);
  const settings = join(options.dshHome, 'zhaoye', `onboarding-${code}.json`);
  const destination = join(options.dshHome, 'skills');
  let root = options.defaultRoot;
  let tail: Promise<unknown> = Promise.resolve();
  try {
    root = localPath(JSON.parse(readFileSync(settings, 'utf8')).dataRoot);
  } catch (error) {
    if (!noFile(error)) options.logger.warn('照夜的目录设置无效，已采用宿主配置');
  }

  async function scan(at: string) {
    const catalog = await options.skills();
    return inspectSkills(at, destination, new Set(catalog.map((skill) => skill.name)));
  }

  async function status(at = root) {
    const identity = { path: join(at, 'identity'), ready: false };
    const backup = { path: join(at, 'backup'), ready: false };
    const assets = { path: join(at, 'assets'), ready: false };
    let canInitialize = false;
    let issue: string | null = null;
    try {
      const items = await readdir(at);
      canInitialize = items.length === 0;
      if (!canInitialize) {
        const report = await doctor(at);
        const isReady = (name: string) =>
          report.checks.some((check) => check.id === name && check.status === 'ok');
        const failure = report.checks.find((check) => check.status === 'fail');
        if (failure) issue = `本地检查未通过（${failure.id}）`;
        if (isReady('identity')) {
          try {
            const doc = IdentityDocumentSchema.parse(
              JSON.parse(await readFile(join(identity.path, 'identity.json'), 'utf8')),
            );
            renderBoundedSafetyKernel(doc.safety_kernel.principles);
            identity.ready = true;
          } catch {
            issue = '人格画像超出提示预算或格式无效';
          }
        }
        const backupFile = await lstat(join(backup.path, 'zhaoye.db')).catch(() => null);
        const catalog = await lstat(join(assets.path, 'manifest.json')).catch(() => null);
        const assetFiles = await lstat(join(assets.path, 'files')).catch(() => null);
        backup.ready = isReady('backup') && backupFile?.isFile() === true;
        assets.ready =
          isReady('assets') && catalog?.isFile() === true && assetFiles?.isDirectory() === true;
        if (report.presence.state === 'active' && report.presence.owner?.pid !== process.pid)
          issue = '另一个照夜进程正在使用这个目录';
      }
    } catch (error) {
      if (noFile(error)) canInitialize = true;
      else issue = '无法读取所选目录';
    }
    let skillIssue: string | null = null;
    const skills = assets.ready
      ? await scan(at).catch(() => {
          skillIssue = '技能目录暂时无法检查';
          return [];
        })
      : [];
    const presetReady = await options.readyPreset();
    if (!presetReady) issue ??= 'DSH 尚未加载照夜助手预设';
    const ready = identity.ready && backup.ready && assets.ready && presetReady && !issue;
    return {
      dataRoot: at,
      identity,
      backup,
      assets,
      issue,
      skillIssue,
      ready,
      canInitialize,
      skills: skills.map(({ directory: _directory, ...skill }) => skill),
      skillsPath: destination,
    };
  }

  async function configure(input: Record<string, unknown>) {
    const selected = localPath(input.dataRoot);
    let check = await status(selected);
    if (check.canInitialize && input.initialize === true) {
      await options.initialize(selected);
      check = await status(selected);
    }
    if (check.canInitialize) return check;
    if (!check.identity.ready || !check.backup.ready || !check.assets.ready)
      throw new ZhaoyeError(
        'INVALID_INPUT',
        check.issue ?? '请选择含有人格、记忆库和个人资产库的照夜数据根',
      );
    if (!equalPaths(root, selected)) {
      await options.activate(selected, async () => {
        await mkdir(dirname(settings), { recursive: true });
        const temporary = `${settings}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, `${JSON.stringify({ dataRoot: selected })}\n`, {
            flag: 'wx',
            mode: 0o600,
          });
          await rename(temporary, settings);
        } catch (error) {
          await rm(temporary, { force: true }).catch(() => {});
          throw error;
        }
        root = selected;
      });
    }
    return check;
  }

  async function claimNotice(sessionId: unknown) {
    if (typeof sessionId !== 'string' || sessionId.length > 200) return { missing: [] };
    const session = options.session(sessionId);
    if (!session) return { missing: [] };
    const events = session.snapshotEvents();
    const selected = events.findLast((event) => event.type === 'agent-preset/selected');
    if (
      (selected?.data.agentPreset ?? session.header.agentPreset) !== assistantPreset ||
      events.some((event) => event.type === 'user/message' && event.data.source?.kind === 'user')
    )
      return { missing: [] };
    const names = [
      ...new Set((await scan(root)).filter((skill) => !skill.installed).map((skill) => skill.name)),
    ];
    if (!names.length) return { missing: [] };
    const marker = join(root, 'identity', 'skill-welcome-shown');
    try {
      const file = await open(marker, 'wx');
      await file.close();
    } catch (error) {
      if (noFile(error, 'EEXIST') || noFile(error)) return { missing: [] };
      throw error;
    }
    return { missing: names };
  }

  async function mutate(input: Record<string, unknown>) {
    switch (input.action) {
      case 'configure':
        return configure(input);
      case 'start': {
        const check = await status();
        if (!check.ready) throw new ZhaoyeError('CONFLICT', check.issue ?? '照夜还没有准备好');
        await options.prepareChat();
        return { preset: assistantPreset };
      }
      case 'install': {
        const skill = (await scan(root)).find((item) => item.id === input.skillId);
        if (!skill) throw new ZhaoyeError('NOT_FOUND', '资产库里没有这项技能');
        await installAssetSkill(skill, destination);
        return status();
      }
      case 'notice':
        return claimNotice(input.sessionId);
      default:
        throw new ZhaoyeError('INVALID_INPUT', '未知照夜设置操作');
    }
  }

  return {
    root: () => root,
    bind(connection: DshSetupConnection) {
      connection.fetch.register({
        path: setupRoute,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        async fetch(request) {
          const reply = (data: unknown, code = 200) =>
            Response.json(data, { status: code, headers: { 'Cache-Control': 'no-store' } });
          try {
            if (request.method === 'GET') return reply(await status());
            if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json')
              return reply({ error: '请求格式无效' }, 415);
            const text = await request.text();
            if (text.length > 4096) return reply({ error: '请求太大' }, 413);
            const input = JSON.parse(text) as unknown;
            if (!input || typeof input !== 'object' || Array.isArray(input))
              return reply({ error: '请求格式无效' }, 400);
            const job = tail.then(() => mutate(input as Record<string, unknown>));
            tail = job.catch(() => {});
            return reply(await job);
          } catch (error) {
            if (error instanceof ZhaoyeError) return reply({ error: error.message }, 409);
            if (error instanceof SyntaxError) return reply({ error: '请求格式无效' }, 400);
            options.logger.warn(`照夜设置请求失败：${String(error)}`);
            return reply({ error: '照夜设置暂不可用' }, 500);
          }
        },
      });
    },
  };
}
