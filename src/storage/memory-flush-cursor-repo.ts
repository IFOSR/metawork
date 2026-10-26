/**
 * Per-conversation memory deposition state.
 *
 * Design §5.2: the cursor advances only after the engine has accepted the
 * batch. TDAI's L0 layer has no idempotency key, so the write order must be
 * preserved: a crash between "engine accepted" and "cursor advanced" repeats
 * one batch, a crash in the other direction would lose it.
 *
 * The same row also records whether the last deposited segment contained
 * sanitized content, which is what marks a memory asset with
 * `source='sanitized'` (design §8.2).
 */

import type Database from 'better-sqlite3';

/** Upper bound on the turns inspected by one scheduler tick. */
const MAX_SCANNED_TURNS = 5_000;

/** Turns that are eligible for deposition; kept in one place for reuse. */
const COMPLETED_TURN_PREDICATE = `
  json_extract(body_json, '$.status') = 'completed'
  AND json_extract(body_json, '$.interactionKind') = 'ai_turn'
`;

export class MemoryFlushCursorRepo {
  constructor(private readonly db: Database.Database, private readonly now: () => Date = () => new Date()) {}

  /** Highest deposited sequence for a conversation; 0 when nothing was deposited. */
  lastSequence(accountId: string, conversationId: string): number {
    const row = this.db.prepare(`SELECT last_sequence FROM memory_flush_state
      WHERE account_id = ? AND conversation_id = ?`)
      .get(accountId, conversationId) as { last_sequence: number } | undefined;
    return row?.last_sequence ?? 0;
  }

  /** Whether the deposited segment of this conversation contained sanitized content. */
  isSanitized(accountId: string, conversationId: string): boolean {
    const row = this.db.prepare(`SELECT sanitized FROM memory_flush_state
      WHERE account_id = ? AND conversation_id = ?`)
      .get(accountId, conversationId) as { sanitized: number } | undefined;
    return (row?.sanitized ?? 0) === 1;
  }

  /**
   * Whether any deposited segment of this account contained sanitized content.
   *
   * The engine does not echo the originating L0 session on an L1 atom, so when a
   * recalled asset cannot be traced to one conversation this account-level fact
   * is the honest provenance: it never claims clean content when a redaction
   * happened somewhere in the account.
   */
  hasSanitizedSegments(accountId: string): boolean {
    const row = this.db.prepare(`SELECT 1 AS found FROM memory_flush_state
      WHERE account_id = ? AND sanitized = 1 LIMIT 1`)
      .get(accountId) as { found: number } | undefined;
    return row !== undefined;
  }

