import type Database from 'better-sqlite3';
import type {
  ConversationHistoryPage, ConversationHistoryRequest, ConversationHistoryStore,
} from '../session/conversation-history-store.js';

/** Stable insertion sequences: enriching a Turn must not move it across pages. */
export class SqliteConversationHistoryRepo<T extends { readonly id: string }>
implements ConversationHistoryStore<T> {
  constructor(
    private readonly db: Database.Database,
    private readonly accountId: string,
    private readonly kind: string,
    private readonly onWrite?: (conversationId: string, turn: T, sequence: number) => void,
  ) {}

  version(conversationId: string): string | null {
    const row = this.db.prepare(`SELECT revision FROM conversation_history_streams
      WHERE account_id = ? AND conversation_id = ? AND kind = ?`)
      .get(this.accountId, conversationId, this.kind) as { revision: string } | undefined;
    return row?.revision ?? null;
  }

  isImported(conversationId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM conversation_history_streams
      WHERE account_id = ? AND conversation_id = ? AND kind = ?`)
      .get(this.accountId, conversationId, this.kind));
  }

  importOnce(conversationId: string, turns: readonly T[]): void {
    this.db.transaction(() => {
      if (this.isImported(conversationId)) return;
      this.db.prepare(`INSERT INTO conversation_history_streams
        (account_id, conversation_id, kind, last_sequence) VALUES (?, ?, ?, 0)`)
        .run(this.accountId, conversationId, this.kind);
      for (const turn of turns) this.write(conversationId, turn);
    }).immediate();
  }

  upsert(conversationId: string, turn: T): void {
    this.db.transaction(() => {
      if (!this.isImported(conversationId)) throw new Error('history_not_imported');
      this.write(conversationId, turn);
    }).immediate();
  }

  replace(conversationId: string, turns: readonly T[]): void {
    this.db.transaction(() => {
      this.importOnce(conversationId, []);
      const wanted = new Set(turns.map(turn => turn.id));
      const rows = this.db.prepare(`SELECT turn_id FROM conversation_history_turns
        WHERE account_id = ? AND conversation_id = ? AND kind = ?`)
        .all(this.accountId, conversationId, this.kind) as { turn_id: string }[];
      const remove = this.db.prepare(`DELETE FROM conversation_history_turns
        WHERE account_id = ? AND conversation_id = ? AND kind = ? AND turn_id = ?`);
      for (const row of rows) if (!wanted.has(row.turn_id)) {
        remove.run(this.accountId, conversationId, this.kind, row.turn_id);
      }
      for (const turn of turns) this.write(conversationId, turn);
    }).immediate();
  }

  delete(conversationId: string): boolean {
    return this.db.transaction(() => {
      this.db.prepare(`DELETE FROM conversation_history_turns WHERE account_id = ? AND conversation_id = ? AND kind = ?`)
        .run(this.accountId, conversationId, this.kind);
      return this.db.prepare(`DELETE FROM conversation_history_streams WHERE account_id = ? AND conversation_id = ? AND kind = ?`)
        .run(this.accountId, conversationId, this.kind).changes > 0;
    }).immediate();
  }

  private write(conversationId: string, turn: T): void {
    const body = JSON.stringify(turn);
    const bytes = Buffer.byteLength(body);
    const existing = this.db.prepare(`UPDATE conversation_history_turns SET body_json = ?, byte_length = ?
      WHERE account_id = ? AND conversation_id = ? AND kind = ? AND turn_id = ?`)
      .run(body, bytes, this.accountId, conversationId, this.kind, turn.id);
    if (existing.changes) {
      const row = this.db.prepare(`SELECT sequence FROM conversation_history_turns
        WHERE account_id = ? AND conversation_id = ? AND kind = ? AND turn_id = ?`)
        .get(this.accountId, conversationId, this.kind, turn.id) as { sequence: number };
      this.onWrite?.(conversationId, turn, row.sequence);
      return;
    }
    const { last_sequence: sequence } = this.db.prepare(`UPDATE conversation_history_streams
      SET last_sequence = last_sequence + 1
      WHERE account_id = ? AND conversation_id = ? AND kind = ?
      RETURNING last_sequence`).get(this.accountId, conversationId, this.kind) as { last_sequence: number };
    this.db.prepare(`INSERT INTO conversation_history_turns
      (account_id, conversation_id, kind, sequence, turn_id, body_json, byte_length) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(this.accountId, conversationId, this.kind, sequence, turn.id, body, bytes);
    this.onWrite?.(conversationId, turn, sequence);
  }

  find(conversationId: string, turnId: string): T | null {
    const row = this.db.prepare(`SELECT body_json FROM conversation_history_turns
      WHERE account_id = ? AND conversation_id = ? AND kind = ? AND turn_id = ?`)
      .get(this.accountId, conversationId, this.kind, turnId) as { body_json: string } | undefined;
    return row ? JSON.parse(row.body_json) as T : null;
  }

  findMany(conversationId: string, turnIds: readonly string[]): ReadonlyMap<string, T> {
    if (!turnIds.length) return new Map();
    if (turnIds.length > 100) throw new Error('history_lookup_limit');
    const rows = this.db.prepare(`SELECT turn_id, body_json FROM conversation_history_turns
      WHERE account_id = ? AND conversation_id = ? AND kind = ?
      AND turn_id IN (${turnIds.map(() => '?').join(',')})`)
      .all(this.accountId, conversationId, this.kind, ...turnIds) as { turn_id: string; body_json: string }[];
    return new Map(rows.map(row => [row.turn_id, JSON.parse(row.body_json) as T]));
  }

  page(conversationId: string, request: ConversationHistoryRequest): ConversationHistoryPage<T> {
    const requestedLimit = request.limit ?? 10;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) throw new Error('invalid_history_limit');
    const limit = Math.min(requestedLimit, 50);
    const maxBytes = request.maxBytes ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('invalid_history_byte_limit');
    const before = request.cursor ? this.decodeCursor(conversationId, request.cursor) : Number.MAX_SAFE_INTEGER;
    const rows = this.db.prepare(`SELECT sequence, byte_length FROM conversation_history_turns
      WHERE account_id = ? AND conversation_id = ? AND kind = ? AND sequence < ?
      ORDER BY sequence DESC LIMIT ?`)
      .all(this.accountId, conversationId, this.kind, before, limit + 1) as { sequence: number; byte_length: number }[];
    let count = 0;
    let bytes = 2;
    for (const row of rows.slice(0, limit)) {
      if (count && bytes + row.byte_length + 1 > maxBytes) break;
      bytes += row.byte_length + (count ? 1 : 0);
      count += 1;
    }
    if (!count) return { turns: [], nextCursor: null };
    const oldest = rows[count - 1]!.sequence;
    const selected = this.db.prepare(`SELECT body_json FROM conversation_history_turns
      WHERE account_id = ? AND conversation_id = ? AND kind = ? AND sequence >= ? AND sequence < ?
      ORDER BY sequence ASC`).all(this.accountId, conversationId, this.kind, oldest, before) as { body_json: string }[];
    const nextCursor = rows.length > count
      ? Buffer.from(JSON.stringify([1, this.accountId, conversationId, this.kind, oldest])).toString('base64url')
      : null;
    return { turns: selected.map(row => JSON.parse(row.body_json) as T), nextCursor };
  }

  private decodeCursor(conversationId: string, cursor: string): number {
    try {
      if (cursor.length > 2_048) throw new Error();
      const parts: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (!Array.isArray(parts) || parts.length !== 5
        || parts[0] !== 1 || parts[1] !== this.accountId || parts[2] !== conversationId || parts[3] !== this.kind
        || !Number.isSafeInteger(parts[4]) || parts[4] < 1) throw new Error();
      return parts[4] as number;
    } catch {
      throw new Error('invalid_history_cursor');
    }
  }
}
