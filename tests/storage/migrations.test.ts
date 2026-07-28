import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';

describe('current SQLite baseline', () => {
  it('creates only the current pre-release schema on a fresh database', () => {
    const db = new Database(':memory:');

    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();

    expect(db.prepare('SELECT version FROM schema_version').all())
      .toEqual([{ version: 27 }]);
    for (const table of [
      'tasks',
      'subtasks',
      'work_graph_revisions',
      'kernel_events',
      'kernel_decisions',
      'kernel_decision_applications',
      'kernel_effect_outbox',
      'kernel_dispatch_items',
      'executor_attempt_receipts',
      'resource_leases',
      'resource_waits',
      'workspace_records',
      'workspace_publications',
      'workspace_merge_attempts',
      'generation_replan_requests',
    ]) {
      expect(db.prepare(`PRAGMA table_info(${table})`).all(), table).not.toEqual([]);
    }
    for (const removed of [
      'planning_decisions_legacy_audit',
      'subtasks_v2_audit',
      'subtasks_v3_audit',
      'worktree_leases_legacy_audit',
      'executor_profiles',
    ]) {
      expect(db.prepare(`PRAGMA table_info(${removed})`).all(), removed).toEqual([]);
    }
    expect((db.prepare('PRAGMA table_info(work_graph_revisions)').all() as Array<{ name: string }>)
      .map(column => column.name)).toContain('completion_kind');
    expect((db.prepare('PRAGMA table_info(resource_leases)').all() as Array<{ name: string }>)
      .map(column => column.name)).toEqual(expect.arrayContaining([
      'revocation_requested_at',
      'revocation_reason',
    ]));
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rejects an old database instead of carrying a pre-release upgrade path', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (26);
    `);

    expect(() => runMigrations(db)).toThrow(
      'unsupported pre-release SQLite schema (26); create a fresh database for schema 27',
    );
    expect(db.prepare('SELECT version FROM schema_version').all())
      .toEqual([{ version: 26 }]);
  });

  it('rejects a non-empty pre-release database that has no schema marker', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE legacy_marker (id TEXT PRIMARY KEY)');

    expect(() => runMigrations(db)).toThrow(
      'unsupported pre-release SQLite database without schema_version',
    );
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all()).toEqual([{ name: 'legacy_marker' }]);
  });
});
