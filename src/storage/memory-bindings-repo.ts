/**
 * Local index of memory assets (design §4.2).
 *
 * The engine owns the bodies; this table owns ownership, the user switch and a
 * content digest. It never stores memory content, so the engine can be dropped
 * and rebuilt without losing the user's "disable this one" decisions.
 */

import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { MemoryAssetSource, MemoryAssetSummary } from '../memory/memory-types.js';

export interface MemoryBindingRecord {
  memoryId: string;
  tdaiMemoryId: string;
  accountId: string;
  workspaceId: string | null;
  source: MemoryAssetSource;
  enabled: boolean;
  confidence: number | null;
  contentDigest: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryBindingInput {
  memoryId?: string;
  tdaiMemoryId: string;
  accountId: string;
  workspaceId?: string | null;
  source?: MemoryAssetSource;
  enabled?: boolean;
  confidence?: number | null;
  content?: string | null;
}

interface BindingRow {
  memory_id: string;
  tdai_memory_id: string;
  account_id: string;
  workspace_id: string | null;
  source: string;
  enabled: number;
  confidence: number | null;
  content_digest: string | null;
  created_at: string;
  updated_at: string;
}

/** Stable digest of a memory body. The body itself is never persisted. */
export function memoryContentDigest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export class MemoryBindingsRepo {
  constructor(private readonly db: Database.Database, private readonly now: () => Date = () => new Date()) {}

  upsert(input: MemoryBindingInput): MemoryBindingRecord {
    const timestamp = this.now().toISOString();
    // The engine id is unique: binding the same asset twice must reuse the
    // existing local id instead of colliding with the unique index.
    const existing = this.findByTdaiMemoryId(input.tdaiMemoryId, input.accountId);
    const memoryId = input.memoryId ?? existing?.memoryId ?? `mem_${randomUUID().replace(/-/gu, '')}`;
    const digest = input.content ? memoryContentDigest(input.content) : null;
    // The user's switch is a governance decision: a re-bind must not silently
    // re-enable an asset the user disabled.
    const enabled = input.enabled ?? existing?.enabled ?? true;
    this.db.prepare(`
      INSERT INTO memory_bindings
        (memory_id, tdai_memory_id, account_id, workspace_id, source, enabled, confidence, content_digest, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET
        tdai_memory_id = excluded.tdai_memory_id,
        account_id = excluded.account_id,
        workspace_id = excluded.workspace_id,
        source = excluded.source,
        enabled = excluded.enabled,
        confidence = excluded.confidence,
        content_digest = COALESCE(excluded.content_digest, memory_bindings.content_digest),
        updated_at = excluded.updated_at
    `).run(
      memoryId,
      input.tdaiMemoryId,
      input.accountId,
      input.workspaceId ?? null,
      input.source ?? 'conversation',
      enabled ? 1 : 0,
      input.confidence ?? null,
      digest,
      timestamp,
      timestamp,
    );
    return this.findByMemoryId(memoryId, input.accountId)!;
  }

  findByMemoryId(memoryId: string, accountId: string): MemoryBindingRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM memory_bindings WHERE memory_id = ? AND account_id = ?',
    ).get(memoryId, accountId) as BindingRow | undefined;
    return row ? toRecord(row) : null;
  }

  findByTdaiMemoryId(tdaiMemoryId: string, accountId: string): MemoryBindingRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM memory_bindings WHERE tdai_memory_id = ? AND account_id = ?',
    ).get(tdaiMemoryId, accountId) as BindingRow | undefined;
    return row ? toRecord(row) : null;
  }

  /**
   * Resolve one memory for execution. Returns null when the asset is unknown,
   * belongs to another account, or the user disabled it.
   */
  findEnabledForAccount(memoryId: string, accountId: string): MemoryBindingRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM memory_bindings WHERE memory_id = ? AND account_id = ? AND enabled = 1',
    ).get(memoryId, accountId) as BindingRow | undefined;
    return row ? toRecord(row) : null;
  }

  listByAccount(input: {
    accountId: string;
    limit: number;
    offset: number;
    includeDisabled: boolean;
  }): { items: MemoryBindingRecord[]; total: number } {
    const where = input.includeDisabled
      ? 'account_id = ?'
      : 'account_id = ? AND enabled = 1';
    const total = (this.db.prepare(
      `SELECT COUNT(*) AS total FROM memory_bindings WHERE ${where}`,
    ).get(input.accountId) as { total: number }).total;
    const rows = this.db.prepare(
      `SELECT * FROM memory_bindings WHERE ${where}
       ORDER BY created_at DESC, memory_id ASC LIMIT ? OFFSET ?`,
    ).all(input.accountId, Math.max(1, Math.min(100, input.limit)), Math.max(0, input.offset)) as BindingRow[];
    return { items: rows.map(toRecord), total };
  }

  setEnabled(memoryId: string, accountId: string, enabled: boolean): MemoryBindingRecord | null {
    const changed = this.db.prepare(
      'UPDATE memory_bindings SET enabled = ?, updated_at = ? WHERE memory_id = ? AND account_id = ?',
    ).run(enabled ? 1 : 0, this.now().toISOString(), memoryId, accountId);
    if (changed.changes === 0) return null;
    return this.findByMemoryId(memoryId, accountId);
  }

  delete(memoryId: string, accountId: string): boolean {
    const changed = this.db.prepare(
      'DELETE FROM memory_bindings WHERE memory_id = ? AND account_id = ?',
    ).run(memoryId, accountId);
    return changed.changes > 0;
  }

  /** Remove every binding of an account. Used when the account is deleted. */
  deleteByAccount(accountId: string): number {
    return this.db.prepare('DELETE FROM memory_bindings WHERE account_id = ?')
      .run(accountId).changes;
  }

  toSummaries(records: readonly MemoryBindingRecord[]): MemoryAssetSummary[] {
    return records.map(record => ({
      memoryId: record.memoryId,
      tdaiMemoryId: record.tdaiMemoryId,
      type: 'atomic',
      digest: record.contentDigest ?? '',
      source: record.source,
      workspaceId: record.workspaceId,
      enabled: record.enabled,
      confidence: record.confidence,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }));
  }
}

function toRecord(row: BindingRow): MemoryBindingRecord {
  return {
    memoryId: row.memory_id,
    tdaiMemoryId: row.tdai_memory_id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    source: row.source === 'sanitized' ? 'sanitized' : 'conversation',
    enabled: row.enabled === 1,
    confidence: row.confidence,
    contentDigest: row.content_digest,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
