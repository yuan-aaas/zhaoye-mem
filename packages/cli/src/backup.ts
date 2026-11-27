import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createZhaoye } from '@zhaoye/app';
import { type ActorContext, type AdapterManifest, ZhaoyeError } from '@zhaoye/contracts';

export const cliHost: AdapterManifest = {
  host_id: 'cli',
  display_name: 'CLI',
  capabilities: ['tools', 'approval'],
  adapter_version: '0.1.0',
  data_schema: 1,
};

const accessFlags = ['project', 'unassigned', 'batch', 'history'];
const subcommands: Record<string, [number, string[]]> = {
  'source add': [0, ['kind', 'file', 'scope', 'policy', 'source']],
  import: [0, ['source', 'operation-id', 'historical-snapshot']],
  sync: [0, ['source', 'operation-id']],
  'sync-status': [0, ['source']],
  batches: [0, ['source', 'project', 'unassigned']],
  search: [1, ['source', ...accessFlags, 'limit', 'cursor', 'from', 'to']],
  record: [1, ['source', ...accessFlags]],
  'export-mneme': [0, ['source', ...accessFlags, 'out']],
  verify: [0, []],
};

export async function runBackup(args: string[]) {
  const command = args[0] === 'source' ? args.slice(0, 2).join(' ') : (args[0] ?? '');
  const specification = Object.hasOwn(subcommands, command) ? subcommands[command] : undefined;
  if (!specification) throw new ZhaoyeError('INVALID_INPUT', '未知 backup 子命令');
  const [arity, allowed] = specification;
  const parsed = (() => {
    try {
      return parseArgs({
        args: args.slice(command === 'source add' ? 2 : 1),
        allowPositionals: true,
        options: {
          'data-root': { type: 'string' },
          json: { type: 'boolean' },
          kind: { type: 'string' },
          file: { type: 'string' },
          scope: { type: 'string' },
          policy: { type: 'string' },
          source: { type: 'string' },
          'operation-id': { type: 'string' },
          'historical-snapshot': { type: 'string' },
          project: { type: 'string', multiple: true },
          unassigned: { type: 'boolean' },
          batch: { type: 'string' },
          history: { type: 'boolean' },
          limit: { type: 'string' },
          cursor: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          out: { type: 'string' },
        },
      });
    } catch {
      throw new ZhaoyeError('INVALID_INPUT', 'backup 命令参数无效');
    }
  })();
  const { positionals, values } = parsed;
  if (
    positionals.length !== arity ||
    Object.keys(values).some((name) => !['data-root', 'json', ...allowed].includes(name))
  )
    throw new ZhaoyeError('INVALID_INPUT', 'backup 命令参数不匹配');
  const source = values.source;
  if (command !== 'source add' && command !== 'verify' && !source)
    throw new ZhaoyeError('INVALID_INPUT', '请用 --source 选择备份来源');
  const app = await createZhaoye({
    host: cliHost,
    initIfMissing: false,
    ...(values['data-root'] !== undefined ? { dataRoot: values['data-root'] } : {}),
  });
  try {
    const ctx: ActorContext = {
      adapter_id: 'cli',
      scope_id: app.assistantId,
      granted_project_ids: '*',
      granted_source_ids: '*',
      backup_import: true,
      backup_unassigned: true,
      backup_history: true,
      backup_export: true,
    };
    const options = {
      projects: values.project,
      includeUnassigned: values.unassigned,
      batchId: values.batch,
      history: values.history,
    };
    switch (command) {
      case 'source add': {
        if (
          (values.kind && values.kind !== 'mneme') ||
          (values.scope && values.scope !== app.assistantId)
        )
          throw new ZhaoyeError('INVALID_INPUT', '来源类型或数据根范围无效');
        let policy: Record<string, unknown> = {};
        if (values.policy) {
          try {
            policy = JSON.parse(await readFile(values.policy, 'utf8')) as Record<string, unknown>;
          } catch {
            throw new ZhaoyeError('INVALID_INPUT', '无法读取 Mneme 策略文件');
          }
          if (!policy || typeof policy !== 'object' || Array.isArray(policy))
            throw new ZhaoyeError('INVALID_INPUT', 'Mneme 策略必须是 JSON 对象');
        }
        return await app.backup.registerMneme(
          {
            policy,
            ...(values.file ? { file: values.file } : {}),
            ...(source ? { sourceId: source } : {}),
          },
          ctx,
        );
      }
      case 'import':
        return await app.backup.importSnapshot(
          {
            sourceId: source as string,
            operationId: values['operation-id'] ?? randomUUID(),
            ...(values['historical-snapshot']
              ? { historicalSnapshot: values['historical-snapshot'] }
              : {}),
          },
          ctx,
        );
      case 'sync':
        return await app.backup.syncMneme(
          { sourceId: source as string, operationId: values['operation-id'] ?? randomUUID() },
          ctx,
        );
      case 'sync-status':
        return await app.backup.syncStatus(source as string, ctx);
      case 'batches':
        return await app.backup.listImportBatches(source as string, options, ctx);
      case 'search':
        return await app.backup.searchBackup(
          source as string,
          {
            ...options,
            query: positionals[0] as string,
            from: values.from,
            to: values.to,
            cursor: values.cursor,
            limit: values.limit === undefined ? undefined : Number(values.limit),
          },
          ctx,
        );
      case 'record':
        return await app.backup.getBackupRecord(
          source as string,
          positionals[0] as string,
          options,
          ctx,
        );
      case 'export-mneme':
        if (!values.out) throw new ZhaoyeError('INVALID_INPUT', '需要 --out 指定新文件');
        return await app.backup.exportMneme(source as string, values.out, options, ctx);
      case 'verify':
        return await app.backup.verifyBackup(ctx);
      default:
        throw new ZhaoyeError('INVALID_INPUT', '未知 backup 子命令');
    }
  } finally {
    await app.close();
  }
}
