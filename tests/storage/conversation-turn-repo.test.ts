import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { SqliteConversationTurnStore } from '../../src/storage/conversation-turn-repo.js';
import { SqliteConversationReadModel } from '../../src/storage/conversation-read-model-repo.js';
import { ConversationReadProjector } from '../../src/session/conversation-read-projector.js';
import { SqliteMemoryTurnSource } from '../../src/storage/memory-turn-source.js';
import type { GatewayEventEnvelope } from '../../src/gateway/client-events.js';

const identity = { accountId: 'account', conversationId: 'conv', turnId: 'turn' };
function event(kind: 'turn_started' | 'final_answer', id: string): GatewayEventEnvelope {
  return { ...identity, protocolVersion: 2, eventId: id, requestId: 'request', sequence: 0, kind,
    payload: { interactionKind: 'ai_turn' }, occurredAt: '2026-11-01T00:00:00.000Z' };
}
describe('authoritative conversation content', () => {
  let db: Database.Database;
  let store: SqliteConversationTurnStore;
  beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); runMigrations(db); store = new SqliteConversationTurnStore(db); });
  afterEach(() => db.close());
  const accept = (text = '原始问题\n') => store.accept({ ...identity, userInput: text, requestKey: 'request', event: event('turn_started', 'start') });
  const answer = (content = '回答', revisionKey = 'v1') => store.appendFinalAnswer({ ...identity, content, revisionKey, event: event('final_answer', revisionKey) });

  it('commits original bytes and outbox together, retries without duplication and rejects changed requests', () => {
    const text = '  用户\r\n🙂e\u0301\n';
    const turn = accept(text);
    expect(store.readBody(identity.accountId, turn.input.hash).text).toBe(text);
    expect(accept(text)).toEqual(turn);
    expect(store.pendingEvents(identity.accountId)).toHaveLength(1);
    expect(JSON.stringify(store.pendingEvents(identity.accountId))).not.toContain('用户');
    expect(() => accept('different')).toThrow('turn_input_conflict');
    expect(store.pendingEvents(identity.accountId)).toHaveLength(1);
  });
  it('keeps immutable revisions and does not move current answer backwards on stale retry', () => {
    accept(); const first = answer(); const second = answer('new', 'v2');
    expect(second.answerRevision).toBe(2);
    expect(answer().answerRevision).toBe(2);
    expect(store.readBody(identity.accountId, first.answer!.hash).text).toBe('回答');
    expect(() => answer('conflict')).toThrow('turn_answer_conflict');
    expect(store.pendingEvents(identity.accountId)).toHaveLength(3);
  });
  it('completes an unchanged answer without appending a revision or allowing stale pending retries', () => {
    accept();
    const pending = { ...event('final_answer', 'pending'), payload: { backgroundWorkPending: true } };
    store.appendFinalAnswer({ ...identity, content: 'answer', revisionKey: 'same', event: pending });
    store.appendFinalAnswer({ ...identity, content: 'answer', revisionKey: 'same', event: event('final_answer', 'complete') });
    store.appendFinalAnswer({ ...identity, content: 'answer', revisionKey: 'same', event: { ...pending, eventId: 'stale' } });
    expect(store.find(identity)?.answerRevision).toBe(1);
    expect(store.pendingEvents(identity.accountId)).toHaveLength(3);
    expect(db.prepare("SELECT json_extract(body_json, '$.status') AS status FROM conversation_history_turns").get()).toEqual({ status: 'completed' });
  });
  it('rolls back bodies and revisions if the outbox insert fails', () => {
    accept();
    db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON conversation_turn_outbox BEGIN SELECT RAISE(ABORT,'disk_failure'); END");
    expect(() => answer()).toThrow('disk_failure');
    expect(store.find(identity)?.answer).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_turn_bodies').get()).toEqual({ n: 1 });
  });
  it('rebuilds exact long input and answer from references and feeds full content to Memory', () => {
    const input = '完整输入🙂'.repeat(5000); const output = '完整回答尾部'.repeat(10000);
    accept(input); const turn = answer(output);
    const model = new SqliteConversationReadModel(db); const projector = new ConversationReadProjector(model);
    projector.apply(identity.accountId, identity.conversationId, store.pendingEvents(identity.accountId).map((e, i) => ({ ...e, sequence: i + 1 })), 2);
    const view = model.findTurn(identity.accountId, identity.conversationId, identity.turnId)!;
    expect(view.userInput.length).toBeLessThan(input.length);
    expect(view.answerRef).toEqual(turn.answer);
    expect(new SqliteMemoryTurnSource(db).completedTurnsAfter({ ...identity, afterSequence: 0, maxTurns: 10 })[0])
      .toMatchObject({ userInput: input, assistantAnswer: output });
    db.exec('DELETE FROM conversation_read_turns; DELETE FROM conversation_read_bodies; DELETE FROM conversation_read_heads');
    expect(store.readBody(identity.accountId, turn.answer!.hash).text).toBe(output);
    expect(db.prepare("SELECT body_json FROM conversation_history_turns").get()).not.toEqual(expect.objectContaining({ body_json: expect.stringContaining(output) }));
  });
  it('rejects corrupt bodies and foreign-account reads instead of using preview', () => {
    const turn = accept(); answer();
    expect(() => store.readBody('other', turn.input.hash)).toThrow('body_unavailable');
    db.prepare('UPDATE conversation_turn_bodies SET body = ? WHERE body_hash = ?').run(Buffer.from('corrupt'), turn.input.hash);
    expect(() => new SqliteMemoryTurnSource(db).completedTurnsAfter({ ...identity, afterSequence: 0, maxTurns: 10 })).toThrow('body_integrity_error');
  });
  it('fences input and answer after a deletion tombstone', () => {
    accept();
    db.prepare("INSERT INTO conversation_deletions VALUES (?, ?, 'pending', 'now')").run(identity.accountId, identity.conversationId);
    expect(() => answer()).toThrow('conversation_deleted');
    expect(() => accept()).toThrow('conversation_deleted');
  });
});
