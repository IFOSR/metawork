import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { recordNavigationRead } from '../utils/navigation-diagnostics.js';
import { CONVERSATION_PROJECTOR_VERSION } from '../session/conversation-read-rebuild.js';
import {
  CONVERSATION_BASELINE_BYTES,
  type ConversationReadHead, type ConversationReadModel, type ConversationTurnPage,
  type ConversationContentReference,
  type ConversationTurnView, type ConversationViewChange, type ConversationViewCursor,
} from '../session/conversation-read-model.js';

const TAIL_BYTES = 4 * 1024 * 1024;
const ACCOUNT_TAIL_BYTES = 128 * 1024 * 1024;
const MAX_TURN_BYTES = 16 * 1024;

/** Transactional derivative of durable facts. Never owns execution or authorization. */
export class SqliteConversationReadModel implements ConversationReadModel {
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now,
    private readonly onTurnCommitted?: (accountId: string, turn: ConversationTurnView) => void,
    private readonly staging?: { accountId: string; conversationId: string; epoch: string }) {}

  private headTable(): string { return this.staging ? 'conversation_read_rebuilds' : 'conversation_read_heads'; }

  serverIdentity(): string {
    return (this.db.prepare('SELECT id FROM conversation_observation_identity WHERE singleton = 1').get() as { id: string }).id;
  }

  isRemoved(accountId: string, conversationId: string, turnId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM conversation_read_tombstones WHERE account_id = ? AND conversation_id = ? AND turn_id = ?`)
      .get(accountId, conversationId, turnId));
  }

  remove(accountId: string, conversationId: string, turnId: string): void {
    this.db.transaction(() => {
      const previous = this.findTurn(accountId, conversationId, turnId);
      if (!previous) return;
      const head = this.head(accountId, conversationId)!;
      const revision = head.revision + 1;
      const tombstone = { ...previous, revision, userInput: '', userInputRef: null, answer: '', answerRef: null };
      const body = JSON.stringify({ removed: true, turn: tombstone });
      this.db.prepare('DELETE FROM conversation_read_turns WHERE account_id = ? AND conversation_id = ? AND epoch = ? AND turn_id = ?')
        .run(accountId, conversationId, head.epoch, turnId);
      this.db.prepare(`INSERT INTO conversation_read_changes(account_id, conversation_id, epoch, revision, body_json, byte_length, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(accountId, conversationId, head.epoch, revision, body, Buffer.byteLength(body), this.now());
      this.db.prepare(`UPDATE ${this.headTable()} SET revision = ? WHERE account_id = ? AND conversation_id = ?`)
        .run(revision, accountId, conversationId);
    }).immediate();
  }

  private assertScope(accountId: string, conversationId: string): void {
    if (this.staging && (accountId !== this.staging.accountId || conversationId !== this.staging.conversationId)) {
      throw new Error('observation_scope_mismatch');
    }
  }

  putContent(accountId: string, conversationId: string, value: string) {
    const bytes = Buffer.from(value);
    const hash = createHash('sha256').update(bytes).digest('hex');
    this.db.prepare(`INSERT INTO conversation_read_bodies
      (account_id, conversation_id, hash, body, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, conversation_id, hash) DO UPDATE SET created_at = excluded.created_at
      WHERE created_at < excluded.created_at - 3600000`).run(accountId, conversationId, hash, bytes, this.now());
    return { hash, byteLength: bytes.length };
  }

  putContentChunk(accountId: string, conversationId: string, reference: ConversationContentReference, offset: number, text: string): void {
    const body = Buffer.from(text);
    if (!/^[a-f0-9]{64}$/.test(reference.hash) || !Number.isSafeInteger(reference.byteLength) || reference.byteLength < 0
      || !Number.isSafeInteger(offset) || offset < 0 || offset + body.length > reference.byteLength) {
      throw new Error('invalid_content_chunk');
    }
    if (this.content(accountId, conversationId, reference.hash, 0, 4)) return;
    this.db.prepare(`INSERT OR IGNORE INTO conversation_read_content_chunks
      (account_id, conversation_id, hash, byte_offset, body) VALUES (?, ?, ?, ?, ?)`)
      .run(accountId, conversationId, reference.hash, offset, body);
  }

  verifyContent(accountId: string, conversationId: string, reference: ConversationContentReference): boolean {
    if (this.content(accountId, conversationId, reference.hash, 0, 4)?.byteLength === reference.byteLength) return true;
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT byte_offset, body FROM conversation_read_content_chunks
        WHERE account_id = ? AND conversation_id = ? AND hash = ? ORDER BY byte_offset`)
        .iterate(accountId, conversationId, reference.hash);
      const hash = createHash('sha256');
      let offset = 0;
      for (const value of rows) {
        const row = value as { byte_offset: number; body: Buffer };
        if (row.byte_offset !== offset) return false;
        hash.update(row.body); offset += row.body.length;
      }
      if (offset !== reference.byteLength || hash.digest('hex') !== reference.hash) return false;
      this.db.prepare(`INSERT OR IGNORE INTO conversation_read_content_manifests
        (account_id, conversation_id, hash, byte_length) VALUES (?, ?, ?, ?)`)
        .run(accountId, conversationId, reference.hash, reference.byteLength);
      return true;
    }).immediate();
  }

  baseline(accountId: string, conversationId: string) {
    return this.db.transaction(() => ({
      head: this.head(accountId, conversationId),
      ...this.page(accountId, conversationId, { maxBytes: CONVERSATION_BASELINE_BYTES - 1024 }),
    })).deferred();
  }

  head(accountId: string, conversationId: string): ConversationReadHead | null {
    this.assertScope(accountId, conversationId);
    const row = this.db.prepare(`SELECT epoch, revision, journal_sequence FROM ${this.headTable()}
      WHERE account_id = ? AND conversation_id = ?`).get(accountId, conversationId) as
      { epoch: string; revision: number; journal_sequence: number } | undefined;
    if (this.staging && row?.epoch !== this.staging.epoch) throw new Error('observation_stale_rebuild');
    return row ? { epoch: row.epoch, revision: row.revision, journalSequence: row.journal_sequence } : null;
  }

  findTurn(accountId: string, conversationId: string, turnId: string): ConversationTurnView | null {
    const row = this.db.prepare(`SELECT body_json FROM conversation_read_turns
      WHERE account_id = ? AND conversation_id = ? AND epoch = ? AND turn_id = ?`).get(accountId, conversationId, this.head(accountId, conversationId)?.epoch ?? '', turnId) as
      { body_json: string } | undefined;
    recordNavigationRead('conversation_turn_read', row ? Buffer.byteLength(row.body_json) : 0, row ? 1 : 0);
    return row ? JSON.parse(row.body_json) as ConversationTurnView : null;
  }

  page(accountId: string, conversationId: string, request: {
    cursor?: string; beforeTurnId?: string; limit?: number; maxBytes?: number; activeOnly?: boolean;
  } = {}): ConversationTurnPage {
    const limit = Math.min(request.limit ?? 20, 50);
    const maxBytes = Math.min(request.maxBytes ?? CONVERSATION_BASELINE_BYTES, CONVERSATION_BASELINE_BYTES);
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < MAX_TURN_BYTES) {
      throw new Error('invalid_observation_page_budget');
    }
    return this.db.transaction(() => {
      const epoch = this.head(accountId, conversationId)?.epoch ?? '';
      let boundary: readonly [number, string] = [Number.MAX_SAFE_INTEGER, '\uffff'];
      if (request.beforeTurnId) {
        const anchor = this.findTurn(accountId, conversationId, request.beforeTurnId);
        if (!anchor) throw new Error('observation_anchor_unavailable');
        boundary = [anchor.firstSequence, anchor.id];
      }
      if (request.cursor) {
        try {
          if (request.cursor.length > 2_048) throw new Error();
          const parts: unknown = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8'));
          if (!Array.isArray(parts) || parts.length !== 7 || parts[0] !== 1 || parts[1] !== accountId
            || parts[2] !== conversationId || parts[3] !== epoch || parts[4] !== Boolean(request.activeOnly)
            || !Number.isSafeInteger(parts[5]) || typeof parts[6] !== 'string') throw new Error();
          boundary = [parts[5], parts[6]];
        } catch { throw new Error('invalid_observation_cursor'); }
      }
      const rows = this.db.prepare(`SELECT turn_id, first_sequence, byte_length FROM conversation_read_turns
        WHERE account_id = ? AND conversation_id = ? AND epoch = ? ${request.activeOnly ? 'AND active = 1' : ''}
          AND (first_sequence, turn_id) < (?, ?)
        ORDER BY first_sequence DESC, turn_id DESC LIMIT ?`)
        .all(accountId, conversationId, epoch, ...boundary, limit + 1) as
        Array<{ turn_id: string; first_sequence: number; byte_length: number }>;
      let bytes = 512; // Leave room for page metadata and cursor.
      const turns: ConversationTurnView[] = [];
      for (const row of rows.slice(0, limit)) {
        if (bytes + row.byte_length + 1 > maxBytes) break;
        turns.push(this.findTurn(accountId, conversationId, row.turn_id)!);
        bytes += row.byte_length + 1;
      }
      const last = rows[turns.length - 1];
      if (!last && rows.length) throw new Error('observation_page_budget_too_small');
      return {
        asOf: this.head(accountId, conversationId) ?? undefined,
        turns: turns.reverse(),
        nextCursor: rows.length > turns.length && last ? Buffer.from(JSON.stringify([
          1, accountId, conversationId, epoch, Boolean(request.activeOnly), last.first_sequence, last.turn_id,
        ])).toString('base64url') : null,
      };
    }).deferred();
  }

  findTaskTurn(accountId: string, conversationId: string, taskId: string): ConversationTurnView | null {
    const rows = this.db.prepare(`SELECT body_json FROM conversation_read_turns
      WHERE account_id = ? AND conversation_id = ? AND epoch = ? AND json_extract(body_json, '$.taskId') = ? LIMIT 2`)
      .all(accountId, conversationId, this.head(accountId, conversationId)?.epoch ?? '', taskId) as Array<{ body_json: string }>;
    return rows.length === 1 ? JSON.parse(rows[0]!.body_json) as ConversationTurnView : null;
  }

  changes(accountId: string, conversationId: string, cursor: ConversationViewCursor) {
    return this.db.transaction(() => {
      const head = this.head(accountId, conversationId);
      const reset = { reset: true, head, changes: [] as ConversationViewChange[] };
      if (!head || head.epoch !== cursor.epoch || !Number.isSafeInteger(cursor.revision)
        || cursor.revision < 0 || cursor.revision > head.revision) return reset;
      const rows = this.db.prepare(`SELECT revision, body_json, byte_length FROM conversation_read_changes
        WHERE account_id = ? AND conversation_id = ? AND epoch = ? AND revision > ? ORDER BY revision LIMIT 65`)
        .all(accountId, conversationId, head.epoch, cursor.revision) as
        Array<{ revision: number; body_json: string; byte_length: number }>;
      let expected = cursor.revision + 1;
      let bytes = 1024;
      const changes: ConversationViewChange[] = [];
      for (const row of rows) {
        if (row.revision !== expected++) return reset;
        if (bytes + row.byte_length + 256 > CONVERSATION_BASELINE_BYTES || changes.length === 64) break;
        bytes += row.byte_length + 256;
        const value = JSON.parse(row.body_json) as ConversationTurnView | { removed: true; turn: ConversationTurnView };
        changes.push({ epoch: head.epoch, prevRevision: row.revision - 1, revision: row.revision,
          ...('removed' in value ? value : { turn: value }) });
      }
      if (!changes.length && head.revision !== cursor.revision) return reset;
      return { reset: false, head, changes };
    }).deferred();
  }

  commit(accountId: string, conversationId: string, turns: readonly ConversationTurnView[], journalSequence: number,
    bodies: readonly { hash: string; value: string }[] = []): void {
    this.db.transaction(() => {
      if (!this.staging) this.db.prepare(`INSERT OR IGNORE INTO conversation_read_heads
        (account_id, conversation_id, epoch, projector_version) VALUES (?, ?, ?, ?)`).run(accountId, conversationId, randomUUID(), CONVERSATION_PROJECTOR_VERSION);
      const head = this.head(accountId, conversationId)!;
      if (journalSequence < head.journalSequence) throw new Error('observation_checkpoint_regression');
      for (const body of bodies) {
        const bytes = Buffer.from(body.value);
        if (createHash('sha256').update(bytes).digest('hex') !== body.hash) throw new Error('observation_content_hash_mismatch');
        this.db.prepare(`INSERT OR IGNORE INTO conversation_read_bodies
          (account_id, conversation_id, hash, body) VALUES (?, ?, ?, ?)`).run(accountId, conversationId, body.hash, bytes);
      }
      let revision = head.revision;
      for (const value of turns) {
        if (value.conversationId !== conversationId) throw new Error('observation_scope_mismatch');
        const turn = { ...value, revision: ++revision };
        const json = JSON.stringify(turn);
        const bytes = Buffer.byteLength(json);
        if (bytes > MAX_TURN_BYTES) throw new Error('observation_turn_budget_exceeded');
        this.db.prepare(`INSERT INTO conversation_read_turns
          (account_id, conversation_id, epoch, turn_id, first_sequence, revision, active, body_json, byte_length)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, conversation_id, epoch, turn_id)
          DO UPDATE SET revision = excluded.revision, active = excluded.active,
            body_json = excluded.body_json, byte_length = excluded.byte_length`)
          .run(accountId, conversationId, head.epoch, turn.id, turn.firstSequence, revision,
            ['running', 'blocked'].includes(turn.status) ? 1 : 0, json, bytes);
        this.db.prepare(`INSERT INTO conversation_read_changes
          (account_id, conversation_id, epoch, revision, body_json, byte_length, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(accountId, conversationId, head.epoch, revision, json, bytes, this.now());
        if (!this.staging) this.onTurnCommitted?.(accountId, turn);
      }
      this.db.prepare(`UPDATE ${this.headTable()} SET revision = ?, journal_sequence = ?
        WHERE account_id = ? AND conversation_id = ?`).run(revision, journalSequence, accountId, conversationId);
      this.trimTail(accountId, conversationId, head.epoch);
    }).immediate();
  }

  content(accountId: string, conversationId: string, hash: string, offset: number, maxBytes: number) {
    if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(offset) || offset < 0
      || !Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > 64 * 1024) throw new Error('invalid_content_range');
    let row = this.db.prepare(`SELECT length(body) AS byte_length, substr(body, ?, ?) AS chunk
      FROM conversation_read_bodies WHERE account_id = ? AND conversation_id = ? AND hash = ?`)
      .get(offset + 1, maxBytes + 1, accountId, conversationId, hash) as
      { byte_length: number; chunk: Buffer } | undefined;
    if (!row) {
      const manifest = this.db.prepare(`SELECT byte_length FROM conversation_read_content_manifests
        WHERE account_id = ? AND conversation_id = ? AND hash = ?`).get(accountId, conversationId, hash) as
        { byte_length: number } | undefined;
      if (!manifest) return null;
      const part = this.db.prepare(`SELECT byte_offset, substr(body, ? - byte_offset + 1, ?) AS chunk
        FROM conversation_read_content_chunks WHERE account_id = ? AND conversation_id = ? AND hash = ?
        AND byte_offset <= ? ORDER BY byte_offset DESC LIMIT 1`)
        .get(offset, maxBytes + 1, accountId, conversationId, hash, offset) as { byte_offset: number; chunk: Buffer } | undefined;
      row = { byte_length: manifest.byte_length, chunk: part?.chunk ?? Buffer.alloc(0) };
    }
    recordNavigationRead('conversation_content_read', row.chunk.length);
    if (offset > row.byte_length || (row.chunk.length && (row.chunk[0]! & 0xc0) === 0x80)) throw new Error('invalid_content_offset');
    let end = Math.min(row.chunk.length, maxBytes);
    while (end > 0 && end < row.chunk.length && (row.chunk[end]! & 0xc0) === 0x80) end--;
    return { text: row.chunk.subarray(0, end).toString('utf8'), offset, nextOffset: offset + end, byteLength: row.byte_length };
  }

  private trimTail(accountId: string, conversationId: string, epoch: string): void {
    this.db.prepare('DELETE FROM conversation_read_changes WHERE account_id = ? AND created_at < ?')
      .run(accountId, this.now() - 10 * 60 * 1000);
    // Fixed row ceilings imply strict byte ceilings because every row is bounded.
    this.db.prepare(`DELETE FROM conversation_read_changes WHERE account_id = ? AND conversation_id = ? AND epoch = ?
      AND revision <= COALESCE((SELECT revision FROM conversation_read_changes
        WHERE account_id = ? AND conversation_id = ? AND epoch = ? ORDER BY revision DESC LIMIT 1 OFFSET ?), -1)`)
      .run(accountId, conversationId, epoch, accountId, conversationId, epoch, Math.floor(TAIL_BYTES / MAX_TURN_BYTES));
    const boundary = this.db.prepare(`SELECT created_at, conversation_id, epoch, revision FROM conversation_read_changes
      WHERE account_id = ? ORDER BY created_at DESC, conversation_id DESC, epoch DESC, revision DESC LIMIT 1 OFFSET ?`)
      .get(accountId, Math.floor(ACCOUNT_TAIL_BYTES / MAX_TURN_BYTES)) as
      { created_at: number; conversation_id: string; epoch: string; revision: number } | undefined;
    if (boundary) this.db.prepare(`DELETE FROM conversation_read_changes WHERE account_id = ?
      AND (created_at, conversation_id, epoch, revision) <= (?, ?, ?, ?)`)
      .run(accountId, boundary.created_at, boundary.conversation_id, boundary.epoch, boundary.revision);
  }
}
