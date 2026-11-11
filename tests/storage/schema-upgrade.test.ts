import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, initializeDatabaseSchema, prepareDatabaseSchema } from '../../src/storage/schema.js';

// Schema 68 widens task_operation_results.outcome with `repair_pending`, which
// the Runtime already writes when a service verification failure is repairable.
// The installed account database must survive that widening in place.
const OLD_TABLE = `CREATE TABLE task_operation_results (
  task_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN (
    'execution', 'integration', 'delivery', 'safety_report', 'service'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'definite_failure', 'unknown')),
  reason_code TEXT,
  message TEXT NOT NULL DEFAULT '',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, operation_key),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
)`;

function schema67(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  initializeDatabaseSchema(db);
  db.exec('DROP TABLE task_operation_results');
  db.exec(OLD_TABLE);
  db.prepare('UPDATE schema_version SET version = 67').run();
  db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('task', 'Task', 'now', 'now')").run();
  db.prepare(`INSERT INTO task_operation_results
    (task_id, operation_key, operation_kind, outcome, reason_code, message, evidence_refs_json, updated_at)
    VALUES ('task', 'execution:1', 'execution', 'success', NULL, 'done', '[]', 'now')`).run();
  return db;
}

describe('schema 67 -> 68 upgrade', () => {
  it('rebuilds the operation result table in place and keeps existing rows', () => {
    const db = schema67();
    try {
      expect(prepareDatabaseSchema(db)).toBe('upgraded');
      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: CURRENT_SCHEMA_VERSION });
      expect(db.prepare("SELECT outcome, message FROM task_operation_results WHERE operation_key='execution:1'").get())
        .toEqual({ outcome: 'success', message: 'done' });
      // The widened constraint is the whole point: the repair path can now persist.
      db.prepare(`INSERT INTO task_operation_results
        (task_id, operation_key, operation_kind, outcome, reason_code, message, evidence_refs_json, updated_at)
        VALUES ('task', 'service:1', 'service', 'repair_pending', 'service_start_failed', 'retry', '[]', 'now')`).run();
      expect(prepareDatabaseSchema(db)).toBe('current');
    } finally { db.close(); }
  });

  it('refuses an older schema it has no upgrade for', () => {
    const db = schema67();
    try {
      db.prepare('UPDATE schema_version SET version = 66').run();
      expect(() => prepareDatabaseSchema(db)).toThrow(/refuses legacy SQLite schema 66/u);
    } finally { db.close(); }
  });

  it('creates an empty database with the current version', () => {
    const db = new Database(':memory:');
    try {
      expect(prepareDatabaseSchema(db)).toBe('created');
      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: CURRENT_SCHEMA_VERSION });
    } finally { db.close(); }
  });
});
