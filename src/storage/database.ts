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
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
