import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/storage/database.js';
import { createSchema30MigrationContext } from '../../src/storage/migrations.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('runtime database opening', () => {
  it('creates the database parent directory during first startup', () => {
    const root = mkdtempSync(join(tmpdir(), 'anyfusion-runtime-db-empty-'));
    cleanup.push(root);
    const databasePath = join(root, 'accounts', 'local-default', 'data', 'anyfusion.db');

    const db = createDatabase(databasePath);
    try {
      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 34 });
    } finally {
      db.close();
    }
  });

  it('refuses to migrate an active schema-30 database during ordinary startup', () => {
    const root = mkdtempSync(join(tmpdir(), 'anyfusion-runtime-db-'));
    cleanup.push(root);
    const databasePath = join(root, 'metaclaw.db');
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_version (version, applied_at)
      VALUES (30, '2026-08-14T00:00:00.000Z');
    `);
    legacy.close();

    expect(() => createDatabase(databasePath, createSchema30MigrationContext({
      revisionId: 'revision-test',
      contentHash: 'sha256:test',
      importedAt: '2026-08-14T00:00:00.000Z',
      plannerBinding: {
        agentClassRef: 'planner',
        harnessRef: 'anyfusion-planner',
        providerRef: 'provider',
        modelRef: 'model',
        permissionProfileRef: null,
        configurationRevision: 'revision-test',
        bindingFingerprint: 'planner-fingerprint',
      },
      legacyAgentClassBindings: {},
    }))).toThrow('runtime startup cannot migrate schema 30 in place');
  });
});
