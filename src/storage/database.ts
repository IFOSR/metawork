import Database from 'better-sqlite3';
import {
  runMigrations,
  type Schema30MigrationContext,
} from './migrations.js';

/**
 * 创建并初始化数据库连接
 */
export function createDatabase(
  dbPath: string,
  migrationContext?: Schema30MigrationContext,
): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationContext);
  return db;
}
