import { SqliteConversationTurnStore } from './conversation-turn-repo.js';
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
 * A scheduling batch contains at most 50 Turns. The adapter then splits each
 * complete body into Unicode-safe chunks and sends at most 100 chunks per page.
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
/** TDAI `messages` is 1–100 items per `/v3/metawork/conversation/upsert` page. */
export const MEMORY_MAX_MESSAGES_PER_DEPOSIT = 100;
/** One turn becomes one user message plus one assistant message. */
export const MESSAGES_PER_TURN = 2;
/** Therefore one deposit carries at most this many turns. */
export const MEMORY_MAX_TURNS_PER_DEPOSIT = Math.floor(
  MEMORY_MAX_MESSAGES_PER_DEPOSIT / MESSAGES_PER_TURN,
);

export interface MemoryTurnSource {
  /** Unacknowledged authoritative versions, including late completions behind the cursor. */
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
    if (new SqliteConversationTurnStore(this.db).deletionState(input.accountId, input.conversationId)) return [];
    const limit = Math.max(1, Math.min(MEMORY_MAX_TURNS_PER_DEPOSIT, input.maxTurns));
    // The predicates mirror the in-memory checks below; keeping both means a
    // schema change cannot silently widen what is deposited.
    const rows = this.db.prepare(`
      SELECT turn_id, first_sequence, body_json
      FROM conversation_memory_turns
      WHERE account_id = ? AND conversation_id = ? AND deposited = 0
        AND json_extract(body_json, '$.status') = 'completed'
        AND json_extract(body_json, '$.interactionKind') = 'ai_turn'
      ORDER BY first_sequence ASC
      LIMIT ?
    `).all(
      input.accountId,
      input.conversationId,
      limit,
    ) as TurnRow[];
    const turns: MemoryTurnCandidate[] = [];
    for (const row of rows) {
      const view = parseTurn(row.body_json);
      if (!view) continue;
      if (view.status !== 'completed') continue;
      if (view.interactionKind !== 'ai_turn') continue;
      const store = new SqliteConversationTurnStore(this.db);
      const turn = store.find({ accountId: input.accountId, conversationId: input.conversationId, turnId: row.turn_id });
      if (!turn || !turn.answer) throw new Error('memory_turn_body_unavailable');
      const userInput = store.readBody(input.accountId, turn.input.hash).text;
      const answer = store.readBody(input.accountId, turn.answer.hash).text;
      // Empty versions must reach the sanitizer/receipt boundary as refusals;
      // silently skipping them here can starve all later turns behind LIMIT.
      turns.push({
        turnId: view.id,
        sequence: row.first_sequence,
        userInput,
        assistantAnswer: answer,
        inputHash: turn.input.hash,
        answerHash: turn.answer.hash,
        completedAt: view.completedAt ?? view.startedAt,
      });
    }
    return turns;
  }

  maxSequence(input: { accountId: string; conversationId: string }): number {
    const row = this.db.prepare(`
      SELECT MAX(first_sequence) AS max_sequence FROM conversation_memory_turns
      WHERE account_id = ? AND conversation_id = ?
    `).get(input.accountId, input.conversationId) as { max_sequence: number | null } | undefined;
    return row?.max_sequence ?? 0;
  }
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
