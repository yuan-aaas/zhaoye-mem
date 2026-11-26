import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type ActorContext,
  ActorContextSchema,
  type BackupAccess,
  BackupAccessSchema,
  type BackupDb,
  type BackupSearch,
  BackupSearchSchema,
  type BackupSource,
  MnemePolicySchema,
  ZhaoyeError,
} from '@zhaoye/contracts';
import {
  convertMnemeRow,
  MNEME_CONVERTER_VERSION,
  MNEME_METADATA_COLUMNS,
  requiredMnemeColumns,
} from '@zhaoye/core';
import {
  captureMnemeFile,
  hashBytes,
  openBackupDb,
  resolveMnemeFile,
  writeMnemeExport,
} from '@zhaoye/storage';

function authorize(ctx: ActorContext, scope: string, adapter: string, source?: string) {
  const actor = ActorContextSchema.safeParse(ctx);
  if (!actor.success) throw new ZhaoyeError('INVALID_INPUT', '备份授权上下文无效');
  if (ctx.adapter_id !== adapter) throw new ZhaoyeError('UNAUTHORIZED', '备份调用者与适配器不匹配');
  if (
    ctx.scope_id !== scope ||
    (source && ctx.granted_source_ids !== '*' && !ctx.granted_source_ids.includes(source))
  )
    throw new ZhaoyeError('OUT_OF_SCOPE', '备份来源超出授权');
}

function policyOf(input: Record<string, unknown>) {
  const { file: _file, ...policy } = input;
  const parsed = MnemePolicySchema.safeParse(policy);
  if (!parsed.success) throw new ZhaoyeError('INVALID_INPUT', 'Mneme 来源策略无效');
  return parsed.data;
}

function scopeKey(source: BackupSource) {
  return hashBytes(JSON.stringify([MNEME_CONVERTER_VERSION, policyOf(source.policy)]));
}

