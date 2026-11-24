import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  type BackupAccess,
  type BackupBatchSummary,
  type BackupDetail,
  type BackupResult,
  type BackupSearchCriteria,
  ZhaoyeError,
} from '@zhaoye/contracts';
import { hashBytes } from '../atomic-fs.js';

type Row = Omit<BackupDetail, 'batch' | 'metadata' | 'snippet'> & {
  batch_id: string;
  captured_at: string;
  finished_at: string;
  status: 'complete' | 'partial';
  metadata_json: string;
};

function projectFilter(access: BackupAccess): [string, SQLInputValue[]] {
  return [
    `((r.project_id IS NULL AND ?) OR
       (r.project_id IS NOT NULL AND (? OR r.project_id IN (SELECT value FROM json_each(?)))))`,
    [
      Number(access.includeUnassigned),
      Number(access.projects === '*'),
      JSON.stringify(access.projects === '*' ? [] : access.projects),
    ],
  ];
}

export function listBackupBatches(db: DatabaseSync, access: BackupAccess): BackupBatchSummary[] {
  const [condition, args] = projectFilter(access);
  return db
    .prepare(`
    SELECT b.batch_id, b.status, b.captured_at, b.finished_at,
      (SELECT count(*) FROM batch_records r WHERE r.batch_id=b.batch_id
        AND r.search_allowed=1 AND r.raw_ref IS NOT NULL AND ${condition}) AS rows
    FROM import_batches b JOIN backup_sources s USING(source_id)
    WHERE b.source_id=? AND b.scope_key=? AND s.scope_id=?
    ORDER BY b.started_at DESC,b.batch_id
  `)
    .all(
      ...args,
      access.sourceId,
      access.scopeKey,
      access.scopeId,
    ) as unknown as BackupBatchSummary[];
}

function selectBatch(db: DatabaseSync, access: BackupAccess) {
  if (access.batchId) {
    const batch = db
      .prepare(`
      SELECT b.batch_id, b.status, b.captured_at, b.capture_seq FROM import_batches b
      JOIN backup_sources s USING(source_id)
      WHERE b.batch_id=? AND b.source_id=? AND b.scope_key=? AND s.scope_id=?
        AND b.status IN ('complete','partial')
    `)
      .get(access.batchId, access.sourceId, access.scopeKey, access.scopeId);
    if (!batch) throw new ZhaoyeError('NOT_FOUND', '当前授权范围没有指定批次');
    return batch;
  }
  return db
    .prepare(`
    SELECT b.batch_id, b.status, b.captured_at, b.capture_seq FROM backup_scope_heads h
    JOIN import_batches b USING(batch_id) JOIN backup_sources s ON s.source_id=h.source_id
    WHERE h.source_id=? AND h.scope_key=? AND s.scope_id=?
  `)
    .get(access.sourceId, access.scopeKey, access.scopeId);
}

function candidateQuery(access: BackupAccess, batchId: string) {
  const [projects, args] = projectFilter(access);
  return {
    sql: `SELECT r.record_id, r.version_id, r.source_id, r.project_id, r.visibility, i.native_id,
      r.source_updated_at, r.metadata_json, v.title, v.body, v.kind, v.content_hash,
      b.batch_id, b.captured_at, b.finished_at, b.status
    FROM batch_records r JOIN import_batches b USING(batch_id)
    JOIN record_versions v ON v.version_id=r.version_id JOIN source_records i ON i.record_id=r.record_id
    WHERE r.batch_id=? AND r.search_allowed=1 AND ${projects}
      AND (r.visibility='visible' OR (? AND r.visibility_reason IN ('archived','forgotten','archived_forgotten')))
      AND NOT EXISTS (
        SELECT 1 FROM batch_records latest JOIN import_batches lb ON lb.batch_id=latest.batch_id
        WHERE latest.record_id=r.record_id AND lb.source_id=b.source_id AND lb.scope_key=b.scope_key
          AND lb.capture_seq>coalesce(b.capture_seq,0)
          AND lb.capture_seq=(
            SELECT max(o.capture_seq) FROM batch_records observed JOIN import_batches o
              ON o.batch_id=observed.batch_id
            WHERE observed.record_id=r.record_id AND o.source_id=b.source_id AND o.scope_key=b.scope_key
          )
          AND (latest.search_allowed=0 OR latest.project_id IS NOT r.project_id
            OR (latest.visibility<>'visible' AND (NOT ? OR latest.visibility_reason NOT IN ('archived','forgotten','archived_forgotten')
              OR latest.visibility_reason IS NULL)))
      )`,
    args: [batchId, ...args, Number(access.history), Number(access.history)],
  };
}

