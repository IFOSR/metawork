import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  ConfigurationRevisionRepo,
  type ConfigurationRevisionRecord,
} from '../../src/storage/configuration-revision-repo.js';

const revision: ConfigurationRevisionRecord = {
  revisionId: 'revision_31',
  contentHash: 'sha256:configuration',
  sourceKind: 'native',
  importedAt: '2026-08-12T00:00:00.000Z',
};

describe('ConfigurationRevisionRepo', () => {
  it('ensures the same revision idempotently without replacing persisted identity', () => {
    const repo = new ConfigurationRevisionRepo(createDb());

    expect(repo.ensure(revision)).toEqual(revision);
    expect(repo.ensure({
      ...revision,
      importedAt: '2026-08-12T01:00:00.000Z',
    })).toEqual(revision);
    expect(repo.find(revision.revisionId)).toEqual(revision);
  });

  it.each([
    ['content hash', { contentHash: 'sha256:different' }],
    ['source kind', { sourceKind: 'rollback' as const }],
  ])('rejects a matching revision id with a different %s', (_, difference) => {
    const repo = new ConfigurationRevisionRepo(createDb());
    repo.ensure(revision);

    expect(() => repo.ensure({ ...revision, ...difference }))
      .toThrow(`configuration revision identity mismatch: ${revision.revisionId}`);
    expect(repo.find(revision.revisionId)).toEqual(revision);
  });
});

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE configuration_revisions (
      revision_id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK(
        source_kind IN ('native', 'rollback', 'schema-30-import')
      ),
      imported_at TEXT NOT NULL
    );
  `);
  return db;
}
