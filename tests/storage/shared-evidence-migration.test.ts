import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, runMigrations } from '../../src/storage/migrations.js';

function legacyDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.exec(`
    DROP TABLE task_execution_evidence;
    CREATE TABLE task_execution_evidence (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT,
      title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL,
      exact_only INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );
    CREATE INDEX idx_task_execution_evidence_task ON task_execution_evidence(task_id, created_at, id);
    UPDATE schema_version SET version = 47;
    INSERT INTO tasks (id, title, goal, status, created_at, updated_at)
      VALUES ('b', 'B', 'goal', 'ready', '2026-10-13', '2026-10-13'),
             ('c', 'C', 'goal', 'ready', '2026-10-13', '2026-10-13');
    INSERT INTO task_execution_evidence VALUES
      ('evidence_user_interaction_source', 'b', 'user_input', 'source', 'title', '314159', 0, '2026-10-13'),
      ('evidence_assistant_interaction_source', 'b', 'assistant_ref', 'source', 'reply', 'recorded', 1, '2026-10-13');
  `);
  return db;
}

describe('schema 48 task-scoped evidence migration', () => {
  it('preserves all old columns and IDs, permits another association, and is idempotent', () => {
    const db = legacyDatabase();
    try {
      const before = db.prepare('SELECT * FROM task_execution_evidence ORDER BY id').all();
      runMigrations(db);
      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: CURRENT_SCHEMA_VERSION });
      expect(db.prepare('SELECT * FROM task_execution_evidence ORDER BY id').all()).toEqual(before);
      db.exec(`INSERT INTO task_execution_evidence
        SELECT id, 'c', kind, source_id, title, content, exact_only, created_at FROM task_execution_evidence WHERE task_id = 'b'`);
      runMigrations(db);
      expect(db.prepare('SELECT COUNT(*) AS count FROM task_execution_evidence').get()).toEqual({ count: 4 });
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(() => db.exec(`INSERT INTO task_execution_evidence
        (id, task_id, kind, content, created_at) VALUES ('foreign', 'missing', 'user_input', '', '')`)).toThrow('FOREIGN KEY');
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_task_execution_evidence_task'").get()).toBeDefined();
    } finally { db.close(); }
  });

  it('rolls the whole table rebuild back if committing the version fails', () => {
    const db = legacyDatabase();
    try {
      const before = db.prepare('SELECT * FROM task_execution_evidence ORDER BY id').all();
      db.exec(`CREATE TRIGGER fail_migration BEFORE UPDATE ON schema_version
        WHEN NEW.version = 48 BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;`);
      expect(() => runMigrations(db)).toThrow('injected migration failure');
      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 47 });
      expect(db.prepare('SELECT * FROM task_execution_evidence ORDER BY id').all()).toEqual(before);
      expect((db.pragma('table_info(task_execution_evidence)') as Array<{ name: string; pk: number }>)
        .filter(column => column.pk).map(column => column.name)).toEqual(['id']);
      db.exec('DROP TRIGGER fail_migration');
      runMigrations(db);
      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: CURRENT_SCHEMA_VERSION });
    } finally { db.close(); }
  });
});
