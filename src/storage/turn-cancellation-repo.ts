import type Database from 'better-sqlite3';
import type { TurnCancellationStore } from '../session/turn-cancellation-store.js';
import { CONVERSATION_TURN_CANCELLATION_SCHEMA_SQL } from './conversation-turn-schema.js';

/** Bound to the authenticated Account; presentation epochs cannot erase this fact. */
export class SqliteTurnCancellationStore implements TurnCancellationStore {
  constructor(private readonly db: Database.Database, private readonly accountId: string) {
    if (!accountId) throw new Error('turn_cancellation_account_missing');
    db.exec(CONVERSATION_TURN_CANCELLATION_SCHEMA_SQL);
  }

  request(conversationId: string, turnId: string, occurredAt: string): void {
    if (!conversationId || !turnId || !Number.isFinite(Date.parse(occurredAt))) {
      throw new Error('invalid_turn_cancellation');
    }
    this.db.prepare(`INSERT OR IGNORE INTO conversation_turn_cancellations
      (account_id, conversation_id, turn_id, requested_at) VALUES (?, ?, ?, ?)`)
      .run(this.accountId, conversationId, turnId, occurredAt);
  }

  isRequested(conversationId: string, turnId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM conversation_turn_cancellations
      WHERE account_id = ? AND conversation_id = ? AND turn_id = ?`)
      .get(this.accountId, conversationId, turnId));
  }
}
