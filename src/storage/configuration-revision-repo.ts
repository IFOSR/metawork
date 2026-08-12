import type Database from 'better-sqlite3';

export interface ConfigurationRevisionRecord {
  revisionId: string;
  contentHash: string;
  sourceKind: 'native' | 'rollback' | 'schema-30-import';
  importedAt: string;
}

interface ConfigurationRevisionRow {
  revision_id: string;
  content_hash: string;
  source_kind: ConfigurationRevisionRecord['sourceKind'];
  imported_at: string;
}

export class ConfigurationRevisionRepo {
  constructor(private readonly db: Database.Database) {}

  ensure(record: ConfigurationRevisionRecord): ConfigurationRevisionRecord {
    this.db.prepare(`
      INSERT OR IGNORE INTO configuration_revisions (
        revision_id, content_hash, source_kind, imported_at
      ) VALUES (?, ?, ?, ?)
    `).run(
      record.revisionId,
      record.contentHash,
      record.sourceKind,
      record.importedAt,
    );
    const persisted = this.find(record.revisionId);
    if (
      !persisted
      || persisted.contentHash !== record.contentHash
      || persisted.sourceKind !== record.sourceKind
    ) {
      throw new Error(`configuration revision identity mismatch: ${record.revisionId}`);
    }
    return persisted;
  }

  find(revisionId: string): ConfigurationRevisionRecord | null {
    const row = this.db.prepare(`
      SELECT revision_id, content_hash, source_kind, imported_at
      FROM configuration_revisions
      WHERE revision_id = ?
    `).get(revisionId) as ConfigurationRevisionRow | undefined;
    return row ? {
      revisionId: row.revision_id,
      contentHash: row.content_hash,
      sourceKind: row.source_kind,
      importedAt: row.imported_at,
    } : null;
  }
}
