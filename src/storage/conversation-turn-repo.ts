import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { GatewayEventEnvelope } from '../gateway/client-events.js';
import type { ConversationTurnStore, StoredConversationTurn, TurnBodyReference, TurnIdentity } from '../session/conversation-turn-store.js';

export class SqliteConversationTurnStore implements ConversationTurnStore {
  constructor(private readonly db: Database.Database) {}

  accept(input: TurnIdentity & { userInput: string; requestKey: string; event: GatewayEventEnvelope }): StoredConversationTurn {
    return this.db.transaction(() => {
      this.assertWritable(input);
      this.assertEvent(input, 'turn_started');
      const ref = digest(input.userInput);
      const existing = this.findRequest(input.accountId, input.conversationId, input.requestKey) ?? this.find(input);
      if (existing) {
        if (existing.input.hash !== ref.hash || existing.turnId !== input.turnId
          || !this.findRequest(input.accountId, input.conversationId, input.requestKey)) throw new Error('turn_input_conflict');
        this.readBody(input.accountId, ref.hash);
        return existing;
      }
      this.putBody(input.accountId, input.userInput, input.event.occurredAt);
      const sequence = (this.db.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM conversation_turns
        WHERE account_id = ? AND conversation_id = ?`).get(input.accountId, input.conversationId) as { sequence: number }).sequence;
      this.db.prepare(`INSERT INTO conversation_turns(account_id, conversation_id, turn_id, sequence, request_key, user_input_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(input.accountId, input.conversationId, input.turnId, sequence, input.requestKey, ref.hash, input.event.occurredAt);
      const payload = input.event.payload as Record<string, unknown>;
      this.enqueue({ ...input.event, payload: { ...payload, userInput: undefined, userInputRef: ref } });
      this.writeHistory(input, { status: 'running', requestId: input.event.requestId, startedAt: input.event.occurredAt, inputRef: ref, attachments: payload.attachments ?? [], interactionKind: payload.interactionKind ?? 'ai_turn' });
      return this.find(input)!;
    }).immediate();
  }

  appendFinalAnswer(input: TurnIdentity & { content: string; revisionKey: string; sourceTaskId?: string | null;
    event: GatewayEventEnvelope }): StoredConversationTurn {
    return this.db.transaction(() => {
      this.assertWritable(input);
      this.assertEvent(input, 'final_answer');
      const turn = this.find(input);
      if (!turn) throw new Error('turn_not_found');
      const ref = digest(input.content);
      const previous = this.db.prepare(`SELECT revision, body_hash, source_task_id FROM conversation_turn_answers
        WHERE account_id = ? AND conversation_id = ? AND turn_id = ? AND revision_key = ?`)
        .get(input.accountId, input.conversationId, input.turnId, input.revisionKey) as { revision: number; body_hash: string; source_task_id: string | null } | undefined;
      if (previous) {
        if (previous.body_hash !== ref.hash || previous.source_task_id !== (input.sourceTaskId ?? null)) throw new Error('turn_answer_conflict');
        this.readBody(input.accountId, ref.hash);
        const payload = input.event.payload as Record<string, unknown>;
        const nextStatus = payload.backgroundWorkPending === true ? 'running' : 'completed';
        const old = this.db.prepare(`SELECT json_extract(body_json, '$.status') AS status FROM conversation_history_turns
          WHERE account_id = ? AND conversation_id = ? AND turn_id = ? AND kind = 'conversation'`)
          .get(input.accountId, input.conversationId, input.turnId) as { status: string } | undefined;
        // Content idempotency does not suppress the completion of the same
        // answer. A stale retry may never move a completed turn back to running.
        if (previous.revision === turn.answerRevision && old?.status === 'running' && nextStatus === 'completed') {
          this.writeHistory(input, { status: nextStatus, completedAt: input.event.occurredAt });
          this.enqueue({ ...input.event, payload: { ...payload, lines: undefined, answerRef: ref, answerRevision: previous.revision } });
        }
        return turn;
      }
      this.putBody(input.accountId, input.content, input.event.occurredAt);
      const revision = (turn.answerRevision ?? 0) + 1;
      this.db.prepare(`INSERT INTO conversation_turn_answers
        (account_id, conversation_id, turn_id, revision, revision_key, body_hash, source_task_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(input.accountId, input.conversationId, input.turnId, revision,
        input.revisionKey, ref.hash, input.sourceTaskId ?? null, input.event.occurredAt);
      this.db.prepare(`UPDATE conversation_turns SET final_answer_revision = ?
        WHERE account_id = ? AND conversation_id = ? AND turn_id = ?`).run(revision, input.accountId, input.conversationId, input.turnId);
      const payload = input.event.payload as Record<string, unknown>;
      if (typeof payload.resultId === 'string') {
        const result = this.db.prepare(`SELECT content_hash, byte_length FROM result_objects
          WHERE result_id = ? AND account_id = ?`).get(payload.resultId, input.accountId) as
          { content_hash: string; byte_length: number } | undefined;
        if (result?.content_hash === `sha256:${ref.hash}` && result.byte_length === ref.byteLength) {
          this.db.prepare('INSERT OR IGNORE INTO conversation_result_content_refs VALUES (?, ?, ?, ?)')
            .run(payload.resultId, input.accountId, input.conversationId, ref.hash);
        }
      }
      this.enqueue({ ...input.event, payload: { ...payload, lines: undefined, answerRef: ref, answerRevision: revision } });
      this.writeHistory(input, { answerRef: ref, answerRevision: revision,
        status: payload.backgroundWorkPending === true ? 'running' : 'completed',
        sourceTaskId: input.sourceTaskId ?? null, completedAt: payload.backgroundWorkPending === true ? null : input.event.occurredAt });
      return this.find(input)!;
    }).immediate();
  }

  recordFailure(identity: TurnIdentity, occurredAt: string): void {
    this.assertWritable(identity);
    if (!this.find(identity)) return;
    this.db.transaction(() => this.writeHistory(identity, { status: 'failed', completedAt: occurredAt })).immediate();
  }

  find(identity: TurnIdentity): StoredConversationTurn | null {
    const row = this.db.prepare(`SELECT t.*, i.byte_length AS input_length, a.body_hash AS answer_hash,
      b.byte_length AS answer_length FROM conversation_turns t
      LEFT JOIN conversation_turn_bodies i ON i.account_id = t.account_id AND i.body_hash = t.user_input_hash
      LEFT JOIN conversation_turn_answers a ON a.account_id = t.account_id AND a.conversation_id = t.conversation_id
        AND a.turn_id = t.turn_id AND a.revision = t.final_answer_revision
      LEFT JOIN conversation_turn_bodies b ON b.account_id = a.account_id AND b.body_hash = a.body_hash
      WHERE t.account_id = ? AND t.conversation_id = ? AND t.turn_id = ?`)
      .get(identity.accountId, identity.conversationId, identity.turnId) as {
        sequence: number; user_input_hash: string; input_length: number; answer_hash: string | null;
        answer_length: number | null; final_answer_revision: number | null; created_at: string;
      } | undefined;
    if (!row) return null;
    if (row.input_length === null) throw new Error('body_unavailable');
    if (row.final_answer_revision !== null && (row.answer_hash === null || row.answer_length === null)) throw new Error('body_unavailable');
    return { accountId: identity.accountId, conversationId: identity.conversationId, turnId: identity.turnId, sequence: row.sequence, input: { hash: row.user_input_hash, byteLength: row.input_length },
      answer: row.answer_hash ? { hash: row.answer_hash, byteLength: row.answer_length! } : null,
      answerRevision: row.final_answer_revision, createdAt: row.created_at };
  }

  findRequest(accountId: string, conversationId: string, requestKey: string): StoredConversationTurn | null {
    const row = this.db.prepare(`SELECT turn_id FROM conversation_turns WHERE account_id = ? AND conversation_id = ? AND request_key = ?`)
      .get(accountId, conversationId, requestKey) as { turn_id: string } | undefined;
    return row ? this.find({ accountId, conversationId, turnId: row.turn_id }) : null;
  }

  readBody(accountId: string, hash: string): TurnBodyReference & { text: string } {
    const row = this.db.prepare('SELECT body, byte_length FROM conversation_turn_bodies WHERE account_id = ? AND body_hash = ?')
      .get(accountId, hash) as { body: Buffer; byte_length: number } | undefined;
    if (!row) throw new Error('body_unavailable');
    if (row.body.length !== row.byte_length || createHash('sha256').update(row.body).digest('hex') !== hash) {
      throw new Error('body_integrity_error');
    }
    return { hash, byteLength: row.byte_length, text: row.body.toString('utf8') };
  }

  pendingEvents(accountId: string, limit = 100): GatewayEventEnvelope[] {
    return (this.db.prepare(`SELECT event_json FROM conversation_turn_outbox WHERE account_id = ? ORDER BY rowid LIMIT ?`)
      .all(accountId, limit) as { event_json: string }[]).map(row => JSON.parse(row.event_json) as GatewayEventEnvelope);
  }

  acknowledgeEvent(accountId: string, eventId: string): void {
    this.db.prepare('DELETE FROM conversation_turn_outbox WHERE account_id = ? AND event_id = ?').run(accountId, eventId);
  }

  deletionState(accountId: string, conversationId: string): 'pending' | 'completed' | null {
    return (this.db.prepare('SELECT state FROM conversation_deletions WHERE account_id = ? AND conversation_id = ?')
      .get(accountId, conversationId) as { state: 'pending' | 'completed' } | undefined)?.state ?? null;
  }

  /** Metadata projections store references only; callers must not rewrite the input. */
  encodeHistory<T extends { id: string }>(accountId: string, conversationId: string, value: T): T {
    const turn = this.find({ accountId, conversationId, turnId: value.id });
    if (!turn) return value; // Unresolved legacy evidence stays quarantined until migration proves provenance.
    const { userInput: _input, finalAnswer: _answer, ...metadata } = value as T & { userInput?: string; finalAnswer?: string };
    return { ...metadata, inputRef: turn.input, answerRef: turn.answer, answerRevision: turn.answerRevision } as unknown as T;
  }

  hydrateHistory<T extends { id: string }>(accountId: string, conversationId: string, value: T): T {
    this.assertWritable({ accountId, conversationId, turnId: value.id });
    const turn = this.find({ accountId, conversationId, turnId: value.id });
    if (!turn) {
      if ('inputRef' in value) throw new Error('body_unavailable');
      return 'userInput' in value || 'finalAnswer' in value
        ? { ...value, contentAuthority: 'legacy_unresolved' } : value;
    }
    const source = this.db.prepare(`SELECT a.created_at, a.source_task_id, task.status FROM conversation_turn_answers a
      LEFT JOIN tasks task ON task.id = a.source_task_id AND task.account_id = a.account_id AND task.conversation_id = a.conversation_id
      WHERE a.account_id = ? AND a.conversation_id = ? AND a.turn_id = ? AND a.revision = ?`)
      .get(accountId, conversationId, turn.turnId, turn.answerRevision) as
      { created_at: string; source_task_id: string | null; status: string | null } | undefined;
    const status = source?.status ? ({ succeeded: 'completed', needs_action: 'blocked', queued: 'running', pending: 'running',
      running: 'running', failed: 'failed', cancelled: 'cancelled' } as Record<string, string>)[source.status] : undefined;
    return { ...value, startedAt: turn.createdAt, ...(status ? { status } : {}),
      ...(source?.source_task_id ? { taskId: source.source_task_id } : {}),
      ...(source ? { completedAt: status === 'running' || status === 'blocked' ? null : source.created_at } : {}),
      userInput: this.readBody(accountId, turn.input.hash).text,
      finalAnswer: turn.answer ? this.readBody(accountId, turn.answer.hash).text : null };
  }

  private assertWritable(identity: TurnIdentity): void {
    if (this.deletionState(identity.accountId, identity.conversationId)) throw new Error('conversation_deleted');
  }
  private assertEvent(input: TurnIdentity & { event: GatewayEventEnvelope }, kind: string): void {
    if (input.event.accountId !== input.accountId || input.event.conversationId !== input.conversationId
      || input.event.turnId !== input.turnId || input.event.kind !== kind) throw new Error('turn_event_scope_mismatch');
  }
  private putBody(accountId: string, text: string, createdAt: string): void {
    const ref = digest(text);
    this.db.prepare(`INSERT OR IGNORE INTO conversation_turn_bodies(account_id, body_hash, body, byte_length, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(accountId, ref.hash, Buffer.from(text), ref.byteLength, createdAt);
    if (this.readBody(accountId, ref.hash).text !== text) throw new Error('body_integrity_error');
  }
  private enqueue(event: GatewayEventEnvelope): void {
    this.db.prepare(`INSERT INTO conversation_turn_outbox(account_id, event_id, conversation_id, event_json, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(event.accountId, event.eventId, event.conversationId, JSON.stringify(event), event.occurredAt);
  }
  private writeHistory(identity: TurnIdentity, fields: Record<string, unknown>): void {
    this.db.prepare(`INSERT OR IGNORE INTO conversation_history_streams(account_id, conversation_id, kind, last_sequence)
      VALUES (?, ?, 'conversation', 0)`).run(identity.accountId, identity.conversationId);
    const old = this.db.prepare(`SELECT body_json FROM conversation_history_turns
      WHERE account_id = ? AND conversation_id = ? AND kind = 'conversation' AND turn_id = ?`)
      .get(identity.accountId, identity.conversationId, identity.turnId) as { body_json: string } | undefined;
    const metadata = { ...(old ? JSON.parse(old.body_json) : { id: identity.turnId, conversationId: identity.conversationId }), ...fields };
    const body = JSON.stringify(this.encodeHistory(identity.accountId, identity.conversationId, metadata));
    if (old) this.db.prepare(`UPDATE conversation_history_turns SET body_json = ?, byte_length = ?
      WHERE account_id = ? AND conversation_id = ? AND kind = 'conversation' AND turn_id = ?`)
      .run(body, Buffer.byteLength(body), identity.accountId, identity.conversationId, identity.turnId);
    else {
      const row = this.db.prepare(`UPDATE conversation_history_streams SET last_sequence = last_sequence + 1
        WHERE account_id = ? AND conversation_id = ? AND kind = 'conversation' RETURNING last_sequence`)
        .get(identity.accountId, identity.conversationId) as { last_sequence: number };
      this.db.prepare(`INSERT INTO conversation_history_turns(account_id, conversation_id, kind, sequence, turn_id, body_json, byte_length)
        VALUES (?, ?, 'conversation', ?, ?, ?, ?)`).run(identity.accountId, identity.conversationId, row.last_sequence,
        identity.turnId, body, Buffer.byteLength(body));
    }
  }
}

export function digest(text: string): TurnBodyReference {
  return { hash: createHash('sha256').update(text, 'utf8').digest('hex'), byteLength: Buffer.byteLength(text, 'utf8') };
}
