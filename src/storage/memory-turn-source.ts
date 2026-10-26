/**
 * Source of conversation turns eligible for long-term memory.
 *
 * Design §5.2: the write unit is a Turn (`userInput` + `finalAnswer`) and only
 * `status='completed'` turns are eligible (D13). Failed, cancelled and blocked
 * rounds are never deposited, so a failure does not become durable experience.
 *
 * Eligibility is decided **in SQL**. Filtering after `LIMIT` would let a run of
 * ineligible turns hide every later eligible turn behind the page boundary and
 * starve the conversation permanently (review P1-6).
 *
 * The engine accepts at most 100 messages per deposit and each turn becomes two
 * messages, so the batch is bounded by **messages**, not turns (review P1-4).
 */

import type Database from 'better-sqlite3';
import type { ConversationTurnView } from '../session/conversation-read-types.js';
import type { MemoryTurnCandidate } from '../memory/memory-types.js';

interface TurnRow {
  turn_id: string;
  first_sequence: number;
  body_json: string;
}

/** TDAI `messages[].content` is 1–8192 characters. */
export const MEMORY_MAX_MESSAGE_CHARS = 8_192;
/** TDAI `messages` is 1–100 items per `/v3/conversation/add`. */
export const MEMORY_MAX_MESSAGES_PER_DEPOSIT = 100;
/** One turn becomes one user message plus one assistant message. */
export const MESSAGES_PER_TURN = 2;
/** Therefore one deposit carries at most this many turns. */
export const MEMORY_MAX_TURNS_PER_DEPOSIT = Math.floor(
  MEMORY_MAX_MESSAGES_PER_DEPOSIT / MESSAGES_PER_TURN,
);

export interface MemoryTurnSource {
  /** Eligible turns of one conversation after the cursor, in order. */
  completedTurnsAfter(input: {
    accountId: string;
    conversationId: string;
    afterSequence: number;
    /** Maximum turns to return; capped by the message budget. */
    maxTurns: number;
  }): MemoryTurnCandidate[];
  /** Highest turn sequence of one conversation, or 0. */
  maxSequence(input: { accountId: string; conversationId: string }): number;
}

export class SqliteMemoryTurnSource implements MemoryTurnSource {
  constructor(private readonly db: Database.Database) {}

  completedTurnsAfter(input: {
    accountId: string;
    conversationId: string;
    afterSequence: number;
    maxTurns: number;
  }): MemoryTurnCandidate[] {
    const limit = Math.max(1, Math.min(MEMORY_MAX_TURNS_PER_DEPOSIT, input.maxTurns));
    // The predicates mirror the in-memory checks below; keeping both means a
    // schema change cannot silently widen what is deposited.
    const rows = this.db.prepare(`
      SELECT turn_id, first_sequence, body_json
      FROM conversation_read_turns
      WHERE account_id = ? AND conversation_id = ? AND first_sequence > ?
        AND json_extract(body_json, '$.status') = 'completed'
        AND json_extract(body_json, '$.interactionKind') = 'ai_turn'
      ORDER BY first_sequence ASC
      LIMIT ?
    `).all(
      input.accountId,
      input.conversationId,
      input.afterSequence,
      limit,
    ) as TurnRow[];
    const turns: MemoryTurnCandidate[] = [];
    for (const row of rows) {
      const view = parseTurn(row.body_json);
      if (!view) continue;
      if (view.status !== 'completed') continue;
      if (view.interactionKind !== 'ai_turn') continue;
      const userInput = truncateMessage(view.userInput.trim());
      const answer = truncateMessage(view.answer.trim());
      if (!userInput || !answer) continue;
      turns.push({
        turnId: view.id,
        sequence: row.first_sequence,
        userInput,
        assistantAnswer: answer,
        completedAt: view.completedAt ?? view.startedAt,
      });
    }
    return turns;
  }

  maxSequence(input: { accountId: string; conversationId: string }): number {
    const row = this.db.prepare(`
      SELECT MAX(first_sequence) AS max_sequence FROM conversation_read_turns
      WHERE account_id = ? AND conversation_id = ?
    `).get(input.accountId, input.conversationId) as { max_sequence: number | null } | undefined;
    return row?.max_sequence ?? 0;
  }
}

/**
 * Bound one message to the engine's per-message limit. A long final answer must
 * not fail the whole batch, which would stall the conversation forever.
 */
export function truncateMessage(value: string): string {
  if (value.length <= MEMORY_MAX_MESSAGE_CHARS) return value;
  const marker = '…[truncated]';
  return `${value.slice(0, MEMORY_MAX_MESSAGE_CHARS - marker.length)}${marker}`;
}

function parseTurn(bodyJson: string): ConversationTurnView | null {
  try {
    const parsed = JSON.parse(bodyJson) as Partial<ConversationTurnView>;
    if (typeof parsed.id !== 'string') return null;
    return parsed as ConversationTurnView;
  } catch {
    return null;
  }
}
