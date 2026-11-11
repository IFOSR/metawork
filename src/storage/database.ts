import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertDatabaseSchema, initializeDatabaseSchema } from './schema.js';

/** Open only empty or intact current databases. Reject old files before changing journal mode. */
export function createDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath);
  try {
    assertDatabaseSchema(db);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initializeDatabaseSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
