import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { prepareDatabaseSchema } from './schema.js';

/**
 * Open an empty database, an intact current one, or the immediately preceding
 * schema this build knows how to upgrade in place. Older/unknown files are
 * rejected before changing journal mode.
 */
export function createDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath);
  try {
    prepareDatabaseSchema(db);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // WAL + NORMAL：提交只追加 WAL 不逐次强制刷盘（checkpoint 统一刷）。
    // 应用崩溃不丢数据；断电可能回退最后几笔事务。托管实例的数据盘为网络
    // 存储时，默认 FULL 的逐事务 fsync 每次多一次网络往返，是写入卡顿的主因。
    db.pragma('synchronous = NORMAL');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
