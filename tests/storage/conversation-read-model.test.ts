import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { SqliteConversationReadModel } from '../../src/storage/conversation-read-model-repo.js';
import { ConversationReadProjector } from '../../src/session/conversation-read-projector.js';
import { CONVERSATION_BASELINE_BYTES, conversationPreview } from '../../src/session/conversation-read-model.js';
import type { GatewayEventEnvelope } from '../../src/gateway/client-events.js';
import { SqliteConversationHistoryRepo } from '../../src/storage/conversation-history-repo.js';
import { SqliteConversationHistoryProjectionSource } from '../../src/storage/conversation-history-projection-source.js';
import type { ConversationTurn } from '../../src/session/conversation-store.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  runMigrations(db);
  let now = Date.now();
  const store = new SqliteConversationReadModel(db, () => now);
  return { db, store, projector: new ConversationReadProjector(store), advance: (ms: number) => { now += ms; } };
}
function fact(sequence: number, turnId: string, kind: GatewayEventEnvelope['kind'], payload: unknown): GatewayEventEnvelope {
  return { protocolVersion: 2, accountId: 'account', conversationId: 'conv', turnId,
    requestId: `request_${turnId}`, eventId: `event_${sequence}`, sequence, kind, payload,
    occurredAt: '2026-10-02T00:00:00.000Z' };
}

