import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';

function schema49() {
  const db = new Database(':memory:');
  runMigrations(db);
  db.exec(`ALTER TABLE subtasks DROP COLUMN file_outputs_json;
    UPDATE schema_version SET version = 49;
    INSERT INTO tasks (id, title, goal, status, created_at, updated_at)
      VALUES ('old', 'History', 'Preserve old authorizations', 'done', 'now', 'now');`);
  return db;
}

describe('schema 50 explicit file output declarations', () => {
  it('adds nullable historical declarations transactionally and is idempotent', () => {
    const db = schema49();
    try {
      const history = db.prepare('SELECT * FROM tasks').all();
      runMigrations(db);
      runMigrations(db);
      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 50 });
      expect(db.prepare('SELECT * FROM tasks').all()).toEqual(history);
      expect(db.prepare('PRAGMA table_info(subtasks)').all()).toContainEqual(expect.objectContaining({ name: 'file_outputs_json', notnull: 0, dflt_value: null }));
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally { db.close(); }
  });

  it('rolls back the added column when version advancement fails', () => {
    const db = schema49();
    try {
      db.exec(`CREATE TRIGGER fail_version BEFORE UPDATE ON schema_version
        BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;`);
      expect(() => runMigrations(db)).toThrow('injected migration failure');
      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 49 });
      expect(db.prepare('PRAGMA table_info(subtasks)').all()).not.toContainEqual(expect.objectContaining({ name: 'file_outputs_json' }));
    } finally { db.close(); }
  });
});
