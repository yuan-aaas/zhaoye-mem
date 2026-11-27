import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type ActorContext,
  ActorContextSchema,
  type BackupAccess,
  BackupAccessSchema,
  type BackupDb,
  type BackupObservation,
  type BackupSearch,
  BackupSearchSchema,
  type BackupSource,
  type BackupSyncState,
  BackupSyncStateSchema,
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
  readJson,
  readText,
  resolveMnemeFile,
  scanMnemeChanges,
  writeAtomic,
  writeMnemeExport,
  writeMnemeSync,
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
  let recovery: Promise<void> | undefined;
  const syncing = new Map<
    string,
    Promise<{
      status: 'complete' | 'unchanged';
      sourceId: string;
      batchId: string;
      changed: number;
      absent: number;
      preferenceError: string | undefined;
    }>
  >();
  async function withDb<T>(write: boolean, work: (db: BackupDb) => T | Promise<T>) {
    if (write) await assertOwner();
    const db = await openBackupDb(root, { mode: write ? 'create' : 'read' });
    try {
      if (write) {
        recovery ??= db
          .recoverPendingSyncBatches()
          .then(() => {
            db.recoverInterruptedBatches();
          })
          .catch((error: unknown) => {
            recovery = undefined;
            throw error;
          });
        await recovery;
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
  function syncFile(source: BackupSource) {
    return join(
      root,
      'backup',
      `sync-${hashBytes(JSON.stringify([source.sourceId, scopeKey(source)]))}.json`,
    );
  }
  async function syncState(source: BackupSource): Promise<BackupSyncState> {
    const path = syncFile(source);
    return (await readText(path)) === null ? {} : readJson(path, BackupSyncStateSchema);
  }
  async function sourceBinding(file: string) {
    const info = await stat(file, { bigint: true });
    return hashBytes(
      JSON.stringify([file, info.dev.toString(), info.ino.toString(), info.birthtimeNs.toString()]),
    );
  }
  type SyncInput = { sourceId: string; operationId: string; evolve?: boolean };
  async function sync(
    input: SyncInput,
    onPreference: ((source: string, row: BackupObservation) => Promise<void>) | undefined,
  ) {
    return withDb(true, async (db) => {
      const source = sourceOf(db, input.sourceId);
      const policy = policyOf(source.policy);
      const key = scopeKey(source);
      const state = await syncState(source);
      async function save() {
        await assertOwner();
        await writeAtomic(syncFile(source), `${JSON.stringify(state)}\n`);
      }
      let started: string | undefined;
      let completed = false;
      let changed = 0;
      let absent = 0;
      try {
        const previous = db.getCompleteBatch(source.sourceId, key);
        let current = previous;
        const replay = db.getSyncOperation(input.operationId, adapter, source.sourceId, key);
        if (replay) {
          if (replay.status !== 'complete')
            throw new ZhaoyeError('CONFLICT', '先前同步未完成，请用新的操作 ID 重试');
          current = replay.batchId;
          changed = replay.recordCount;
          absent = db
            .readObservations(current, false)
            .filter((row) => row.reason === 'source_absent').length;
          completed = true;
          if (replay.capturedAt && (!state.succeededAt || replay.capturedAt > state.succeededAt)) {
            state.succeededAt = replay.capturedAt;
            state.checkedAt = replay.capturedAt;
            state.batchId = current;
            state.changed = changed;
            state.absent = absent;
            delete state.error;
            await save();
          }
        } else {
          if (typeof source.policy.file !== 'string')
            throw new ZhaoyeError('SOURCE_UNAVAILABLE', 'Mneme 来源缺少文件绑定');
          const file = await resolveMnemeFile(root, source.policy.file);
          const binding = await sourceBinding(file);
          if (state.binding && state.binding !== binding && previous)
            throw new ZhaoyeError('SOURCE_UNAVAILABLE', 'Mneme 文件已被替换，请重新登记为新来源');
          state.binding = binding;
          await save();
          const capture = {
            root,
            file,
            required: requiredMnemeColumns(policy),
            optional: MNEME_METADATA_COLUMNS,
            convert: (row: Record<string, unknown>) => convertMnemeRow(row, policy),
          };
          const delta = await scanMnemeChanges(
            capture,
            previous ? db.readObservations(previous, true) : [],
          );
          if (
            (await sourceBinding(file)) !== binding ||
            db.getCompleteBatch(source.sourceId, key) !== previous
          )
            throw new ZhaoyeError('CONFLICT', '同步期间来源或基线发生变化，请重试');
          if (!previous || delta.records.length) {
            const format = previous ? 'mneme-delta/v1' : 'mneme-baseline/v1';
            const batch = db.startBatch({
              sourceId: source.sourceId,
              scopeId: scope,
              scopeKey: key,
              scope: policy,
              operationId: input.operationId,
              adapterId: adapter,
              mode: 'live',
              format,
              converterVersion: MNEME_CONVERTER_VERSION,
              inputKey: hashBytes(file),
            });
            if (batch.status !== 'running' || !batch.created)
              throw new ZhaoyeError('CONFLICT', '同步作业已在运行或结束');
            started = batch.batchId;
            const manifest = {
              batchId: batch.batchId,
              sourceId: source.sourceId,
              scopeKey: key,
              format,
              converterVersion: MNEME_CONVERTER_VERSION,
              ...(previous ? { parentBatchId: previous } : {}),
            };
            const publication = await writeMnemeSync(root, manifest, delta);
            const receipt = await db.publishBatch(publication);
            current = receipt.batchId;
            changed = receipt.recordCount;
            absent = delta.absentCount;
            completed = true;
          }
          state.checkedAt = new Date().toISOString();
          state.succeededAt = state.checkedAt;
          state.batchId = current ?? undefined;
          state.changed = changed;
          state.absent = absent;
          delete state.error;
          await save();
        }
        if (!current) throw new ZhaoyeError('CORRUPT_DATA', '找不到同步基线');
        if (input.evolve !== false && onPreference) {
          try {
            const active = db.getCompleteBatch(source.sourceId, key);
            const batches = db.listSyncBatches(source.sourceId, key, state.consumedBatchId);
            if (active && batches.length) {
              const visible = new Map(
                db.readObservations(active, true).map((row) => [row.nativeId, row]),
              );
              for (const id of batches) {
                for (const row of db.readObservations(id, false)) {
                  const latest = visible.get(row.nativeId);
                  if (
                    row.content?.kind === 'preference' &&
                    row.searchAllowed &&
                    row.visibility === 'visible' &&
                    latest?.visibility === 'visible' &&
                    latest.searchAllowed &&
                    latest.projectId === row.projectId &&
                    latest.content?.body === row.content.body &&
                    latest.metadata.source === row.metadata.source
                  )
                    await onPreference(source.sourceId, row);
                }
                state.consumedBatchId = id;
                await save();
              }
            }
            delete state.preferenceError;
          } catch (error) {
            state.preferenceError = error instanceof ZhaoyeError ? error.code : 'STORAGE_FAILURE';
          }
          await save();
        }
        return {
          status: completed ? ('complete' as const) : ('unchanged' as const),
          sourceId: source.sourceId,
          batchId: current,
          changed,
          absent,
          preferenceError: state.preferenceError,
        };
      } catch (error) {
        const code = error instanceof ZhaoyeError ? error.code : 'STORAGE_FAILURE';
        if (started && !completed && code !== 'COMMIT_UNKNOWN') db.failBatch(started, code);
        state.checkedAt = new Date().toISOString();
        state.error = code;
        await save();
        throw error;
      }
    });
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
    syncMneme(
      input: SyncInput,
      ctx: ActorContext,
      onPreference?: (source: string, row: BackupObservation) => Promise<void>,
    ) {
      requireWriter(ctx, input.sourceId);
      if (!input.operationId.trim() || input.operationId.length > 256)
        throw new ZhaoyeError('INVALID_INPUT', '同步操作 ID 无效');
      const running = syncing.get(input.sourceId);
      if (running) return running;
      const job = sync(input, onPreference).finally(() => syncing.delete(input.sourceId));
      syncing.set(input.sourceId, job);
      return job;
    },
    syncStatus(sourceId: string, ctx: ActorContext) {
      authorize(ctx, scope, adapter, sourceId);
      return withDb(false, async (db) => {
        const { binding: _binding, ...state } = await syncState(sourceOf(db, sourceId));
        return { ...state, running: syncing.has(sourceId) };
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
