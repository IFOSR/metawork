import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseUpgradeTransaction } from '../../src/installation/database-upgrade-transaction.js';
import { CURRENT_SCHEMA_VERSION, runMigrations } from '../../src/storage/migrations.js';

const databases: Database.Database[] = [];
const directories: string[] = [];
const admissionTables = ['gateway_command_admissions', 'gateway_command_admission_imports'];
const retryWakeTables = ['retry_wakes'];
const navigationTables = [
  'conversation_metadata_projection', 'gateway_journal_streams', 'gateway_journal_segments',
  'gateway_journal_event_index', 'gateway_turn_task_observations', 'conversation_history_streams',
  'conversation_history_turns', 'workspace_directory_projection', 'workspace_directory_revisions',
  'workspace_directory_rebuilds', 'workspace_directory_rebuild_candidates',
  'workspace_directory_observations', 'workspace_directory_dirty',
];
// Captured from the actual pre-change schema43 migration output, not from a live account.
const schema43Hash = '05a9135de1bf9d110b2fa76c07d90a0ad222066220c151725c84674ae48af911';

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('schema44 Gateway command admission migration', () => {
  it('creates the agreed account-scoped tables on a fresh database', () => {
    const db = open();
    runMigrations(db);
    expect(CURRENT_SCHEMA_VERSION).toBe(45);
    expect(version(db)).toBe(45);
    expect(db.prepare('PRAGMA table_info(gateway_command_admissions)').all()).toMatchObject([
      { name: 'account_id', type: 'TEXT', notnull: 1, pk: 1 },
      { name: 'idempotency_key', type: 'TEXT', notnull: 1, pk: 2 },
      { name: 'state', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'body_json', type: 'TEXT', notnull: 1, pk: 0 },
    ]);
    expect(db.prepare('PRAGMA table_info(gateway_command_admission_imports)').all())
      .toMatchObject([{ name: 'account_id', type: 'TEXT', pk: 1 }]);
  });

  it('rolls back all admission DDL with a failed 43-to-44 version transition and retries', () => {
    const db = schema43();
    const before = facts(db);
    db.exec(`CREATE TEMP TRIGGER fail_admission_migration BEFORE UPDATE ON schema_version
      WHEN OLD.version = 43 AND NEW.version = 44
      BEGIN SELECT RAISE(ABORT, 'injected schema44 failure'); END`);

    expect(() => runMigrations(db)).toThrow('injected schema44 failure');
    expect(version(db)).toBe(43);
    expect(schemaHash(db)).toBe(schema43Hash);
    expect(facts(db)).toEqual(before);
    for (const table of admissionTables) expect(tableExists(db, table)).toBe(false);

    db.exec('DROP TRIGGER fail_admission_migration');
    runMigrations(db);
    expect(version(db)).toBe(45);
    expect(facts(db)).toEqual(before);
  });

  it('preserves the separate 42-to-43 atomic boundary before applying schema44', () => {
    const db = schema42();
    const before = facts(db);
    db.exec(`CREATE TEMP TRIGGER fail_navigation_migration BEFORE UPDATE ON schema_version
      WHEN OLD.version = 42 AND NEW.version = 43
      BEGIN SELECT RAISE(ABORT, 'injected schema43 failure'); END`);
    expect(() => runMigrations(db)).toThrow('injected schema43 failure');
    expect(version(db)).toBe(42);
    for (const table of [...navigationTables, ...admissionTables]) {
      expect(tableExists(db, table), table).toBe(false);
    }
    expect(facts(db)).toEqual(before);
    db.exec('DROP TRIGGER fail_navigation_migration');
    runMigrations(db);
    expect(version(db)).toBe(45);
    for (const table of [...navigationTables, ...admissionTables]) {
      expect(tableExists(db, table), table).toBe(true);
    }
    expect(facts(db, Object.keys(before))).toEqual(before);
  });

  it('keeps a completed 42-to-43 migration when the subsequent 43-to-44 step fails', () => {
    const db = schema42();
    db.exec(`CREATE TEMP TRIGGER fail_admission_migration BEFORE UPDATE ON schema_version
      WHEN OLD.version = 43 AND NEW.version = 44
      BEGIN SELECT RAISE(ABORT, 'injected schema44 failure'); END`);
    expect(() => runMigrations(db)).toThrow('injected schema44 failure');
    expect(version(db)).toBe(43);
    expect(schemaHash(db)).toBe(schema43Hash);
    for (const table of admissionTables) expect(tableExists(db, table)).toBe(false);
    db.exec('DROP TRIGGER fail_admission_migration');
    runMigrations(db);
    expect(version(db)).toBe(45);
  });

  it('uses point and partial indexes without scanning unrelated terminal history', () => {
    const db = schema43();
    runMigrations(db);
    const insert = db.prepare('INSERT INTO gateway_command_admissions VALUES (?, ?, ?, ?)');
    db.transaction(() => {
      for (let i = 0; i < 2000; i++) insert.run('account_one', `old_${i}`, 'terminal', '{"receipt":"retained"}');
      insert.run('account_one', 'pending', 'pending', '{"createdAt":"2026-09-27T00:00:00Z"}');
      insert.run('account_two', 'pending', 'uncertain', '{"createdAt":"2026-09-27T00:00:01Z"}');
    })();
    const plan = (sql: string, ...params: string[]) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
        .map(row => row.detail).join('\n');
    expect(plan('SELECT body_json FROM gateway_command_admissions WHERE account_id = ? AND idempotency_key = ?',
      'account_one', 'pending')).toMatch(/SEARCH.*USING INDEX sqlite_autoindex_gateway_command_admissions/);
    expect(plan("SELECT body_json FROM gateway_command_admissions WHERE state != 'terminal'"))
      .toContain('USING INDEX gateway_command_admissions_recoverable');
    expect(plan("SELECT body_json FROM gateway_command_admissions WHERE account_id = ? AND state != 'terminal'",
      'account_one')).toContain('USING INDEX gateway_command_admissions_recoverable');
    expect(db.prepare("SELECT count(*) AS count FROM gateway_command_admissions WHERE state != 'terminal'").get())
      .toEqual({ count: 2 });
    expect(() => insert.run('account_one', 'pending', 'submitted', '{}')).toThrow('UNIQUE');
    db.prepare("UPDATE gateway_command_admissions SET state = 'terminal' WHERE account_id = 'account_one' AND idempotency_key = 'pending'").run();
    expect(db.prepare("SELECT count(*) AS count FROM gateway_command_admissions WHERE state != 'terminal'").get())
      .toEqual({ count: 1 });
  });

  it('preserves imported receipts and markers across current-schema reopen', () => {
    const root = temporaryDirectory();
    const path = join(root, 'current.db');
    let db = open(path);
    runMigrations(db);
    db.exec(`INSERT INTO gateway_command_admissions VALUES ('account_one', 'key_one', 'terminal', '{"receipt":"original"}');
      INSERT INTO gateway_command_admission_imports VALUES ('account_one')`);
    db.close();
    db = open(path);
    runMigrations(db);
    expect(db.prepare('SELECT * FROM gateway_command_admissions').all()).toEqual([{
      account_id: 'account_one', idempotency_key: 'key_one', state: 'terminal', body_json: '{"receipt":"original"}',
    }]);
    expect(db.prepare('SELECT * FROM gateway_command_admission_imports').all()).toEqual([{ account_id: 'account_one' }]);
  });

  it.each([false, true])('migrates a real schema43 installer clone without changing source/rollback facts (failure: %s)', async fail => {
    const root = temporaryDirectory();
    const sourcePath = join(root, 'source43.db');
    const backupPath = join(root, 'backup43.db');
    const clonePath = join(root, 'candidate45.db');
    const source = schema43(sourcePath);
    const before = facts(source);
    source.close();
    const sourceBytes = readFileSync(sourcePath);
    const upgrade = new DatabaseUpgradeTransaction({
      migrateClone: path => {
        const candidate = open(path);
        try {
          if (fail) candidate.exec(`CREATE TEMP TRIGGER fail_admission_migration BEFORE UPDATE ON schema_version
            WHEN OLD.version = 43 AND NEW.version = 44
            BEGIN SELECT RAISE(ABORT, 'injected schema44 failure'); END`);
          runMigrations(candidate);
        } finally { candidate.close(); }
      },
    });
    const result = upgrade.prepare({
      sourcePath, backupPath, clonePath, expectedSourceSchema: 43, expectedTargetSchema: 45,
      sentinelTables: ['tasks', ...navigationTables, ...admissionTables, ...retryWakeTables],
    });
    if (fail) {
      await expect(result).rejects.toThrow('injected schema44 failure');
      expect(existsSync(clonePath)).toBe(false);
    } else {
      await expect(result).resolves.toMatchObject({ sourceSchemaVersion: 43, candidateSchemaVersion: 45 });
      const candidate = open(clonePath);
      expect(facts(candidate)).toEqual(before);
      expect(candidate.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(candidate.pragma('foreign_key_check')).toEqual([]);
      for (const table of [...admissionTables, ...retryWakeTables]) {
        expect(tableExists(candidate, table)).toBe(true);
      }
    }
    expect(readFileSync(sourcePath)).toEqual(sourceBytes);
    for (const path of [sourcePath, backupPath]) {
      const preserved = open(path);
      expect(version(preserved)).toBe(43);
      expect(schemaHash(preserved)).toBe(schema43Hash);
      expect(facts(preserved)).toEqual(before);
      for (const table of admissionTables) expect(tableExists(preserved, table)).toBe(false);
    }
  });
});

function open(path = ':memory:'): Database.Database {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  databases.push(db);
  return db;
}

function schema43(path?: string): Database.Database {
  const db = open(path);
  runMigrations(db);
  for (const table of [...admissionTables, ...retryWakeTables]) {
    db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  db.exec('UPDATE schema_version SET version = 43');
  expect(schemaHash(db)).toBe(schema43Hash);
  db.exec(`
    INSERT INTO tasks (id, title, status, created_at, updated_at)
      VALUES ('task_done', 'Retained task', 'done', '2026-09-26', '2026-09-26');
    INSERT INTO conversation_metadata_projection VALUES ('account_one', 'conv_one', '{"title":"retained"}');
    INSERT INTO gateway_journal_streams VALUES ('account_one', 'conv_one', 7, '{"lastSequence":7}', 2);
    INSERT INTO gateway_journal_segments VALUES ('account_one', 'conv_one', 'segment_one', 3, 7, 128);
    INSERT INTO gateway_journal_event_index VALUES ('account_one', 'conv_one', 'event_one', 7, 'segment_one');
    INSERT INTO gateway_turn_task_observations VALUES ('account_one', 'conv_one', 'turn_one', '{"taskIds":["task_done"]}');
    INSERT INTO conversation_history_streams VALUES ('account_one', 'conv_one', 'turn', 1, 'revision');
    INSERT INTO conversation_history_turns VALUES ('account_one', 'conv_one', 'turn', 1, 'turn_one', '{"answer":"retained"}', 21);
    INSERT INTO workspace_directory_revisions VALUES ('account_one', 'workspace_one', 9);
    INSERT INTO workspace_directory_rebuilds VALUES ('account_one', 1, 'building', 'source', '{"after":"conv_one"}');
    INSERT INTO workspace_directory_rebuild_candidates VALUES ('account_one', 'rebuild_one', 'conv_one');
    INSERT INTO workspace_directory_observations VALUES ('account_one', 'conv_one', 'rebuild_one', 0);
  `);
  return db;
}

function schema42(): Database.Database {
  const db = schema43();
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'directory_dirty_%'")
    .all() as { name: string }[];
  for (const { name } of triggers) db.exec(`DROP TRIGGER "${name}"`);
  for (const table of navigationTables) db.exec(`DROP TABLE ${table}`);
  db.exec('UPDATE schema_version SET version = 42');
  return db;
}

function schemaHash(db: Database.Database): string {
  const objects = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();
  return createHash('sha256').update(JSON.stringify(objects)).digest('hex');
}

function facts(db: Database.Database, tables?: string[]): Record<string, string[]> {
  const names = tables ?? (db.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[])
    .map(row => row.name).filter(name => (
      name !== 'schema_version'
      && !admissionTables.includes(name)
      && !retryWakeTables.includes(name)
    ));
  return Object.fromEntries(names.map(name => [
    name, db.prepare(`SELECT * FROM "${name}"`).all().map(row => JSON.stringify(row)).sort(),
  ]));
}

function version(db: Database.Database): number {
  return (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
}

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'metawork-schema44-'));
  directories.push(root);
  return root;
}
