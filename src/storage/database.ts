import Database from 'better-sqlite3';
import { copyFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  CURRENT_SCHEMA_VERSION,
  runMigrations,
  type Schema30MigrationContext,
} from './migrations.js';

/**
 * 创建并初始化数据库连接
 */
export function createDatabase(
  dbPath: string,
  _migrationContext?: Schema30MigrationContext,
): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const version = readSchemaVersion(db);
    if (version === 30) {
      throw new Error(
        'runtime startup cannot migrate schema 30 in place; run the transactional MetaWork updater',
      );
    }
    // 降级守卫：迁移是单向的，结构被新版本改过的库旧代码读不了。宁可拒绝启动
    // 也不能硬读写把数据写坏；恢复迁移前备份或换用不小于迁移版本的 release。
    if (version !== null && version > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `the database was migrated to schema ${version} by a newer MetaWork release`
        + ` (this build supports up to schema ${CURRENT_SCHEMA_VERSION});`
        + ' restore the pre-migration backup or run a release that is not older than the one that migrated this volume',
      );
    }
    // 迁移前备份：迁移一旦执行即不可逆，跨迁移边界回滚依赖这份备份。
    if (version !== null && version < CURRENT_SCHEMA_VERSION) {
      backupBeforeMigration(db, dbPath, version);
    }
    runMigrations(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function readSchemaVersion(db: Database.Database): number | null {
  const table = db.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = 'schema_version'
  `).get() as { present: 1 } | undefined;
  if (!table) return null;
  const rows = db.prepare('SELECT version FROM schema_version ORDER BY version').all() as Array<{
    version: number;
  }>;
  return rows.length === 1 ? rows[0]!.version : null;
}

/** 迁移前整库备份：先 checkpoint 合并 WAL，让主文件自含全部已提交数据。 */
function backupBeforeMigration(db: Database.Database, dbPath: string, fromVersion: number): void {
  db.pragma('wal_checkpoint(TRUNCATE)');
  const backupsDir = join(dirname(dbPath), 'backups');
  mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  copyFileSync(dbPath, join(backupsDir, `${basename(dbPath)}.pre-migration-${fromVersion}-${stamp}`));
}