export function createBackupFacade(
  root: string,
  scope: string,
  adapter: string,
  assertOwner: () => Promise<void>,
) {
  let recovered = false;
  async function withDb<T>(write: boolean, work: (db: BackupDb) => T | Promise<T>) {
    if (write) await assertOwner();
    const db = await openBackupDb(root, { mode: write ? 'create' : 'read' });
    try {
      if (write && !recovered) {
        db.recoverInterruptedBatches();
        recovered = true;
      }
      return await work(db);
    } finally {
      db.close();
    }
  }
  function requireWriter(ctx: ActorContext, source?: string) {
    authorize(ctx, scope, adapter, source);
    if (!ctx.backup_import || ctx.granted_project_ids !== '*')
      throw new ZhaoyeError('UNAUTHORIZED', '需要来源范围的导入权限');
  }
  function sourceOf(db: BackupDb, sourceId: string) {
    const source = db.getSource(sourceId);
    if (!source || source.scopeId !== scope || source.kind !== 'mneme')
      throw new ZhaoyeError('NOT_FOUND', '当前范围没有该 Mneme 来源');
    return source;
  }
  type Options = Pick<BackupSearch, 'projects' | 'includeUnassigned' | 'batchId' | 'history'>;
  function access(db: BackupDb, ctx: ActorContext, sourceId: string, options: Options) {
    const source = sourceOf(db, sourceId);
    const grant = ctx.granted_project_ids;
    const projects = options.projects ?? grant;
    if (grant !== '*' && (projects === '*' || projects.some((id) => !grant.includes(id))))
      throw new ZhaoyeError('OUT_OF_SCOPE', '检索项目超出授权');
    if (
      (options.includeUnassigned && !ctx.backup_unassigned) ||
      ((options.history || options.batchId) && !ctx.backup_history)
    )
      throw new ZhaoyeError('UNAUTHORIZED', '需要无归属记录或历史读取权限');
    const checked = BackupAccessSchema.safeParse({
      ...options,
      sourceId,
      scopeId: scope,
      scopeKey: scopeKey(source),
      projects,
      includeUnassigned: options.includeUnassigned ?? false,
    });
    if (!checked.success) throw new ZhaoyeError('INVALID_INPUT', '备份访问参数无效');
    return checked.data;
  }
  const read = <T>(
    ctx: ActorContext,
    sourceId: string,
    options: Options,
    fn: (db: BackupDb, view: BackupAccess) => T,
  ) => {
    authorize(ctx, scope, adapter, sourceId);
    return withDb(false, (db) => fn(db, access(db, ctx, sourceId, options)));
  };
  return {
    listSources(ctx: ActorContext) {
      authorize(ctx, scope, adapter);
      const grants = ctx.granted_source_ids;
      return withDb(false, (db) =>
        db
          .listSources(scope)
          .filter((source) => grants === '*' || grants.includes(source.sourceId)),
      );
    },
    async registerMneme(
      input: { file?: string; policy: Record<string, unknown>; sourceId?: string },
      ctx: ActorContext,
    ) {
      requireWriter(ctx, input.sourceId);
      if (!input.sourceId && ctx.granted_source_ids !== '*')
        throw new ZhaoyeError('UNAUTHORIZED', '需要注册新来源的权限');
      const policy = policyOf(input.policy);
      const file = input.file;
      if (!file) {
        const candidates = [
          process.env.MNEME_MEMORY_DIR && join(process.env.MNEME_MEMORY_DIR, 'memory.db'),
          ...[process.env.MNEME_HOME, process.env.DSH_MNEME_HOME].map(
            (p) => p && join(p, 'memory', 'memory.db'),
          ),
          join(homedir(), '.mneme', 'memory', 'memory.db'),
          join(homedir(), '.dsh', 'memory', 'memory.db'),
        ];
        const existing = new Set<string>();
        for (const path of candidates) {
          if (!path) continue;
          try {
            existing.add(await resolveMnemeFile(root, path));
          } catch (error) {
            if (!(error instanceof ZhaoyeError) || error.code !== 'SOURCE_UNAVAILABLE') throw error;
          }
        }
        throw new ZhaoyeError('INVALID_INPUT', '请用 --file 明确选择 Mneme 文件', {
          candidates: [...existing],
        });
      }
      const path = await resolveMnemeFile(root, file);
      return withDb(true, (db) => {
        if (input.sourceId) sourceOf(db, input.sourceId);
        const sourceId = input.sourceId ?? randomUUID();
        db.registerSource({
          sourceId,
          scopeId: scope,
          kind: 'mneme',
          displayName: 'Mneme',
          policy: { ...policy, file: path },
        });
        return { sourceId, scopeId: scope, rawMode: policy.rawMode };
      });
    },
    async importSnapshot(
      input: { sourceId: string; operationId: string; historicalSnapshot?: string },
      ctx: ActorContext,
    ) {
      requireWriter(ctx, input.sourceId);
      return withDb(true, async (db) => {
        const source = sourceOf(db, input.sourceId);
        const policy = policyOf(source.policy);
        const path = input.historicalSnapshot ?? source.policy.file;
        if (typeof path !== 'string')
          throw new ZhaoyeError('SOURCE_UNAVAILABLE', 'Mneme 来源缺少文件绑定');
        const mode = input.historicalSnapshot ? 'historical' : 'live';
        const batchInput = {
          sourceId: source.sourceId,
          scopeId: scope,
          scopeKey: scopeKey(source),
          scope: policy,
          operationId: input.operationId,
          adapterId: adapter,
          mode,
          format: 'mneme-sqlite/v1',
          converterVersion: MNEME_CONVERTER_VERSION,
          inputKey: hashBytes(path),
        } as const;
        const batch = db.startBatch(batchInput);
        if (batch.status !== 'running' || !batch.created) return batch;
        try {
          const file = await resolveMnemeFile(root, path, mode === 'historical');
          return await db.publishBatch(
            await captureMnemeFile({
              root,
              file,
              whole: policy.rawMode === 'sqlite',
              batch: {
                batchId: batch.batchId,
                sourceId: source.sourceId,
                scopeKey: batchInput.scopeKey,
                format: batchInput.format,
                converterVersion: batchInput.converterVersion,
              },
              required: requiredMnemeColumns(policy),
              optional: MNEME_METADATA_COLUMNS,
              convert: (row) => convertMnemeRow(row, policy),
            }),
          );
        } catch (error) {
          if (!(error instanceof ZhaoyeError) || error.code !== 'COMMIT_UNKNOWN')
            db.failBatch(
              batch.batchId,
              error instanceof ZhaoyeError ? error.code : 'STORAGE_FAILURE',
            );
          throw error;
        }
      });
    },
    listImportBatches: (sourceId: string, options: Options, ctx: ActorContext) =>
      read(ctx, sourceId, options, (db, view) => db.listBatches(view)),
    searchBackup(sourceId: string, input: BackupSearch, ctx: ActorContext) {
      const parsed = BackupSearchSchema.safeParse(input);
      if (!parsed.success) throw new ZhaoyeError('INVALID_INPUT', '检索参数无效');
      const { projects, includeUnassigned, batchId, history, ...query } = parsed.data;
      if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to))
        throw new ZhaoyeError('INVALID_INPUT', '检索时间范围无效');
      return read(ctx, sourceId, { projects, includeUnassigned, batchId, history }, (db, view) =>
        db.search(view, query),
      );
    },
    getBackupRecord: (sourceId: string, id: string, options: Options, ctx: ActorContext) =>
      read(ctx, sourceId, options, (db, view) => {
        const row = db.readRecords(view, id)[0];
        if (!row) throw new ZhaoyeError('NOT_FOUND', '当前授权范围没有该记录');
        return row;
      }),
    async exportMneme(sourceId: string, destination: string, options: Options, ctx: ActorContext) {
      if (!ctx.backup_export) throw new ZhaoyeError('UNAUTHORIZED', '需要本地导出权限');
      const rows = await read(ctx, sourceId, options, (db, view) => db.readRecords(view));
      await writeMnemeExport(destination, rows);
      return { records: rows.length, format: 'mneme-memories/sqlite' };
    },
    verifyBackup(ctx: ActorContext) {
      requireWriter(ctx);
      if (ctx.granted_source_ids !== '*')
        throw new ZhaoyeError('UNAUTHORIZED', '需要整个备份库的核验权限');
      return withDb(false, async (db) => {
        await db.verify();
        return { verified: true };
      });
    },
  };
}
