import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, runMigrations } from '../../src/storage/migrations.js';

function legacyDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.exec(`DROP TABLE workspace_publication_deliveries; UPDATE schema_version SET version = 48;
    INSERT INTO tasks (id, title, goal, status, created_at, updated_at)
    VALUES ('historical', 'History', 'Keep history intact', 'done', '2026-10-14', '2026-10-14');`);
  return db;
}

describe('schema 49 durable publication delivery migration', () => {
  it('preserves history without manufacturing delivery facts, and is repeatable', () => {
    const db = legacyDatabase();
    try {
      const history = db.prepare('SELECT * FROM tasks').all();
      runMigrations(db);
      runMigrations(db);
      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: CURRENT_SCHEMA_VERSION });
      expect(db.prepare('SELECT * FROM tasks').all()).toEqual(history);
      expect(db.prepare('SELECT * FROM workspace_publication_deliveries').all()).toEqual([]);
      expect(() => db.exec(`INSERT INTO workspace_publication_deliveries VALUES ('missing', 'pending', '[]', '[]', 'now')`)).toThrow('FOREIGN KEY');
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally { db.close(); }
  });

  it('rolls back the table and index when the version transaction fails', () => {
    const db = legacyDatabase();
    try {
      db.exec(`CREATE TRIGGER fail_delivery_migration BEFORE UPDATE ON schema_version
        WHEN NEW.version = 49 BEGIN SELECT RAISE(ABORT, 'injected delivery migration failure'); END;`);
      expect(() => runMigrations(db)).toThrow('injected delivery migration failure');
      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 48 });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'workspace_publication_deliver%'").all()).toEqual([]);
      db.exec('DROP TRIGGER fail_delivery_migration');
      runMigrations(db);
      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: CURRENT_SCHEMA_VERSION });
    } finally { db.close(); }
  });
});
