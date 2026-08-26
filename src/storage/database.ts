import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
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
