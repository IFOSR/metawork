import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { ConversationHistorySearch } from '../session/conversation-history-search.js';
import type { ConversationReadModel, ConversationTurnView } from '../session/conversation-read-model.js';

export const CONVERSATION_SEARCH_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS conversation_content_search USING fts5(
  account_id UNINDEXED, conversation_id UNINDEXED, hash UNINDEXED, text,
  byte_offset UNINDEXED, tokenize = 'trigram'
);
CREATE TABLE IF NOT EXISTS conversation_content_search_queue (
  account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, hash TEXT NOT NULL,
  byte_offset INTEGER NOT NULL DEFAULT 0, prefix TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(account_id, conversation_id, hash)
);
CREATE TABLE IF NOT EXISTS conversation_content_search_chunks (
  account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, hash TEXT NOT NULL,
  byte_offset INTEGER NOT NULL, search_rowid INTEGER NOT NULL,
  PRIMARY KEY(account_id, conversation_id, hash, byte_offset)
);
`;

/** Background indexing reads at most one 32 KiB range per maintenance tick. */
export class SqliteConversationHistorySearch implements ConversationHistorySearch {
  constructor(private readonly db: Database.Database, private readonly model: ConversationReadModel) {}

  maintain(accountId: string, conversationId: string): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT hash, byte_offset, prefix FROM conversation_content_search_queue
        WHERE account_id = ? AND conversation_id = ? ORDER BY rowid LIMIT 1`)
        .get(accountId, conversationId) as { hash: string; byte_offset: number; prefix: string } | undefined;
      if (!row) return false;
      const part = this.model.content(accountId, conversationId, row.hash, row.byte_offset, 32768);
      if (part?.text) {
        const result = this.db.prepare(`INSERT INTO conversation_content_search(account_id, conversation_id, hash, text, byte_offset)
          VALUES (?, ?, ?, ?, ?)`).run(accountId, conversationId, row.hash, row.prefix + part.text, row.byte_offset - Buffer.byteLength(row.prefix));
        this.db.prepare(`INSERT INTO conversation_content_search_chunks VALUES (?, ?, ?, ?, ?)`)
          .run(accountId, conversationId, row.hash, row.byte_offset, result.lastInsertRowid);
      }
      if (!part || part.nextOffset >= part.byteLength) this.db.prepare(`DELETE FROM conversation_content_search_queue
        WHERE account_id = ? AND conversation_id = ? AND hash = ?`).run(accountId, conversationId, row.hash);
      else {
        // Search accepts at most 128 code points. Overlap protects matches spanning ranges.
        const prefix = [...row.prefix + part.text].slice(-128).join('');
        this.db.prepare(`UPDATE conversation_content_search_queue SET byte_offset = ?, prefix = ?
          WHERE account_id = ? AND conversation_id = ? AND hash = ?`).run(part.nextOffset, prefix, accountId, conversationId, row.hash);
      }
      return true;
    }).immediate();
  }

  search(accountId: string, conversationId: string, query: string, cursor?: string) {
    const text = query.trim();
    if ([...text].length < 3 || [...text].length > 128) throw new Error('search_requires_3_to_128_characters');
    let after = 0; let afterTurn = '';
    if (cursor) {
      try {
        if (cursor.length > 2048) throw new Error();
        const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(value) || value.length !== 5 || value[0] !== accountId || value[1] !== conversationId
          || value[2] !== text || !Number.isSafeInteger(value[3]) || value[3] < 0 || typeof value[4] !== 'string') throw new Error();
        after = value[3]; afterTurn = value[4];
      } catch { throw new Error('invalid_search_cursor'); }
    }
    const marker = `\u0001${randomUUID()}\u0002`;
    const rows = this.db.prepare(`SELECT search.rowid, search.hash, search.byte_offset,
        highlight(conversation_content_search, 3, ?, '') AS matched,
        turn.turn_id, turn.body_json,
        snippet(conversation_content_search, 3, '', '', ' … ', 32) AS excerpt
      FROM conversation_content_search search JOIN conversation_read_heads head
        ON head.account_id = search.account_id AND head.conversation_id = search.conversation_id
      JOIN conversation_read_turns turn ON turn.account_id = head.account_id AND turn.conversation_id = head.conversation_id
        AND turn.epoch = head.epoch AND (json_extract(turn.body_json, '$.answerRef.hash') = search.hash
          OR json_extract(turn.body_json, '$.userInputRef.hash') = search.hash)
      WHERE conversation_content_search MATCH ? AND search.account_id = ? AND search.conversation_id = ?
        AND (search.rowid, turn.turn_id) > (?, ?)
      ORDER BY search.rowid, turn.turn_id LIMIT 21`)
      .all(marker, `"${text.replaceAll('"', '""')}"`, accountId, conversationId, after, afterTurn) as
      Array<{ rowid: number; hash: string; byte_offset: number; matched: string; turn_id: string; body_json: string; excerpt: string }>;
    const page = rows.slice(0, 20);
    const last = page.at(-1);
    return {
      hits: page.map(row => {
        const turn = JSON.parse(row.body_json) as ConversationTurnView;
        // FTS's Unicode folding differs from SQLite lower(). Its highlight
        // positions refer to original text, preserving exact UTF-8 navigation.
        const position = row.matched.indexOf(marker);
        const offset = row.byte_offset + Buffer.byteLength(row.matched.slice(0, Math.max(0, position)));
        return { turnId: row.turn_id, excerpt: row.excerpt.slice(0, 512), offset,
          content: (turn.answerRef?.hash === row.hash ? turn.answerRef : turn.userInputRef)! };
      }),
      nextCursor: rows.length > 20 && last ? Buffer.from(JSON.stringify([accountId, conversationId, text, last.rowid, last.turn_id])).toString('base64url') : null,
      preparing: Boolean(this.db.prepare(`SELECT 1 FROM conversation_content_search_queue
        WHERE account_id = ? AND conversation_id = ? LIMIT 1`).get(accountId, conversationId)),
    };
  }
}