  /**
   * Advance the cursor. Never moves backwards: a repeated deposition of the
   * same batch must not rewind the stream.
   *
   * `sanitized` is sticky: once a segment needed redaction, later recalls of
   * this conversation keep the sanitized provenance.
   */
  advance(
    accountId: string,
    conversationId: string,
    sequence: number,
    sanitized = false,
    options: { deposition?: boolean } = {},
  ): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('invalid_memory_cursor');
    // Only a real deposition updates `updated_at`. Skipping refused or
    // ineligible turns moves the cursor but must not look like a successful
    // deposition to the two-hour fallback.
    const deposition = options.deposition ?? true;
    this.db.prepare(`INSERT INTO memory_flush_state
      (account_id, conversation_id, last_sequence, sanitized, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, conversation_id) DO UPDATE SET
        last_sequence = MAX(memory_flush_state.last_sequence, excluded.last_sequence),
        sanitized = MAX(memory_flush_state.sanitized, excluded.sanitized),
        updated_at = CASE WHEN ? = 1
          THEN excluded.updated_at
          ELSE memory_flush_state.updated_at
        END`)
      .run(accountId, conversationId, sequence, sanitized ? 1 : 0,
        deposition ? this.now().toISOString() : '', deposition ? 1 : 0);
  }

  /**
   * Conversations whose newest turn is older than the idle window **and** that
   * still have an undeposited turn (P2-1: the cursor comparison happens in SQL,
   * so an already-deposited conversation is never re-scanned).
   */
  listPendingCandidates(input: {
    accountId: string;
    limit: number;
    now: number;
    idleAfterMs: number;
  }): string[] {
    // The scan is bounded: only the most recent turns are inspected, so a long
    // history cannot turn one scheduler tick into a full table scan.
    const rows = this.db.prepare(`
      SELECT t.conversation_id AS conversation_id, MAX(t.first_sequence) AS newest_sequence
      FROM conversation_read_turns t
      WHERE t.account_id = ?
        AND t.first_sequence > COALESCE((
          SELECT s.last_sequence FROM memory_flush_state s
          WHERE s.account_id = t.account_id AND s.conversation_id = t.conversation_id
        ), 0)
      GROUP BY t.conversation_id
      ORDER BY newest_sequence DESC
      LIMIT ?
    `).all(input.accountId, MAX_SCANNED_TURNS) as Array<{
      conversation_id: string;
      newest_sequence: number;
    }>;
    const idleCutoff = input.now - input.idleAfterMs;
    const conversations: string[] = [];
    for (const row of rows) {
      const lastTurnAt = this.lastTurnTimestamp(input.accountId, row.conversation_id, row.newest_sequence);
      if (lastTurnAt === null) continue;
      if (lastTurnAt <= idleCutoff) conversations.push(row.conversation_id);
    }
    return conversations.slice(0, Math.max(1, Math.min(500, input.limit)));
  }

  /**
   * Conversations due for a forced flush.
   *
   * Design §5.3: the fallback is either the unflushed completed-turn threshold
   * or two hours since the last successful deposition, whichever comes first.
   * Only completed turns count, so a conversation full of failed or cancelled
   * rounds is never flushed on every tick.
   *
   * The reference time is `memory_flush_state.updated_at`; when a conversation
   * has no row yet it is the first still-pending completed turn.
   */
  listOverflowCandidates(input: {
    accountId: string;
    limit: number;
    minUnflushedTurns: number;
    now: number;
    fallbackAfterMs: number;
  }): string[] {
    const rows = this.db.prepare(`
      SELECT t.conversation_id AS conversation_id,
             COUNT(*) AS pending,
             MIN(COALESCE(json_extract(t.body_json, '$.completedAt'),
                          json_extract(t.body_json, '$.startedAt'))) AS first_pending_at,
             (SELECT s.updated_at FROM memory_flush_state s
              WHERE s.account_id = t.account_id AND s.conversation_id = t.conversation_id
             ) AS last_deposition_at
      FROM conversation_read_turns t
      WHERE t.account_id = ?
        AND t.first_sequence > COALESCE((
          SELECT s.last_sequence FROM memory_flush_state s
          WHERE s.account_id = t.account_id AND s.conversation_id = t.conversation_id
        ), 0)
        AND ${COMPLETED_TURN_PREDICATE}
      GROUP BY t.conversation_id
      ORDER BY pending DESC
      LIMIT ?
    `).all(input.accountId, Math.max(1, Math.min(500, input.limit))) as Array<{
      conversation_id: string;
      pending: number;
      first_pending_at: string | null;
      last_deposition_at: string | null;
    }>;
    const threshold = Math.max(1, input.minUnflushedTurns);
    return rows
      .filter(row => {
        if (row.pending >= threshold) return true;
        if (row.pending <= 0) return false;
        let reference = row.last_deposition_at
          ? Date.parse(row.last_deposition_at)
          : Number.NaN;
        if (Number.isNaN(reference)) reference = Date.parse(row.first_pending_at ?? '');
        if (Number.isNaN(reference)) return false;
        return input.now - reference >= input.fallbackAfterMs;
      })
      .map(row => row.conversation_id);
  }

  /**
   * Conversations with undeposited turns of any status. Used when a
   * conversation has nothing eligible left, so the cursor can skip past the
   * ineligible turns instead of scanning them forever (P1-6).
   */
  listConversationsWithUndepositedTurns(input: { accountId: string; limit: number }): string[] {
    const rows = this.db.prepare(`
      SELECT t.conversation_id AS conversation_id, MAX(t.first_sequence) AS newest_sequence
      FROM conversation_read_turns t
      WHERE t.account_id = ?
        AND t.first_sequence > COALESCE((
          SELECT s.last_sequence FROM memory_flush_state s
          WHERE s.account_id = t.account_id AND s.conversation_id = t.conversation_id
        ), 0)
      GROUP BY t.conversation_id
      ORDER BY newest_sequence DESC
      LIMIT ?
    `).all(input.accountId, Math.max(1, Math.min(500, input.limit))) as Array<{
      conversation_id: string;
      newest_sequence: number;
    }>;
    return rows.map(row => row.conversation_id);
  }

  /** Newest turn sequence of a conversation, including ineligible turns. */
  newestSequence(accountId: string, conversationId: string): number {
    const row = this.db.prepare(`
      SELECT MAX(first_sequence) AS newest_sequence FROM conversation_read_turns
      WHERE account_id = ? AND conversation_id = ?
    `).get(accountId, conversationId) as { newest_sequence: number | null } | undefined;
    return row?.newest_sequence ?? 0;
  }

  /** Timestamp of one turn, or null when it cannot be parsed. */
  private lastTurnTimestamp(accountId: string, conversationId: string, sequence: number): number | null {
    const row = this.db.prepare(`
      SELECT COALESCE(json_extract(body_json, '$.completedAt'),
                      json_extract(body_json, '$.startedAt')) AS last_turn_at
      FROM conversation_read_turns
      WHERE account_id = ? AND conversation_id = ? AND first_sequence = ?
      LIMIT 1
    `).get(accountId, conversationId, sequence) as { last_turn_at: string | null } | undefined;
    const stamp = Date.parse(row?.last_turn_at ?? '');
    return Number.isNaN(stamp) ? null : stamp;
  }

  /** True when the newest turn of the conversation is older than the idle window. */
  isIdle(input: {
    accountId: string;
    conversationId: string;
    now: number;
    idleAfterMs: number;
  }): boolean {
    const newest = this.newestSequence(input.accountId, input.conversationId);
    if (newest === 0) return true;
    const stamp = this.lastTurnTimestamp(input.accountId, input.conversationId, newest);
    if (stamp === null) return true;
    return stamp <= input.now - input.idleAfterMs;
  }
}
