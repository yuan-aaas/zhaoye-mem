import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type CommitInput,
  type CommitOutput,
  IdentityDocumentSchema,
  type IdentityStore,
  type IdentityVersionRef,
  IdentityVersionRefSchema,
  LIMITS,
  type StoredOperation,
  StoredOperationSchema,
  serializeIdentityDocument,
  ZhaoyeError,
} from '@zhaoye/contracts';
import { hashBytes, ioError, isMissing, readText, writeAtomic } from './atomic-fs.js';
import { createMutex } from './internal/mutex.js';
import { appendOperation, readLines } from './operations-log.js';
export type FaultPoint =
  | 'before_identity'
  | 'after_identity'
  | 'version'
  | 'operation'
  | 'projection'
  | 'after_identity_read'
  | 'after_version_read';
export function openIdentityStore(
  root: string,
  options: {
    fault?: (point: FaultPoint) => void | Promise<void>;
    assertOwner?: () => Promise<void>;
  } = {},
): IdentityStore {
  const dir = join(root, 'identity'),
    file = join(dir, 'identity.json'),
    index = join(dir, 'versions/index.jsonl'),
    log = join(dir, 'operations.jsonl');
  const mutex = createMutex();
  async function versions() {
    const entries = await readLines(index, IdentityVersionRefSchema);
    // The index is mandatory; unlike bounded receipts, missing history is not an empty history.
    if (
      entries[0]?.revision !== 1 ||
      entries.some((entry, i) => i > 0 && entry.revision <= (entries[i - 1]?.revision ?? 0))
    ) {
      throw new ZhaoyeError('CORRUPT_DATA', '版本索引缺失、为空或顺序非法，需显式核对恢复', {
        path: index,
      });
    }
    return entries;
  }
  const versionPath = (rev: number) => `identity/versions/${String(rev).padStart(12, '0')}.json`;
  function parseIdentity(raw: string, path: string) {
    try {
      return IdentityDocumentSchema.parse(JSON.parse(raw));
    } catch (e) {
      throw new ZhaoyeError('CORRUPT_DATA', '身份文件解析失败或不符合契约', {
        path,
        cause: String(e),
      });
    }
  }
  async function read() {
    const raw = await readText(file);
    if (raw === null || Buffer.byteLength(raw) > LIMITS.identityBytes)
      throw new ZhaoyeError('CORRUPT_DATA', '身份文件缺失或超限', { path: file });
    await options.fault?.('after_identity_read');
    const document = parseIdentity(raw, file);
    return { document, fileHash: hashBytes(raw), bytes: Buffer.byteLength(raw) };
  }
  async function findOperation(operationId: string) {
    const entries = [
      ...(await readLines(log.replace(/\.jsonl$/, '.1.jsonl'), StoredOperationSchema, true)),
      ...(await readLines(log, StoredOperationSchema, true)),
    ];
    return entries.findLast((e) => e.operation_id === operationId) ?? null;
  }
  async function commit(input: CommitInput): Promise<CommitOutput> {
    return mutex(async () => {
      await options.assertOwner?.();
      const existing = await findOperation(input.operation.operation_id);
      if (existing) {
        if (existing.adapter_id !== input.operation.adapter_id)
          throw new ZhaoyeError('UNAUTHORIZED', '幂等操作属于其他适配器');
        return {
          fileHash: existing.receipt.document_hash,
          bytes: 0,
          versionPath: existing.receipt.version_path,
          projection: existing.receipt.projection,
          warnings: existing.receipt.warnings,
          operation: existing,
          replayed: true,
        };
      }
      const current = await read();
      if (current.document.revision !== input.expectedRevision)
        throw new ZhaoyeError('CONFLICT', 'revision 已变化', {
          current_revision: current.document.revision,
        });
      if (
        input.bytes !== serializeIdentityDocument(input.document) ||
        input.document.revision !== current.document.revision + 1 ||
        input.document.assistant_id !== current.document.assistant_id
      )
        throw new ZhaoyeError('INVALID_INPUT', '非法存储提交');
      const fileHash = hashBytes(input.bytes),
        path = versionPath(input.document.revision);
      const warnings: string[] = [];
      const history = await versions(); // Never commit on top of a corrupt index.
      const previousSnapshot = await readText(join(root, path));
      if (previousSnapshot !== null && previousSnapshot !== input.bytes)
        throw new ZhaoyeError('CORRUPT_DATA', '拒绝覆盖已存在的历史快照', { path });
      try {
        await options.fault?.('before_identity');
      } catch (e) {
        throw ioError(e, file);
      }
      await writeAtomic(file, input.bytes);
      try {
        await options.fault?.('after_identity');
      } catch (e) {
        throw new ZhaoyeError('COMMIT_UNKNOWN', '身份已提交但后续处理被中断', {
          path: file,
          cause: String(e),
        });
      }
      try {
        await options.fault?.('version');
        await writeAtomic(join(root, path), input.bytes);
        history.push({
          revision: input.document.revision,
          at: input.operation.at,
          section: input.operation.section,
          operation_id: input.operation.operation_id,
          reason: input.reason,
          document_hash: fileHash,
          retained: true,
        } as IdentityVersionRef);
      } catch {
        warnings.push('version_failed');
      }
      try {
        await options.fault?.('projection');
        await writeAtomic(join(dir, 'identity.md'), input.projectionMarkdown);
      } catch {
        warnings.push('projection_failed');
      }
      const projection = {
        path: 'identity/identity.md',
        bytes: Buffer.byteLength(input.projectionMarkdown),
      };
      const operation: StoredOperation = {
        ...input.operation,
        receipt: {
          ...input.operation.receipt,
          document_hash: fileHash,
          version_path: path,
          projection,
          warnings,
        },
      };
      try {
        await options.fault?.('operation');
        await appendOperation(log, operation, StoredOperationSchema);
      } catch (e) {
        throw new ZhaoyeError('COMMIT_UNKNOWN', '身份已提交但幂等回执未持久化', {
          path: file,
          operation_id: operation.operation_id,
          cause: String(e),
        });
      }
      try {
        const retained = history.filter((e) => e.retained && e.section !== 'safety_kernel');
        for (const entry of retained.slice(0, Math.max(0, retained.length - LIMITS.versions))) {
          try {
            await unlink(join(root, versionPath(entry.revision)));
          } catch (e) {
            if (!isMissing(e)) throw e;
          }
          entry.retained = false;
        }
        await writeAtomic(index, `${history.map((e) => JSON.stringify(e)).join('\n')}\n`);
      } catch {
        warnings.push('version_index_failed');
        // Receipt already persisted: update it so retries return the same warnings.
        try {
          await appendOperation(log, operation, StoredOperationSchema);
        } catch {
          /* doctor detects index drift */
        }
      }
      return {
        fileHash,
        bytes: Buffer.byteLength(input.bytes),
        versionPath: path,
        projection,
        warnings,
        operation,
        replayed: false,
      };
    });
  }
  return {
    read,
    commit,
    findOperation,
    listVersions: async (limit) => (await versions()).slice().reverse().slice(0, limit),
    readVersion: async (rev) => {
      const entry = (await versions()).find((e) => e.revision === rev);
      if (!entry?.retained)
        throw new ZhaoyeError('CONFLICT', '历史版本不存在或已淘汰', {
          revision: rev,
          retained: false,
        });
      const path = join(root, versionPath(rev));
      const raw = await readText(path);
      if (raw === null || hashBytes(raw) !== entry.document_hash)
        throw new ZhaoyeError('CORRUPT_DATA', '历史快照缺失或摘要不符', { path });
      await options.fault?.('after_version_read');
      return parseIdentity(raw, path);
    },
    readProjection: () => readText(join(dir, 'identity.md')),
  };
}
