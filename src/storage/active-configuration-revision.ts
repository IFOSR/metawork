import type Database from 'better-sqlite3';
import { ConfigurationRevisionRepo } from './configuration-revision-repo.js';

export interface ActiveConfigurationRevision {
  readonly revisionId: string;
  readonly contentHash: string;
}

/**
 * Make the active immutable configuration revision visible to SQLite before
 * writing any revision-pinned Kernel or Planner facts.
 */
export function ensureActiveConfigurationRevision(
  db: Database.Database,
  active: ActiveConfigurationRevision,
): void {
  const repo = new ConfigurationRevisionRepo(db);
  const existing = repo.find(active.revisionId);
  repo.ensure({
    revisionId: active.revisionId,
    contentHash: active.contentHash,
    sourceKind: existing?.sourceKind ?? 'native',
    importedAt: existing?.importedAt ?? new Date().toISOString(),
  });
}
