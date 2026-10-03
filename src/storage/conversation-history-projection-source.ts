import type Database from 'better-sqlite3';
import type { ConversationTurn } from '../session/conversation-store.js';
import type { ConversationHistoryProjectionSource } from '../session/conversation-history-projection-source.js';

export class SqliteConversationHistoryProjectionSource implements ConversationHistoryProjectionSource {
  constructor(private readonly db: Database.Database) {}

  /** Prime only the recent window before sequential backfill; never advance its checkpoint. */
  primeRecent(accountId: string, conversationId: string, project: (turn: ConversationTurn, sequence: number) => void): boolean {
    return this.db.transaction(() => {
      const recent = this.db.prepare(`SELECT turn_id, sequence FROM conversation_history_turns
        WHERE account_id = ? AND conversation_id = ? AND kind = 'conversation'
        ORDER BY sequence DESC LIMIT 20`).all(accountId, conversationId) as Array<{ turn_id: string; sequence: number }>;
      const present = this.db.prepare(`SELECT 1 FROM conversation_read_turns WHERE account_id = ? AND conversation_id = ?
        AND epoch = (SELECT epoch FROM conversation_read_heads WHERE account_id = ? AND conversation_id = ?) AND turn_id = ?`);
      const next = recent.find(row => !present.get(accountId, conversationId, accountId, conversationId, row.turn_id));
      if (!next) return false;
      const source = this.db.prepare(`SELECT body_json FROM conversation_history_turns
        WHERE account_id = ? AND conversation_id = ? AND kind = 'conversation' AND turn_id = ?`)
        .get(accountId, conversationId, next.turn_id) as { body_json: string };
      project(JSON.parse(source.body_json) as ConversationTurn, next.sequence);
      return true;
    }).immediate();
  }

  drainDirty(accountId: string, conversationId: string,
    upsert: (turn: ConversationTurn, sequence: number) => void, remove: (turnId: string) => void): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT dirty.turn_id, dirty.version, source.sequence, source.body_json
        FROM conversation_read_history_dirty dirty LEFT JOIN conversation_history_turns source
        ON source.account_id = dirty.account_id AND source.conversation_id = dirty.conversation_id
          AND source.kind = 'conversation' AND source.turn_id = dirty.turn_id
        WHERE dirty.account_id = ? AND dirty.conversation_id = ? ORDER BY dirty.rowid LIMIT 1`)
        .get(accountId, conversationId) as { turn_id: string; version: number; sequence: number | null; body_json: string | null } | undefined;
      if (!row) return false;
      if (row.body_json !== null) upsert(JSON.parse(row.body_json) as ConversationTurn, row.sequence!);
      else remove(row.turn_id);
      this.db.prepare(`DELETE FROM conversation_read_history_dirty WHERE account_id = ? AND conversation_id = ? AND turn_id = ? AND version = ?`)
        .run(accountId, conversationId, row.turn_id, row.version);
      return true;
    }).immediate();
  }

  hasPending(accountId: string, conversationId: string): boolean {
    if (this.db.prepare('SELECT 1 FROM conversation_read_history_dirty WHERE account_id = ? AND conversation_id = ? LIMIT 1')
      .get(accountId, conversationId)) return true;
    return Boolean(this.db.prepare(`SELECT 1 FROM conversation_history_turns
      WHERE account_id = ? AND conversation_id = ? AND kind = 'conversation'
      AND sequence > COALESCE((SELECT sequence FROM conversation_read_history_checkpoint
        WHERE account_id = ? AND conversation_id = ?), 0) LIMIT 1`)
      .get(accountId, conversationId, accountId, conversationId));
  }

  next(accountId: string, conversationId: string) {
    const row = this.db.prepare(`SELECT sequence, body_json FROM conversation_history_turns
      WHERE account_id = ? AND conversation_id = ? AND kind = 'conversation'
      AND sequence > COALESCE((SELECT sequence FROM conversation_read_history_checkpoint
        WHERE account_id = ? AND conversation_id = ?), 0)
      ORDER BY sequence LIMIT 1`).get(accountId, conversationId, accountId, conversationId) as
      { sequence: number; body_json: string } | undefined;
    return row ? { sequence: row.sequence, turn: JSON.parse(row.body_json) as ConversationTurn } : null;
  }

  commit(accountId: string, conversationId: string, sequence: number, project: () => void): void {
    this.db.transaction(() => {
      project();
      this.db.prepare(`INSERT INTO conversation_read_history_checkpoint (account_id, conversation_id, sequence)
        VALUES (?, ?, ?) ON CONFLICT(account_id, conversation_id) DO UPDATE SET sequence = MAX(sequence, excluded.sequence)`)
        .run(accountId, conversationId, sequence);
    }).immediate();
  }
}