function detail(row: Row): BackupDetail {
  const { batch_id, captured_at, finished_at, status, metadata_json, ...data } = row;
  let metadata: BackupDetail['metadata'];
  try {
    metadata = JSON.parse(metadata_json) as BackupDetail['metadata'];
  } catch {
    throw new ZhaoyeError('CORRUPT_DATA', '备份记录元数据已损坏');
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    throw new ZhaoyeError('CORRUPT_DATA', '备份记录元数据已损坏');
  return {
    ...data,
    metadata,
    snippet: [...data.body].slice(0, 300).join(''),
    batch: { batch_id, captured_at, finished_at, status },
  };
}

export function readBackupRecords(
  db: DatabaseSync,
  access: BackupAccess,
  recordId?: string,
): BackupDetail[] {
  const batch = selectBatch(db, access);
  if (!batch) return [];
  const candidate = candidateQuery(access, batch.batch_id as string);
  return (
    db
      .prepare(`${candidate.sql} AND (? IS NULL OR r.record_id=?) ORDER BY r.record_id`)
      .all(...candidate.args, recordId ?? null, recordId ?? null) as unknown as Row[]
  ).map(detail);
}

export function searchBackupRows(
  db: DatabaseSync,
  access: BackupAccess,
  input: BackupSearchCriteria,
): BackupResult {
  const { query, cursor, limit, from, to } = input;
  const batch = selectBatch(db, access);
  const latest = db
    .prepare(`
    SELECT max(capture_seq) seq, max(captured_at) newest FROM import_batches
    WHERE source_id=? AND scope_key=? AND status IN ('complete','partial') AND capture_mode='live'
  `)
    .get(access.sourceId, access.scopeKey);
  const partial =
    !batch ||
    batch.status === 'partial' ||
    (!access.batchId && Number(latest?.seq) > Number(batch.capture_seq));
  const token = hashBytes(JSON.stringify({ access, batch, latest, query, from, to, limit }));
  let offset = 0;
  if (cursor) {
    const [fingerprint, value, extra] = cursor.split('.');
    offset = Number(value);
    if (fingerprint !== token || extra !== undefined || !Number.isSafeInteger(offset) || offset < 1)
      throw new ZhaoyeError('CONFLICT', '检索游标已失效，请从第一页重新查询');
  }
  let rows: Row[] = [];
  if (batch) {
    const candidate = candidateQuery(access, batch.batch_id as string);
    const inTime = `${candidate.sql} AND (? IS NULL OR r.source_updated_at>=?) AND (? IS NULL OR r.source_updated_at<=?)`;
    const params = [...candidate.args, from ?? null, from ?? null, to ?? null, to ?? null];
    const short = [...query].length < 3;
    if (!short) {
      const inconsistent = db
        .prepare(`
        WITH eligible AS MATERIALIZED (SELECT version_id, title, body FROM (${inTime})),
        indexed AS (
          SELECT f.version_id, count(*) AS entries, min(f.title) AS title, min(f.body) AS body
          FROM record_fts f JOIN eligible e ON e.version_id=f.version_id
          GROUP BY f.version_id
        )
        SELECT 1 FROM eligible e LEFT JOIN indexed i USING(version_id)
        WHERE i.entries IS NOT 1 OR i.title IS NOT e.title OR i.body IS NOT e.body
        LIMIT 1
      `)
        .get(...params);
      if (inconsistent)
        throw new ZhaoyeError('INTEGRITY_FAILED', '查询范围内的全文索引与正文版本不一致');
    }
    const match = short
      ? '(instr(lower(v.title),lower(?))>0 OR instr(lower(v.body),lower(?))>0)'
      : 'v.version_id IN (SELECT version_id FROM record_fts WHERE record_fts MATCH ?)';
    const term = `"${query.replaceAll('"', '""')}"`;
    rows = db
      .prepare(`
      ${inTime} AND ${match}
      ORDER BY CASE WHEN lower(v.title)=lower(?) THEN 0 WHEN instr(lower(v.title),lower(?))>0 THEN 1 ELSE 2 END,
        r.source_updated_at DESC, r.record_id
      LIMIT ? OFFSET ?
    `)
      .all(
        ...params,
        ...(short ? [query, query] : [term]),
        query,
        query,
        limit + 1,
        offset,
      ) as unknown as Row[];
  }
  const more = rows.length > limit;
  const hits = rows.slice(0, limit).map((row) => {
    const { metadata: _meta, body: _body, native_id: _id, ...hit } = detail(row);
    return hit;
  });
  return {
    hits,
    coverage: partial || more ? 'partial' : 'complete',
    next_cursor: more ? `${token}.${offset + limit}` : null,
    batch_coverage: {
      oldest_complete_batch_at: batch?.status === 'complete' ? (batch.captured_at as string) : null,
      newest_batch_at: (latest?.newest ?? batch?.captured_at ?? null) as string | null,
      includes_partial_batch: partial && Boolean(latest?.seq || batch?.status === 'partial'),
    },
  };
}
