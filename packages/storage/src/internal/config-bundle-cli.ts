import { execFile } from 'node:child_process';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import {
  AssetPathSchema,
  type ConfigBundleWrite,
  parseInput,
  ZhaoyeError,
} from '@zhaoye/contracts';
import { inspectAssetPath } from './asset-paths.js';

const execute = promisify(execFile);
const reportDirectories = {
  daily: 'daily-reports',
  weekly: 'weekly-reports',
  monthly: 'monthly-reports',
};

async function writableFile(bundle: string, path: string) {
  const existing = await inspectAssetPath(bundle, path);
  if (existing && (!existing.info.isFile() || existing.info.nlink > 1))
    throw new ZhaoyeError('INVALID_INPUT', '写入目标必须是单链接普通文件', { path });
  return existing;
}

export async function runBundleWrite(bundle: string, python: string, operation: ConfigBundleWrite) {
  if (!isAbsolute(python)) throw new ZhaoyeError('INVALID_INPUT', '配置包解释器必须使用绝对路径');
  if (await inspectAssetPath(bundle, '_cli/manifest.json'))
    throw new ZhaoyeError('INVALID_INPUT', '配置包 CLI 存在第二个根清单');
  let path = operation.path;
  let args: string[];
  let staging: string | undefined;
  let stagedFile: string | undefined;
  try {
    if (operation.action === 'archive') {
      if (!path.endsWith('.md') || path.includes('/'))
        throw new ZhaoyeError('INVALID_INPUT', '归档需要 Markdown 文件名');
      const now = new Date();
      const directory = `06-work/${reportDirectories[operation.report_type]}/${now.getFullYear()}`;
      path = `${directory}/${operation.report_type === 'daily' ? `${now.getMonth() + 1}月/` : ''}${path}`;
      if (await writableFile(bundle, path))
        throw new ZhaoyeError('CONFLICT', '归档目标已存在，请使用更新');
      await writableFile(bundle, '06-work/_index.md');
      staging = await mkdtemp(join(tmpdir(), 'zhaoye-report-'));
      stagedFile = join(staging, operation.path);
      await writeFile(stagedFile, operation.content, { flag: 'wx' });
      args = ['archive', operation.report_type, stagedFile];
    } else {
      const [module, ...parts] = path.split('/');
      const file = parts.join('/');
      if (!module || !file || parts.some((p) => p.toLowerCase() === '.git'))
        throw new ZhaoyeError('INVALID_INPUT', '请指定模块下的文件');
      const target = await writableFile(bundle, path);
      if (operation.action === 'create') {
        if (module === '06-work') throw new ZhaoyeError('INVALID_INPUT', '工作报告请使用归档');
        if (target) throw new ZhaoyeError('CONFLICT', '文件已经存在');
        await writableFile(bundle, `${module}/_index.md`);
        args = ['create', module, `--name=${file}`];
      } else {
        if (!target) throw new ZhaoyeError('NOT_FOUND', '文件不存在');
        if (operation.action === 'delete') {
          await writableFile(bundle, `${module}/_index.md`);
          args = ['delete', '--', module, file];
        } else args = ['update', `--content=${operation.content}`, '--', module, file];
      }
    }
    try {
      const { stdout } = await execute(
        python,
        ['-I', '-B', join(bundle, '_cli', 'bundle.py'), ...args],
        { cwd: bundle, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024 },
      );
      const result = JSON.parse(stdout);
      const receipts = {
        create: 'created',
        update: 'updated',
        delete: 'deleted',
        archive: 'archived',
      };
      if (result?.action !== receipts[operation.action]) throw new Error('unexpected receipt');
      if (operation.action === 'archive') {
        const archived = parseInput(AssetPathSchema, `06-work/${result.relative_path}`);
        if (archived !== path) throw new Error('unexpected archive path');
      }
      return path;
    } catch {
      throw new ZhaoyeError('COMMIT_UNKNOWN', '配置包接口未确认结果，请检查原件再同步清单', {
        path,
      });
    }
  } finally {
    if (stagedFile) await unlink(stagedFile).catch(() => {});
    if (staging) await rmdir(staging).catch(() => {});
  }
}
