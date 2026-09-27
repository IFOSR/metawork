import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, runMigrations } from '../../src/storage/migrations.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function database() {
  const db = new Database(':memory:');
  databases.push(db);
  runMigrations(db);
  return db;
}

const tables = ['workspace_directory_rebuild_candidates', 'workspace_directory_observations'];

describe('Workspace directory rebuild bookkeeping migration', () => {
  it('creates account-scoped indexed bookkeeping without changing schema43 history triggers', () => {
    const db = database();
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: CURRENT_SCHEMA_VERSION });
    for (const table of tables) {
      expect(db.prepare(`PRAGMA table_info(${table})`).all(), table).not.toEqual([]);
      expect(db.prepare(`PRAGMA index_list(${table})`).all(), table).not.toEqual([]);
    }
    const historyTriggers = db.prepare(`
      SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'conversation_history_%'
      ORDER BY name
    `).all();
    expect(historyTriggers).toHaveLength(3);
    runMigrations(db);
    expect(db.prepare(`
      SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'conversation_history_%'
      ORDER BY name
    `).all()).toEqual(historyTriggers);
  });

  it('creates bookkeeping on the 42-to-43 upgrade and preserves existing directory facts', () => {
    const db = database();
    db.prepare(`INSERT INTO workspace_directory_revisions VALUES ('local-default', 'workspace_one', 12)`).run();
    for (const table of tables) db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.exec('UPDATE schema_version SET version = 42');

    runMigrations(db);

    for (const table of tables) expect(db.prepare(`PRAGMA table_info(${table})`).all(), table).not.toEqual([]);
    expect(db.prepare('SELECT revision FROM workspace_directory_revisions').get()).toEqual({ revision: 12 });
  });

  it('rolls back bookkeeping DDL with a failed version transition and can retry', () => {
    const db = database();
    for (const table of tables) db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.exec(`UPDATE schema_version SET version = 42;
      CREATE TEMP TRIGGER fail_directory_migration BEFORE UPDATE ON schema_version
      BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END`);

    expect(() => runMigrations(db)).toThrow('injected migration failure');
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 42 });
    for (const table of tables) expect(db.prepare(`PRAGMA table_info(${table})`).all()).toEqual([]);
    db.exec('DROP TRIGGER fail_directory_migration');
    runMigrations(db);
    for (const table of tables) expect(db.prepare(`PRAGMA table_info(${table})`).all(), table).not.toEqual([]);
  });
});
