import type { Zhaoye } from '@zhaoye/app';
import { type ActorContext, ZhaoyeError } from '@zhaoye/contracts';
import { pageContent, parseOffset } from './identity-context.js';

type Backup = Zhaoye['backup'];
const access = (batch_id?: string, history?: string) => {
  if (history !== undefined && history !== 'true')
    throw new ZhaoyeError('INVALID_INPUT', 'history 只接受 true');
  return {
    includeUnassigned: true,
    ...(batch_id ? { batchId: batch_id } : {}),
    history: history === 'true',
  };
};

export async function findBackup(
  backup: Backup,
  actor: ActorContext,
  args: {
    source_id: string | undefined;
    batch_id: string | undefined;
    history: string | undefined;
    query: string | undefined;
    cursor: string | undefined;
    offset: string | undefined;
  },
) {
  const { source_id, batch_id, history, query, cursor } = args;
  const offset = parseOffset(args.offset);
  if (!source_id || !query) {
    if (
      cursor !== undefined ||
      batch_id !== undefined ||
      history !== undefined ||
      (!source_id && query !== undefined)
    )
      throw new ZhaoyeError('INVALID_INPUT', '备份检索需要备份来源和查询词');
    const items = source_id
      ? await backup.listImportBatches(source_id, access(), actor)
      : await backup.listSources(actor);
    return {
      items: items.slice(offset, offset + 1),
      next_offset: offset + 1 < items.length ? String(offset + 1) : null,
    };
  }
  if (args.offset !== undefined) throw new ZhaoyeError('INVALID_INPUT', '备份搜索续页使用 cursor');
  const page = await backup.searchBackup(
    source_id,
    {
      ...access(batch_id, history),
      query,
      limit: 1,
      ...(cursor !== undefined ? { cursor } : {}),
    },
    actor,
  );
  return {
    items: page.hits.map((hit) => ({
      record_id: hit.record_id,
      batch_id: hit.batch.batch_id,
      title: [...hit.title].slice(0, 40).join(''),
      updated_at: hit.source_updated_at,
    })),
    coverage: page.coverage,
    next_cursor: page.next_cursor,
  };
}

export async function readBackup(
  backup: Backup,
  actor: ActorContext,
  args: {
    source_id: string;
    record_id: string;
    batch_id: string | undefined;
    history: string | undefined;
    field: string | undefined;
    version_id: string | undefined;
    offset: string | undefined;
  },
) {
  const { source_id, record_id, batch_id, history, field = 'body', version_id } = args;
  const offset = parseOffset(args.offset);
  if (offset > 0 && !version_id) throw new ZhaoyeError('INVALID_INPUT', '续读需要 version_id');
  if (!['body', 'title', 'metadata'].includes(field))
    throw new ZhaoyeError('INVALID_INPUT', '可读正文、标题或元数据');
  const record = await backup.getBackupRecord(
    source_id,
    record_id,
    access(batch_id, history),
    actor,
  );
  if (version_id && version_id !== record.version_id)
    throw new ZhaoyeError('CONFLICT', '备份记录版本已变化，请重新定位');
  const value =
    field === 'metadata'
      ? JSON.stringify(record.metadata, null, 2)
      : field === 'title'
        ? record.title
        : record.body;
  return pageContent(value, offset, (content, next) => ({
    version_id: record.version_id,
    batch_id: record.batch.batch_id,
    content,
    next_offset: next === null ? null : String(next),
  }));
}
