#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createZhaoye, doctor, renderIdentityMarkdown } from '@zhaoye/app';
import {
  type ActorContext,
  type IdentityCommitRequest,
  type IdentityRollbackRequest,
  ZhaoyeError,
} from '@zhaoye/contracts';
export async function run(
  args: string[] = process.argv.slice(2),
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<number> {
  const json = args.includes('--json');
  const output = (data: unknown) =>
    write(
      json
        ? JSON.stringify({ ok: true, data })
        : typeof data === 'string'
          ? data
          : JSON.stringify(data, null, 2),
    );
  const usage = (message: string): number => {
    write(
      json
        ? JSON.stringify({
            ok: false,
            error: { code: 'INVALID_INPUT', message, retry: 'never', action: null, details: {} },
          })
        : message,
    );
    return 2;
  };
  try {
    if (args.length === 1 && args[0] === '--version') {
      const manifest = JSON.parse(
        await readFile(new URL('../package.json', import.meta.url), 'utf8'),
      ) as { version: string };
      write(manifest.version);
      return 0;
    }
    let dataRoot: string | undefined;
    let limit = 20;
    let dry = false;
    let release = false;
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--data-root') {
        dataRoot = args[++i];
        if (!dataRoot || dataRoot.startsWith('--'))
          throw new ZhaoyeError('INVALID_INPUT', '--data-root 缺少路径');
      } else if (a === '--limit') {
        limit = Number(args[++i]);
      } else if (a === '--dry-run') dry = true;
      else if (a === '--release') release = true;
      else if (a === '--json') continue;
      else if (a?.startsWith('--')) {
        return usage(`未知选项：${a}`);
      } else if (a) positional.push(a);
    }
    const [command, sub, file] = positional;
    if (command === 'doctor' || command === 'presence') {
      if (positional.length !== 1 || dry || (command === 'doctor' && release)) {
        return usage('命令参数不正确');
      }
      const report = await doctor(dataRoot);
      if (command === 'presence' && release)
        throw new ZhaoyeError('UNAUTHORIZED', '此命令没有持有该实例的 presence，不能释放其他实例');
      output(command === 'doctor' ? report : report.presence);
      return report.checks.some((c) => c.status === 'fail') ? 5 : 0;
    }
    if (command !== 'init' && command !== 'identity') {
      return usage(
        'Usage: zhaoye init | doctor | identity show/history/apply/rollback | presence [--data-root path] [--json]',
      );
    }
    if (command === 'init' && (positional.length !== 1 || dry || release)) {
      return usage('init 参数不正确');
    }
    if (
      command === 'identity' &&
      (!['show', 'history', 'apply', 'rollback'].includes(sub ?? '') ||
        positional.length !== (sub === 'apply' || sub === 'rollback' ? 3 : 2) ||
        release)
    ) {
      return usage('identity 参数不正确');
    }
    let request: unknown;
    if (command === 'identity' && (sub === 'apply' || sub === 'rollback')) {
      try {
        request = JSON.parse(await readFile(file ?? '', 'utf8'));
      } catch (e) {
        throw new ZhaoyeError('INVALID_INPUT', '无法读取请求 JSON', {
          path: file,
          cause: String(e),
        });
      }
    }
    const app = await createZhaoye({
      ...(dataRoot ? { dataRoot } : {}),
      host: {
        host_id: 'cli',
        display_name: 'CLI',
        capabilities: ['tools', 'approval'],
        adapter_version: '0.1.0',
        data_schema: 1,
      },
      initIfMissing: command === 'init',
    });
    try {
      const ctx: ActorContext = {
        adapter_id: 'cli',
        scope_id: app.assistantId,
        granted_project_ids: '*',
        granted_source_ids: '*',
      };
      if (command === 'init')
        output({ created: app.created, data_root: app.dataRoot, assistant_id: app.assistantId });
      else if (sub === 'show') {
        const snapshot = await app.identity.read(ctx);
        if (json) output(snapshot.document);
        else output(renderIdentityMarkdown(snapshot.document));
      } else if (sub === 'history') output(await app.identity.listVersions(ctx, limit));
      else if (sub === 'apply') {
        const req = request as IdentityCommitRequest;
        output(
          dry
            ? await app.identity.preview(req, ctx)
            : req?.update?.section === 'safety_kernel'
              ? await app.identity.commitKernel(req, ctx)
              : await app.identity.commit(req, ctx),
        );
      } else if (sub === 'rollback') {
        if (dry) throw new ZhaoyeError('INVALID_INPUT', 'rollback 不支持 --dry-run');
        const req = request as IdentityRollbackRequest;
        output(
          req?.section === 'safety_kernel'
            ? await app.identity.rollbackKernel(req, ctx)
            : await app.identity.rollback(req, ctx),
        );
      }
    } finally {
      await app.close();
    }
    return 0;
  } catch (e) {
    const error =
      e instanceof ZhaoyeError
        ? e
        : new ZhaoyeError('STORAGE_FAILURE', '运行失败', { cause: String(e) });
    write(
      json
        ? JSON.stringify({
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              retry: error.retry,
              action: error.action,
              details: error.details,
            },
          })
        : `${error.code}: ${error.message}`,
    );
    if (
      [
        'INVALID_INPUT',
        'CONFLICT',
        'NOT_FOUND',
        'ASSISTANT_PRESENT_ELSEWHERE',
        'ASSISTANT_SAME_PROCESS',
        'LOCKED',
      ].includes(error.code)
    )
      return 3;
    if (['UNAUTHORIZED', 'OUT_OF_SCOPE'].includes(error.code)) return 4;
    if (['CORRUPT_DATA', 'INTEGRITY_FAILED', 'SCHEMA_MIGRATION_REQUIRED'].includes(error.code))
      return 5;
    if (error.code === 'STORAGE_FAILURE' || error.code === 'COMMIT_UNKNOWN') return 6;
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run();
}
