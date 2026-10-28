import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, runMigrations } from '../../src/storage/migrations.js';
import { KernelDispatchItemRepo } from '../../src/storage/kernel-dispatch-item-repo.js';

function insertItem(db: Database.Database, attemptId: string, status: string): void {
  db.prepare(`INSERT INTO kernel_dispatch_items (
    attempt_id, decision_id, batch_order, task_id, generation_id, subtask_id,
    agent_class_name, attempt_kind, recovery_mode, status,
    configuration_revision, authorized_binding_json, binding_fingerprint,
    created_at, updated_at)
    VALUES (?, 'decision_1', 0, 'task_1', 'generation_1', 'subtask_1', 'pi-agent',
      'primary', 'fresh', ?, 'revision_1',
      '{"agentClassRef":"pi-agent","harnessRef":"pi","providerRef":"p","modelRef":"m","permissionProfileRef":"profile"}',
      'fingerprint', 'now', 'now')`)
    .run(attemptId, status);
}

function baseDatabase(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  db.prepare(`INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
    VALUES ('revision_1','hash','native','now')`).run();
  db.prepare("INSERT INTO tasks (id,title,goal,status,created_at,updated_at) VALUES ('task_1','T','G','running','now','now')").run();
  db.prepare(`INSERT INTO subtasks (id, task_id, graph_revision, title, goal, status, dependencies_json,
    context_refs_json, required_capabilities_json, executor_bindings_json, file_outputs_json,
    acceptance_json, risk_level, created_at, updated_at)
    VALUES ('subtask_1','task_1',1,'S','G','ready','[]','[]','[]','[]','[]','[]','low','now','now')`).run();
  return db;
}

describe('dispatch terminal disposition', () => {
  it('records why a terminal item stopped and keeps it out of the active sets', () => {
    const db = baseDatabase();
    try {
      insertItem(db, 'attempt_1', 'running');
      const repo = new KernelDispatchItemRepo(db);
      repo.markNotStarted('attempt_1', 'attempt yielded without execution: partition_conflict_observed', 'later');
      const record = repo.find('attempt_1');
      expect(record?.status).toBe('terminal');
      expect(record?.terminalDisposition).toBe('not_started');
      expect(record?.errorSummary).toContain('partition_conflict_observed');
      expect(repo.listPending('task_1')).toEqual([]);
      expect(repo.listBlocking()).toEqual([]);
      expect(repo.listTimelineByTasks(['task_1'])[0]?.terminalDisposition).toBe('not_started');
    } finally { db.close(); }
  });

  it('adds the disposition column to an existing database without rebuilding facts', () => {
    const db = baseDatabase();
    try {
      // Simulate the schema-60 shape: no disposition column, existing history.
      db.exec('ALTER TABLE kernel_dispatch_items DROP COLUMN terminal_disposition');
      db.exec('UPDATE schema_version SET version = 60');
      insertItem(db, 'attempt_old', 'terminal');
      expect(db.prepare('PRAGMA table_info(kernel_dispatch_items)').all())
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'terminal_disposition' })]));
      runMigrations(db);
      runMigrations(db);
      expect(db.prepare('SELECT version FROM schema_version').get())
        .toEqual({ version: CURRENT_SCHEMA_VERSION });
      const columns = (db.prepare('PRAGMA table_info(kernel_dispatch_items)').all() as Array<{ name: string }>)
        .map(column => column.name);
      expect(columns).toContain('terminal_disposition');
      // Historical rows are untouched: they simply have no disposition yet.
      expect(new KernelDispatchItemRepo(db).find('attempt_old')).toMatchObject({
        status: 'terminal',
        terminalDisposition: null,
      });
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally { db.close(); }
  });

  it('marks an executed attempt with the executed disposition', () => {
    const db = baseDatabase();
    try {
      insertItem(db, 'attempt_1', 'running');
      const repo = new KernelDispatchItemRepo(db);
      repo.markTerminal('attempt_1', null, 'later');
      expect(repo.find('attempt_1')?.terminalDisposition).toBe('executed');
    } finally { db.close(); }
  });
});
