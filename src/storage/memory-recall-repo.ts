/**
 * Planner-facing memory read model.
 *
 * The Planner process tree may not hold engine credentials and may not talk to
 * the memory engine directly (design §6.2 and §6.4). The Planner reads durable
 * facts from the account database instead, exactly as it already reads
 * preferences, tasks and interactions.
 *
 * The Server performs the engine search and projects a bounded preview here.
 * The full memory body never lands in the MetaWork authoritative database: it
 * exists in the engine, and reaches an Executor only as materialized evidence.
 */

import type Database from 'better-sqlite3';
import type { LayeredMemoryRecall, MemoryLayer, MemoryLayerStatus, MemoryRecallItem } from '../memory/memory-types.js';

export interface MemoryRecallCandidate {
  memoryId: string;
  type: string;
  layer: MemoryLayer;
  title: string;
  preview: string;
  revision: string;
  source: string;
  score: number;
  createdAt: string;
}

export class MemoryRecallRepo {
  constructor(private readonly db: Database.Database, private readonly now: () => Date = () => new Date()) {}

  hasCandidate(input: {
    accountId: string;
    conversationId: string;
    memoryId: string;
    revision: string;
  }): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM memory_recall_candidates
      WHERE account_id = ? AND conversation_id = ? AND memory_id = ? AND revision = ?
    `).get(input.accountId, input.conversationId, input.memoryId, input.revision);
    return Boolean(row);
  }

  /** Replace the candidate set of one conversation. */
  replace(input: {
    accountId: string;
    conversationId: string;
    candidates: readonly { memoryId: string; type: string; preview: string; score: number; revision?: string; title?: string; layer?: MemoryLayer; source?: string }[];
  }): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM memory_recall_candidates WHERE account_id = ? AND conversation_id = ?')
        .run(input.accountId, input.conversationId);
      const insert = this.db.prepare(`
        INSERT INTO memory_recall_candidates
          (account_id, conversation_id, memory_id, type, preview, score, created_at, layer, revision, title, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, conversation_id, memory_id) DO UPDATE SET
          type = excluded.type, preview = excluded.preview, score = excluded.score,
          layer = excluded.layer, revision = excluded.revision, title = excluded.title, source = excluded.source
      `);
      const createdAt = this.now().toISOString();
      for (const candidate of input.candidates) {
        insert.run(
          input.accountId,
          input.conversationId,
          candidate.memoryId,
          candidate.type,
          candidate.preview,
          candidate.score,
          createdAt,
          candidate.layer ?? 'l1',
          candidate.revision ?? '',
          candidate.title ?? '',
          candidate.source ?? 'conversation',
        );
      }
    }).immediate();
  }

  list(input: {
    accountId: string;
    conversationId: string;
    limit: number;
    query?: string;
    layer?: MemoryLayer;
  }): MemoryRecallCandidate[] {
    const rows = this.db.prepare(`
      SELECT memory_id, type, layer, title, preview, revision, source, score, created_at
      FROM memory_recall_candidates
      WHERE account_id = ? AND conversation_id = ?
      ${input.layer ? 'AND layer = ?' : ''}
      ORDER BY score DESC, created_at ASC
      LIMIT ?
    `).all(
      input.accountId,
      input.conversationId,
      ...(input.layer ? [input.layer] : []),
      Math.max(1, Math.min(50, input.limit)),
    ) as Array<{ memory_id: string; type: string; layer: MemoryLayer; title: string; preview: string; revision: string; source: string; score: number; created_at: string }>;
    const candidates = rows.map(row => ({
      memoryId: row.memory_id,
      type: row.type,
      layer: row.layer,
      title: row.title,
      preview: row.preview,
      revision: row.revision,
      source: row.source,
      score: row.score,
      createdAt: row.created_at,
    }));
    const query = input.query?.trim().toLowerCase();
    if (!query) return candidates;
    return candidates.filter(candidate =>
      candidate.preview.toLowerCase().includes(query)
      || candidate.type.toLowerCase().includes(query));
  }

  clear(accountId: string, conversationId: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM memory_recall_candidates WHERE account_id = ? AND conversation_id = ?')
        .run(accountId, conversationId);
      this.db.prepare('DELETE FROM memory_recall_layers WHERE account_id = ? AND conversation_id = ?')
        .run(accountId, conversationId);
    })();
  }

  replaceLayered(input: {
    accountId: string;
    conversationId: string;
    recall: LayeredMemoryRecall;
  }): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM memory_recall_candidates WHERE account_id = ? AND conversation_id = ?')
        .run(input.accountId, input.conversationId);
      this.db.prepare('DELETE FROM memory_recall_layers WHERE account_id = ? AND conversation_id = ?')
        .run(input.accountId, input.conversationId);
      const timestamp = this.now().toISOString();
      const insertCandidate = this.db.prepare(`
        INSERT INTO memory_recall_candidates
          (account_id, conversation_id, memory_id, type, preview, score, created_at, layer, revision, title, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertLayer = this.db.prepare(`
        INSERT INTO memory_recall_layers
          (account_id, conversation_id, layer, status, reason, duration_ms, candidate_count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const layer of ['l1', 'l2', 'l3'] as const) {
        const result = input.recall[layer];
        insertLayer.run(
          input.accountId, input.conversationId, layer, result.status, result.reason ?? null,
          Math.max(0, Math.round(result.durationMs ?? 0)), result.candidateCount ?? result.items.length, timestamp,
        );
        for (const item of result.items) {
          insertCandidate.run(input.accountId, input.conversationId, item.memoryId,
            item.layer === 'l1' ? item.title || 'atomic' : item.layer,
            item.preview, item.score, timestamp, item.layer, item.revision, item.title, item.source);
        }
      }
    }).immediate();
  }

  readLayered(input: { accountId: string; conversationId: string; limit: number }): LayeredMemoryRecall {
    const rows = this.db.prepare(`
      SELECT c.memory_id, c.layer, c.title, c.preview, c.revision, c.source, c.score, c.created_at
      FROM memory_recall_candidates c
      INNER JOIN memory_bindings b ON b.memory_id = c.memory_id AND b.account_id = c.account_id
      WHERE c.account_id = ? AND c.conversation_id = ? AND b.enabled = 1
      ORDER BY CASE c.layer WHEN 'l1' THEN 1 WHEN 'l2' THEN 2 ELSE 3 END, c.score DESC, c.created_at ASC
      LIMIT ?
    `).all(input.accountId, input.conversationId, Math.max(1, Math.min(20, input.limit))) as Array<Record<string, unknown>>;
    const states = this.db.prepare(`SELECT layer, status, reason, duration_ms, candidate_count FROM memory_recall_layers
      WHERE account_id = ? AND conversation_id = ?`).all(input.accountId, input.conversationId) as Array<Record<string, unknown>>;
    const result = {} as LayeredMemoryRecall;
    for (const layer of ['l1', 'l2', 'l3'] as const) {
      const status = states.find(row => row.layer === layer);
      const items: MemoryRecallItem[] = rows.filter(row => row.layer === layer).map(row => ({
        memoryId: String(row.memory_id), layer,
        title: String(row.title ?? ''), preview: String(row.preview ?? ''), revision: String(row.revision ?? ''),
        score: Number(row.score ?? 0), updatedAt: String(row.created_at ?? ''),
        source: row.source === 'profile' ? 'profile' : row.source === 'sanitized' ? 'sanitized' : 'conversation',
      }));
      result[layer] = {
        status: (status?.status as MemoryLayerStatus | undefined) ?? (items.length ? 'available' : 'empty'),
        ...(status?.reason ? { reason: String(status.reason) } : {}),
        ...(status ? { durationMs: Number(status.duration_ms ?? 0), candidateCount: Number(status.candidate_count ?? items.length) } : {}),
        items,
      };
    }
    return result;
  }

  /**
   * Record whether the last recall for this conversation was served by a
   * healthy engine, so that the Planner can distinguish "no matching memory"
   * from "the memory engine is unavailable" (design §6.1, §6.6).
   */
  recordDegraded(input: {
    accountId: string;
    conversationId: string;
    degraded: boolean;
    reason?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO memory_recall_state (account_id, conversation_id, degraded, reason, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, conversation_id) DO UPDATE SET
        degraded = excluded.degraded, reason = excluded.reason, updated_at = excluded.updated_at
    `).run(
      input.accountId,
      input.conversationId,
      input.degraded ? 1 : 0,
      input.reason ?? null,
      this.now().toISOString(),
    );
  }

  /** Whether the last recall degraded; unknown conversations are not degraded. */
  readDegraded(input: { accountId: string; conversationId: string }): { degraded: boolean; reason: string | null } {
    const row = this.db.prepare(`SELECT degraded, reason FROM memory_recall_state
      WHERE account_id = ? AND conversation_id = ?`)
      .get(input.accountId, input.conversationId) as { degraded: number; reason: string | null } | undefined;
    return { degraded: (row?.degraded ?? 0) === 1, reason: row?.reason ?? null };
  }
}