describe('durable Conversation read model', () => {
  it('primes recent history before old backfill without skipping the durable checkpoint', () => {
    const { db, store, projector } = fixture();
    const source = new SqliteConversationHistoryRepo<ConversationTurn>(db, 'account', 'conversation');
    source.importOnce('conv', Array.from({ length: 100 }, (_, index) => ({ id: `turn_${index}`, conversationId: 'conv',
      userInput: `question ${index}`, finalAnswer: `result ${index}`, status: 'completed' })));
    const history = new SqliteConversationHistoryProjectionSource(db);
    const project = (turn: ConversationTurn, sequence: number) => projector.applyHistory('account', 'conv', turn, sequence);
    expect(history.primeRecent('account', 'conv', project)).toBe(true);
    expect(store.baseline('account', 'conv').turns.map(turn => turn.id)).toEqual(['turn_99']);
    expect(history.next('account', 'conv')?.turn.id).toBe('turn_0');
    for (let i = 0; i < 19; i++) expect(history.primeRecent('account', 'conv', project)).toBe(true);
    expect(history.primeRecent('account', 'conv', project)).toBe(false);
    expect(store.baseline('account', 'conv').turns.map(turn => turn.id)).toEqual(Array.from({ length: 20 }, (_, i) => `turn_${i + 80}`));
    expect(history.hasPending('account', 'conv')).toBe(true);
  });
  it('preserves an offscreen streamed result across generic final replies, Task mismatch and projector restart', () => {
    const { db, store, projector } = fixture();
    const answer = '完整结果🙂'.repeat(1000);
    const hash = createHash('sha256').update(answer).digest('hex');
    const meta = { taskId: 'task', resultId: 'result', contentHash: `sha256:${hash}`, byteLength: Buffer.byteLength(answer) };
    projector.apply('account', 'conv', [
      fact(1, 'one', 'trace_delta', { taskId: 'task', status: 'running' }),
      fact(2, 'one', 'result_delivery_available', meta),
      fact(3, 'one', 'result_chunk', { ...meta, offset: 0, chunk: answer }),
      fact(4, 'one', 'result_completed', meta),
      fact(5, 'one', 'final_answer', { lines: ['任务已完成'] }),
    ], 5);
    const expected = store.findTurn('account', 'conv', 'one')!;
    expect(expected).toMatchObject({ status: 'completed', deliveryStatus: 'ready', answerRef: { hash } });
    const restarted = new ConversationReadProjector(new SqliteConversationReadModel(db));
    restarted.apply('account', 'conv', [
      fact(6, 'one', 'final_answer', { ...meta, taskId: 'other', lines: ['wrong task'] }),
      fact(7, 'one', 'result_delivery_available', { ...meta, taskId: 'other', resultId: 'wrong' }),
      fact(8, 'one', 'result_chunk', { ...meta, taskId: 'other', offset: 0, chunk: 'wrong' }),
      fact(9, 'one', 'final_answer', { ...meta, resultId: 'old-result', lines: [] }),
    ], 9);
    expect(store.findTurn('account', 'conv', 'one')).toEqual(expected);
    expect(store.content('account', 'conv', hash, 0, 16384)?.text).toBe(answer);
    expect(store.head('account', 'conv')?.journalSequence).toBe(9);
  });

  it('does not report a gapped body as ready or revive a cancelled Turn on late completion', () => {
    const { store, projector } = fixture();
    const hash = createHash('sha256').update('firsttail').digest('hex');
    const meta = { resultId: 'r', contentHash: `sha256:${hash}`, byteLength: 9 };
    projector.apply('account', 'conv', [
      fact(1, 'one', 'result_delivery_available', meta),
      fact(2, 'one', 'result_chunk', { resultId: 'r', offset: 5, chunk: 'tail' }),
      fact(3, 'one', 'result_completed', meta),
      fact(4, 'one', 'delivery_status', { resultId: 'r', status: 'ready' }),
      fact(5, 'one', 'terminal_error', { code: 'cancelled' }),
      fact(6, 'one', 'trace_delta', { status: 'running' }),
      fact(7, 'one', 'final_answer', { ...meta, lines: [] }),
    ], 7);
    expect(store.findTurn('account', 'conv', 'one')).toMatchObject({ status: 'cancelled', deliveryStatus: 'verifying' });
    expect(store.content('account', 'conv', hash, 0, 100)).toBeNull();
  });

  it('recovers replaced history and emits deletion tombstones without resurrecting removed Turns from the audit', () => {
    const { db, store, projector } = fixture();
    const history = new SqliteConversationHistoryRepo<ConversationTurn>(db, 'account', 'conversation');
    const source = new SqliteConversationHistoryProjectionSource(db);
    const drain = () => source.drainDirty('account', 'conv', (turn, sequence) => projector.applyHistory('account', 'conv', turn, sequence),
      id => store.remove('account', 'conv', id));
    history.importOnce('conv', [{ id: 'one', conversationId: 'conv', userInput: 'original', finalAnswer: null, status: 'completed' }]);
    expect(drain()).toBe(true);
    history.upsert('conv', { id: 'one', conversationId: 'conv', userInput: 'replacement', finalAnswer: 'done', status: 'completed' });
    expect(drain()).toBe(true);
    expect(store.findTurn('account', 'conv', 'one')).toMatchObject({ userInput: 'replacement', answer: 'done' });
    const cursor = store.head('account', 'conv')!;
    history.replace('conv', []);
    expect(drain()).toBe(true);
    expect(store.changes('account', 'conv', cursor).changes).toMatchObject([{ removed: true, turn: { id: 'one', answer: '' } }]);
    projector.apply('account', 'conv', [fact(10, 'one', 'final_answer', { lines: ['stale audit'] })], 10);
    expect(store.page('account', 'conv').turns).toEqual([]);
    expect(drain()).toBe(false);
  });
  it('recovers streamed content across projector restarts and does not certify gaps or wrong hashes', () => {
    const { store, projector, db } = fixture();
    const answer = '结果🙂'.repeat(15_000);
    const hash = createHash('sha256').update(answer).digest('hex');
    const metadata = { resultId: 'result', contentHash: `sha256:${hash}`, byteLength: Buffer.byteLength(answer),
      certification: 'uncertified', completeness: 'partial' };
    projector.apply('account', 'conv', [fact(1, 'one', 'result_delivery_available', metadata)], 1);
    let offset = 0;
    let sequence = 2;
    for (let n = 0; n < 15_000; n += 1_000) {
      const chunk = '结果🙂'.repeat(1_000);
      const next = new ConversationReadProjector(new SqliteConversationReadModel(db));
      next.apply('account', 'conv', [fact(sequence, 'one', 'result_chunk', { resultId: 'result', offset, chunk })], sequence++);
      offset += Buffer.byteLength(chunk);
    }
    expect(store.content('account', 'conv', hash, 0, 100)).toBeNull();
    projector.apply('account', 'conv', [fact(sequence, 'one', 'result_completed', metadata)], sequence);
    expect(store.findTurn('account', 'conv', 'one')).toMatchObject({ deliveryStatus: 'ready', certification: 'uncertified' });
    let received = '';
    for (let position = 0; position < offset;) {
      const part = store.content('account', 'conv', hash, position, 1027)!;
      received += part.text;
      expect(part.nextOffset).toBeGreaterThan(position);
      position = part.nextOffset;
    }
    expect(received).toBe(answer);
    const bad = { hash: 'f'.repeat(64), byteLength: 8 };
    store.putContentChunk('account', 'conv', bad, 4, 'tail');
    expect(store.verifyContent('account', 'conv', bad)).toBe(false);
    store.putContentChunk('account', 'conv', bad, 0, 'head');
    expect(store.verifyContent('account', 'conv', bad)).toBe(false);
    expect(store.content('account', 'conv', bad.hash, 0, 8)).toBeNull();
  });

  it('imports canonical history transactionally, before live Turns, without conflating source cursors', () => {
    const { db, store, projector } = fixture();
    const history = new SqliteConversationHistoryRepo<ConversationTurn>(db, 'account', 'conversation');
    history.importOnce('conv', Array.from({ length: 30 }, (_, index) => ({
      id: `old_${index}`, conversationId: 'conv', userInput: `question ${index}`,
      finalAnswer: 'answer'.repeat(10_000), status: 'completed',
    })));
    projector.apply('account', 'conv', [fact(1, 'live', 'turn_started', { userInput: 'now' })], 1);
    const source = new SqliteConversationHistoryProjectionSource(db);
    while (source.hasPending('account', 'conv')) {
      if (source.drainDirty('account', 'conv', (turn, sequence) => projector.applyHistory('account', 'conv', turn, sequence),
        id => store.remove('account', 'conv', id))) continue;
      const item = source.next('account', 'conv')!;
      source.commit('account', 'conv', item.sequence, () => projector.applyHistory('account', 'conv', item.turn, item.sequence));
    }
    expect(store.head('account', 'conv')?.journalSequence).toBe(1);
    const recent = store.baseline('account', 'conv');
    expect(recent.turns.at(-1)?.id).toBe('live');
    expect(store.page('account', 'conv', { cursor: recent.nextCursor! }).turns[0]?.id).toBe('old_0');
    const writes = new SqliteConversationHistoryRepo<ConversationTurn>(db, 'account', 'conversation',
      (conversationId, turn, sequence) => projector.applyHistory('account', conversationId, turn, sequence));
    db.exec(`CREATE TRIGGER fail_history_view BEFORE UPDATE ON conversation_read_heads
      BEGIN SELECT RAISE(ABORT, 'injected_crash'); END`);
    expect(() => writes.upsert('conv', { id: 'old_0', conversationId: 'conv', userInput: 'changed',
      finalAnswer: 'changed', status: 'completed' })).toThrow('injected_crash');
    expect(history.find('conv', 'old_0')?.userInput).toBe('question 0');
    expect(store.findTurn('account', 'conv', 'old_0')?.userInput).toBe('question 0');
  });

  it('pages small entities while retaining complete UTF-8 content outside the initial payload', () => {
    const { store, projector } = fixture();
    const answer = '完整结果🙂'.repeat(20_000);
    projector.apply('account', 'conv', [fact(1, 'one', 'turn_started', { userInput: '问题' }),
      fact(2, 'one', 'final_answer', { lines: [answer] })], 2);
    const page = store.page('account', 'conv');
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(CONVERSATION_BASELINE_BYTES);
    expect(page.turns[0]!.answer).toBe(conversationPreview(answer));
    const ref = page.turns[0]!.answerRef!;
    expect(ref.byteLength).toBe(Buffer.byteLength(answer));
    let offset = 0;
    let received = '';
    while (offset < ref.byteLength) {
      const range = store.content('account', 'conv', ref.hash, offset, 1027)!;
      received += range.text;
      expect(range.nextOffset).toBeGreaterThan(offset);
      offset = range.nextOffset;
    }
    expect(received).toBe(answer);
    expect(createHash('sha256').update(received).digest('hex')).toBe(ref.hash);
    expect(store.content('other', 'conv', ref.hash, 0, 100)).toBeNull();
    expect(() => store.content('account', 'conv', ref.hash, 1, 100)).toThrow('invalid_content_offset');
  });

  it('keeps older active Turns independently of the latest historical page', () => {
    const { store, projector } = fixture();
    const events = [fact(1, 'old_running', 'turn_started', { userInput: '仍在工作' })];
    for (let n = 0; n < 100; n++) events.push(
      fact(2 + n * 2, `turn_${n}`, 'turn_started', { userInput: `Request ${n}` }),
      fact(3 + n * 2, `turn_${n}`, 'final_answer', { lines: ['Done'] }),
    );
    projector.apply('account', 'conv', events, 201);
    expect(store.page('account', 'conv', { limit: 10 }).turns).toHaveLength(10);
    expect(store.page('account', 'conv', { activeOnly: true }).turns.map(turn => turn.id)).toEqual(['old_running']);
    const first = store.page('account', 'conv', { limit: 10 });
    const next = store.page('account', 'conv', { limit: 10, cursor: first.nextCursor! });
    expect(new Set([...first.turns, ...next.turns].map(turn => turn.id)).size).toBe(20);
    expect(() => store.page('account', 'other', { cursor: first.nextCursor! })).toThrow('invalid_observation_cursor');
    expect(() => store.page('account', 'conv', { cursor: first.nextCursor!, activeOnly: true })).toThrow('invalid_observation_cursor');
  });

  it('survives reader recreation and returns an explicit reset when the change tail expires', () => {
    const { store, projector, db, advance } = fixture();
    projector.apply('account', 'conv', [fact(1, 'one', 'turn_started', { userInput: 'hello' })], 1);
    const cursor = store.head('account', 'conv')!;
    projector.apply('account', 'conv', [fact(2, 'one', 'final_answer', { lines: ['answer'] })], 2);
    const reopened = new SqliteConversationReadModel(db);
    const result = reopened.changes('account', 'conv', cursor);
    expect(result.reset).toBe(false);
    expect(result.changes[0]).toMatchObject({ prevRevision: cursor.revision,
      turn: { id: 'one', status: 'completed', answer: 'answer' } });
    expect(reopened.changes('other', 'conv', cursor).reset).toBe(true);
    advance(11 * 60 * 1000);
    projector.apply('account', 'conv', [fact(3, 'two', 'turn_started', { userInput: 'new' })], 3);
    expect(store.changes('account', 'conv', cursor).reset).toBe(true);
    expect(store.findTurn('account', 'conv', 'one')!.answer).toBe('answer');
  });

  it('rolls back entity, immutable content, head and change tail together on failure', () => {
    const { db, store, projector } = fixture();
    projector.apply('account', 'conv', [fact(1, 'one', 'turn_started', { userInput: 'hello' })], 1);
    const head = store.head('account', 'conv');
    db.exec(`CREATE TRIGGER interrupt_view BEFORE UPDATE ON conversation_read_heads
      BEGIN SELECT RAISE(ABORT, 'view_crash'); END;`);
    expect(() => projector.apply('account', 'conv', [fact(2, 'one', 'final_answer', { lines: ['result'] })], 2))
      .toThrow('view_crash');
    expect(store.head('account', 'conv')).toEqual(head);
    expect(store.findTurn('account', 'conv', 'one')!.status).toBe('running');
    expect(store.changes('account', 'conv', head!).changes).toEqual([]);
    expect(store.content('account', 'conv', createHash('sha256').update('result').digest('hex'), 0, 100)).toBeNull();
  });

  it('does not count repeated durable facts twice or claim a streamed preview is fully verified', () => {
    const { store, projector } = fixture();
    const events = [fact(1, 'one', 'turn_started', { userInput: 'test' }),
      fact(2, 'one', 'result_delivery_available', { resultId: 'result_1' }),
      fact(3, 'one', 'result_chunk', { resultId: 'result_1', offset: 0, chunk: '🙂'.repeat(2000) }),
      fact(4, 'one', 'result_completed', { resultId: 'result_1' })];
    projector.apply('account', 'conv', events, 4);
    const cursor = store.head('account', 'conv');
    projector.apply('account', 'conv', events, 4);
    expect(store.head('account', 'conv')).toEqual(cursor);
    expect(store.findTurn('account', 'conv', 'one')).toMatchObject({
      deliveryStatus: 'verifying', resultPreviewOmitted: true, resultOffset: 8000,
    });
  });
});
