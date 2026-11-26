import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ZhaoyeError } from '@zhaoye/contracts';
import { ensureDir, ioError } from '../atomic-fs.js';
import { BACKUP_SCHEMA, BACKUP_SCHEMA_VERSION } from './backup-schema.js';

export const databasePath = (root: string) => join(root, 'backup', 'zhaoye.db');

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = work();
    try {
      db.exec('COMMIT');
    } catch (error) {
      throw new ZhaoyeError('COMMIT_UNKNOWN', '备份提交结果需要核对', { cause: String(error) });
    }
    return value;
  } catch (error) {
    // The original failure remains the useful diagnostic if SQLite already rolled back.
    try {
      db.exec('ROLLBACK');
    } catch {
      // Best effort.
    }
    throw error;
  }
}

export function sqliteError(error: unknown, path: string): ZhaoyeError {
  const code = (error as { errcode?: number } | null)?.errcode;
  if (code !== undefined && [11, 26].includes(code & 255))
    return new ZhaoyeError('CORRUPT_DATA', 'SQLite 备份库损坏', { path });
  if (code !== undefined && [5, 6].includes(code & 255))
    return new ZhaoyeError('LOCKED', 'SQLite 备份库正忙', { path });
  return ioError(error, path);
}

export async function openSqlite(path: string, mode: 'read' | 'write' | 'create') {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, {
    readOnly: mode === 'read',
    enableForeignKeyConstraints: true,
  });
  try {
    db.exec('PRAGMA busy_timeout=3000; PRAGMA trusted_schema=OFF;');
    const checkSchema = () => {
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      if (version === 0 && mode === 'create') {
        const objects = db
          .prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
          .get();
        if (!objects) {
          db.exec(BACKUP_SCHEMA);
          db.prepare("INSERT INTO meta VALUES ('format','zhaoye-backup')").run();
          db.exec(`PRAGMA user_version=${BACKUP_SCHEMA_VERSION}`);
          return;
        }
      }
      if (version !== BACKUP_SCHEMA_VERSION)
        throw new ZhaoyeError('SCHEMA_MIGRATION_REQUIRED', '备份库版本不受支持', { path, version });
      const format = db.prepare("SELECT value FROM meta WHERE key='format'").get()?.value;
      if (format !== 'zhaoye-backup')
        throw new ZhaoyeError('CORRUPT_DATA', '备份库格式标记缺失', { path });
    };
    if (mode === 'create') transaction(db, checkSchema);
    else checkSchema();
    if (mode !== 'read' && db.prepare('PRAGMA journal_mode=WAL').get()?.journal_mode !== 'wal')
      throw new ZhaoyeError('STORAGE_FAILURE', '无法启用备份库 WAL', { path });
    return db;
  } catch (error) {
    db.close();
    throw sqliteError(error, path);
  }
}

export async function initializeBackup(root: string): Promise<void> {
  const file = databasePath(root);
  await ensureDir(join(dirname(file), 'exports'));
  const db = await openSqlite(file, 'create');
  db.close();
}
