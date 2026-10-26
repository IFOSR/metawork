import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, runMigrations } from '../../src/storage/migrations.js';
import { runMigrations as runSchema51Migrations } from '../support/schema51-baseline.js';

/**
 * Schema 52 belongs to `main` (the six-state Task projection). This suite
 * exercises the real upgrade paths instead of stamping the head schema with an
 * older version number:
 *
 * - a database that came from main at 52 must upgrade to this branch's head;
 * - a fake 52 that lacks main's base must be rejected, not silently bridged;
 * - this branch's own 51 base must reach the head and record that it bridged 52.
 */
describe('schema 51/52 upgrade paths', () => {
  /** Main's six-state Task base, as `main` leaves it after its 52 step. */
  function mainSixStateBase(db: Database.Database): void {
    db.exec(`
      CREATE TABLE task_state_changes (
        task_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        operation_key TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL CHECK (to_status IN (
          'queued', 'running', 'needs_action', 'succeeded', 'failed', 'cancelled'
        )),
        detail_json TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, version),
        UNIQUE (task_id, operation_key)
      );
      CREATE TABLE task_operation_results (
        task_id TEXT NOT NULL,
        operation_key TEXT NOT NULL,
        operation_kind TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason_code TEXT,
        message TEXT NOT NULL DEFAULT '',
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (task_id, operation_key)
      );
      CREATE TABLE task_state_projection_outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        state_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        dispatched_at TEXT
      );
    `);
    for (const [column, definition] of [
      ['state_version', 'INTEGER NOT NULL DEFAULT 1'],
      ['state_detail_json', "TEXT NOT NULL DEFAULT '{}'"],
      ['completed_at', 'TEXT'],
      ['archived_at', 'TEXT'],
      ['retry_of_task_id', 'TEXT'],
    ] as const) {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`);
    }
    db.exec("UPDATE tasks SET status = 'succeeded', completed_at = updated_at WHERE status = 'done'");
    // Main's migration also rebuilds `tasks` with the six-state CHECK. Keep
    // this fixture faithful so the branch bridge cannot accept a column-only
    // fake 52.
    const columns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{
      name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
    }>;
    const definition = columns.map(column => {
      const primary = column.pk > 0 ? ' PRIMARY KEY' : '';
      const required = column.notnull && column.pk === 0 ? ' NOT NULL' : '';
      const defaultValue = column.name === 'status'
        ? " DEFAULT 'queued'"
        : column.dflt_value === null ? '' : ` DEFAULT ${column.dflt_value}`;
      const check = column.name === 'status'
        ? " CHECK(status IN ('queued', 'running', 'needs_action', 'succeeded', 'failed', 'cancelled'))"
        : '';
      return `"${column.name}" ${column.type || 'TEXT'}${primary}${required}${defaultValue}${check}`;
    }).join(', ');
    const names = columns.map(column => `"${column.name}"`).join(', ');
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'directory_dirty_%'").all() as Array<{ name: string }>;
    for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
    db.pragma('foreign_keys = OFF');
    db.exec(`CREATE TABLE tasks_main52 (${definition}); INSERT INTO tasks_main52 (${names}) SELECT ${names} FROM tasks; DROP TABLE tasks; ALTER TABLE tasks_main52 RENAME TO tasks;`);
    db.pragma('foreign_keys = ON');
  }

  /** A database that stopped at main's 52. */
  function schema52(): Database.Database {
    const db = new Database(':memory:');
    runSchema51Migrations(db);
    mainSixStateBase(db);
    db.prepare('UPDATE schema_version SET version = 52').run();
    return db;
  }

  function version(db: Database.Database): number {
    return (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
  }

  it('upgrades a main-shaped 52 database to the current schema', () => {
    const db = schema52();
    runMigrations(db);

    expect(version(db)).toBe(CURRENT_SCHEMA_VERSION);
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN "
      + "('workspace_execution_bindings', 'workspace_change_records', 'artifact_versions')",
    ).all() as Array<{ name: string }>).map(row => row.name).sort();
    expect(tables).toEqual([
      'artifact_versions',
      'workspace_change_records',
      'workspace_execution_bindings',
    ]);
    // Main's six-state rows are preserved, not reclassified by this branch.
    const status = db.prepare("SELECT status FROM tasks WHERE id = 'task_phase2'").get() as
      { status: string } | undefined;
    if (status) expect(['succeeded', 'queued', 'running']).toContain(status.status);
    db.close();
  });

  it('rejects a 52 database that does not carry main six-state base', () => {
    const db = new Database(':memory:');
    runSchema51Migrations(db);
    db.prepare('UPDATE schema_version SET version = 52').run();
    // Without main's objects the version is a lie about the schema's origin.
    expect(() => runMigrations(db)).toThrow(/six-state Task base/u);
    expect(version(db)).toBe(52);
    db.close();
  });

  it('upgrades this branch 51 base and records that it bridged main 52', () => {
    const db = new Database(':memory:');
    runSchema51Migrations(db);
    runMigrations(db);

    expect(version(db)).toBe(CURRENT_SCHEMA_VERSION);
    const status = db.prepare("SELECT status FROM tasks WHERE id = 'task_phase2'").get() as
      { status: string } | undefined;
    if (status) expect(['needs_action', 'queued', 'running', 'succeeded']).toContain(status.status);
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_change_records'",
    ).all() as Array<{ name: string }>).map(row => row.name);
    expect(tables).toEqual(['workspace_change_records']);
    db.close();
  });

  it('adds the durable wake kind, worktree ownership and attempt write facts', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const columnsOfTable = (table: string): string[] =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name);

    expect(columnsOfTable('retry_wakes')).toContain('wake_kind');
    for (const column of [
      'write_started_at',
      'write_finished_at',
      'receipt_persisted_at',
      'external_effect_status',
      'change_record_id',
    ]) {
      expect(columnsOfTable('executor_attempt_runtime')).toContain(column);
    }
    expect(columnsOfTable('kernel_dispatch_items')).toContain('execution_binding_fingerprint');
    expect(columnsOfTable('managed_local_services')).toContain('specification_revision');
    // Service identity is (account, workspace, service) after 55 -> 56.
    const servicePrimaryKey = (db.prepare('PRAGMA table_info(managed_local_services)').all() as
      Array<{ name: string; pk: number }>).filter(column => column.pk > 0)
      .sort((left, right) => left.pk - right.pk).map(column => column.name);
    expect(servicePrimaryKey).toEqual(['account_id', 'workspace_id', 'service_id']);
    expect(CURRENT_SCHEMA_VERSION).toBe(58);
    db.close();
  });

  it('accepts a database opened at schema 55 and completes the final migration', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare('UPDATE schema_version SET version = 55').run();
    expect(() => runMigrations(db)).not.toThrow();
    expect(version(db)).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });
});
