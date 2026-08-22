import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import {
  ensureActiveConfigurationRevision,
} from '../../src/storage/active-configuration-revision.js';

describe('ensureActiveConfigurationRevision', () => {
  it('registers the active revision before foreign-keyed Kernel writes', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    ensureActiveConfigurationRevision(db, {
      revisionId: 'revision-active',
      contentHash: 'hash-active',
    });

    expect(db.prepare(`
      SELECT revision_id, content_hash, source_kind
      FROM configuration_revisions
      WHERE revision_id = ?
    `).get('revision-active')).toEqual({
      revision_id: 'revision-active',
      content_hash: 'hash-active',
      source_kind: 'native',
    });
    db.close();
  });

  it('preserves an imported identity when the active revision already exists', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(`
      INSERT INTO configuration_revisions (
        revision_id, content_hash, source_kind, imported_at
      ) VALUES (?, ?, 'schema-30-import', ?)
    `).run('revision-imported', 'hash-imported', '2026-08-20T00:00:00.000Z');

    ensureActiveConfigurationRevision(db, {
      revisionId: 'revision-imported',
      contentHash: 'hash-imported',
    });

    expect(db.prepare(`
      SELECT source_kind FROM configuration_revisions WHERE revision_id = ?
    `).get('revision-imported')).toEqual({ source_kind: 'schema-30-import' });
    db.close();
  });
});
