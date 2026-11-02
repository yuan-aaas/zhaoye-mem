import { type OwnerInfo, ZhaoyeError } from '@zhaoye/contracts';
import { renderIdentityMarkdown } from '@zhaoye/core';
import {
  createPresence,
  isStale,
  openDataRoot,
  openIdentityStore,
  pidAlive,
  resolveDataRoot,
} from '@zhaoye/storage';
export interface DoctorReport {
  data_root: string;
  schema_version: number;
  assistant_id: string | null;
  revision: number | null;
  checks: Array<{ id: string; status: 'ok' | 'warn' | 'fail'; detail: string }>;
  presence: { state: 'active' | 'stale' | 'none'; owner: OwnerInfo | null };
}
export async function doctor(dataRoot?: string): Promise<DoctorReport> {
  const root = resolveDataRoot(dataRoot);
  const result: DoctorReport = {
    data_root: root,
    schema_version: 1,
    assistant_id: null,
    revision: null,
    checks: [],
    presence: { state: 'none', owner: null },
  };
  const check = (id: string, status: 'ok' | 'warn' | 'fail', detail: string) =>
    result.checks.push({ id, status, detail });
  try {
    const { manifest } = await openDataRoot(root);
    result.assistant_id = manifest.assistant_id;
    check('manifest', 'ok', '数据根与身份有效');
    const store = openIdentityStore(root);
    const current = await store.read();
    result.revision = current.document.revision;
    check('identity', 'ok', current.fileHash);
    const projection = await store.readProjection();
    check(
      'projection',
      projection === renderIdentityMarkdown(current.document) ? 'ok' : 'warn',
      projection === null
        ? '投影缺失，可从 JSON 重建'
        : projection === renderIdentityMarkdown(current.document)
          ? '投影一致'
          : '投影与 JSON 不一致',
    );
    const versions = await store.listVersions(Number.MAX_SAFE_INTEGER);
    const currentVersion = versions.find((v) => v.revision === current.document.revision);
    check(
      'current_version',
      currentVersion?.document_hash === current.fileHash ? 'ok' : 'warn',
      currentVersion ? '当前版本摘要检查' : '当前 JSON 缺少版本元数据；旧版本不能凭操作记录恢复',
    );
    for (const v of versions.filter((v) => v.retained)) {
      try {
        await store.readVersion(v.revision);
      } catch (e) {
        check(`version_${v.revision}`, 'fail', String(e));
      }
    }
    const lastVersion = versions[0];
    if (lastVersion) {
      const operation = await store.findOperation(lastVersion.operation_id);
      if (current.document.revision > 1)
        check(
          'operation',
          operation?.receipt.document_hash === current.fileHash ? 'ok' : 'warn',
          operation ? '检查最新操作回执' : '缺少最新操作回执；需要人工核对后再重试',
        );
    } else await store.findOperation('');
    check('history', 'ok', '已检查快照与操作记录');
  } catch (e) {
    check('data', 'fail', e instanceof ZhaoyeError ? `${e.code}: ${e.message}` : String(e));
  }
  try {
    const owner = await createPresence(root).read();
    if (owner) {
      const stale = isStale(owner, new Date()) || !pidAlive(owner.pid);
      result.presence = { state: stale ? 'stale' : 'active', owner };
      check(
        'presence',
        stale ? 'warn' : 'ok',
        stale ? '心跳过期或 PID 已死亡；活 PID 不会被自动接管' : '实例存活',
      );
    } else check('presence', 'ok', '无活跃实例');
  } catch (e) {
    check('presence', 'fail', String(e));
  }
  return result;
}
