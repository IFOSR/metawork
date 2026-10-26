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

export interface MemoryRecallCandidate {
  memoryId: string;
  type: string;
  preview: string;
  score: number;
  createdAt: string;
}

export class MemoryRecallRepo {
  constructor(private readonly db: Database.Database, private readonly now: () => Date = () => new Date()) {}

  /** Replace the candidate set of one conversation. */
  replace(input: {
    accountId: string;
    conversationId: string;
    candidates: readonly { memoryId: string; type: string; preview: string; score: number }[];
  }): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM memory_recall_candidates WHERE account_id = ? AND conversation_id = ?')
        .run(input.accountId, input.conversationId);
      const insert = this.db.prepare(`
        INSERT INTO memory_recall_candidates
          (account_id, conversation_id, memory_id, type, preview, score, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, conversation_id, memory_id) DO UPDATE SET
          type = excluded.type, preview = excluded.preview, score = excluded.score
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
        );
      }
    }).immediate();
  }

  list(input: {
    accountId: string;
    conversationId: string;
    limit: number;
    query?: string;
  }): MemoryRecallCandidate[] {
    const rows = this.db.prepare(`
      SELECT memory_id, type, preview, score, created_at
      FROM memory_recall_candidates
      WHERE account_id = ? AND conversation_id = ?
      ORDER BY score DESC, created_at ASC
      LIMIT ?
    `).all(
      input.accountId,
      input.conversationId,
      Math.max(1, Math.min(50, input.limit)),
    ) as Array<{ memory_id: string; type: string; preview: string; score: number; created_at: string }>;
    const candidates = rows.map(row => ({
      memoryId: row.memory_id,
      type: row.type,
      preview: row.preview,
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
    this.db.prepare('DELETE FROM memory_recall_candidates WHERE account_id = ? AND conversation_id = ?')
      .run(accountId, conversationId);
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
