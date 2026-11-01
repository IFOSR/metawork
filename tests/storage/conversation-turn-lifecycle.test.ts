import Database from 'better-sqlite3';
import { MemorySanitizer } from '../../src/memory/memory-sanitizer.js';
import { SessionPersistenceService } from '../../src/session/session-persistence-service.js';
import { storeDerivedContent, resolveDerivedContent } from '../../src/storage/conversation-content-references.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { SqliteConversationTurnStore } from '../../src/storage/conversation-turn-repo.js';
import { SqliteConversationReadModel } from '../../src/storage/conversation-read-model-repo.js';
import { SqliteConversationHistorySearch } from '../../src/storage/conversation-history-search-repo.js';
import { ConversationReadProjector } from '../../src/session/conversation-read-projector.js';
import { SqliteConversationTurnMigration } from '../../src/storage/conversation-turn-migration.js';
import { SqliteConversationDeletionStore } from '../../src/storage/conversation-deletion-repo.js';
import { ConversationDeletionService } from '../../src/session/conversation-deletion.js';
import { MemoryFlushCursorRepo } from '../../src/storage/memory-flush-cursor-repo.js';
import { SqliteMemoryTurnSource } from '../../src/storage/memory-turn-source.js';
import type { GatewayEventEnvelope } from '../../src/gateway/client-events.js';

const accountId = 'account'; const conversationId = 'conv';
const identity = { accountId, conversationId, turnId: 'turn' };
function event(kind: 'turn_started' | 'final_answer', id: string, turnId = 'turn'): GatewayEventEnvelope {
  return { ...identity, turnId, protocolVersion: 2, eventId: id, requestId: id, sequence: kind === 'turn_started' ? 1 : 2,
    kind, payload: { interactionKind: 'ai_turn' }, occurredAt: '2026-11-01T00:00:00Z' };
}
describe('conversation content lifecycle', () => {
  let db: Database.Database; let store: SqliteConversationTurnStore;
  beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); runMigrations(db); store = new SqliteConversationTurnStore(db); });
  afterEach(() => db.close());
  function accept(turnId = 'turn') {
    return store.accept({ ...identity, turnId, userInput: 'original user input', requestKey: turnId, event: event('turn_started', `s:${turnId}`, turnId) });
  }
  function answer(turnId = 'turn', revision = 'v1', content = 'complete answer') {
    return store.appendFinalAnswer({ ...identity, turnId, content, revisionKey: revision, event: event('final_answer', `${turnId}:${revision}`, turnId) });
  }
  it('does not deposit a provisional answer while its source Task is still queued', () => {
    accept();
    db.prepare(`INSERT INTO tasks(id, title, account_id, conversation_id, created_at, updated_at)
      VALUES ('queued-task', 'queued', ?, ?, 'now', 'now')`).run(accountId, conversationId);
    store.appendFinalAnswer({ ...identity, content: 'provisional', revisionKey: 'queued-answer', sourceTaskId: 'queued-task',
      event: event('final_answer', 'queued-answer') });
    const source = new SqliteMemoryTurnSource(db);
    expect(source.completedTurnsAfter({ accountId, conversationId, afterSequence: 0, maxTurns: 50 })).toEqual([]);
    expect(store.hydrateHistory(accountId, conversationId, { id: 'turn', status: 'completed' }).status).toBe('running');
    db.prepare("UPDATE tasks SET status = 'succeeded' WHERE id = 'queued-task'").run();
    expect(source.completedTurnsAfter({ accountId, conversationId, afterSequence: 0, maxTurns: 50 })).toHaveLength(1);
  });
  it('acknowledges empty versions as refusals so they cannot starve later content', () => {
    for (let n = 0; n < 50; n++) { accept(`empty-${n}`); answer(`empty-${n}`, 'v1', ''); }
    accept(); answer();
    const source = new SqliteMemoryTurnSource(db);
    const cursors = new MemoryFlushCursorRepo(db);
    const first = source.completedTurnsAfter({ accountId, conversationId, afterSequence: 0, maxTurns: 50 });
    expect(new MemorySanitizer().sanitizeTurns(first)).toMatchObject({ turns: [], refused: 50 });
    cursors.acknowledge(accountId, conversationId, first);
    const next = source.completedTurnsAfter({ accountId, conversationId, afterSequence: 0, maxTurns: 50 });
    expect(next.map(turn => turn.turnId)).toEqual(['turn']);
  });
  it('uses authoritative order even when journal events arrive out of order', () => {
    accept(); accept('second');
    const events = store.pendingEvents(accountId);
    const model = new SqliteConversationReadModel(db);
    const projector = new ConversationReadProjector(model);
    projector.apply(accountId, conversationId, [
      { ...events[1]!, sequence: 1 }, { ...events[0]!, sequence: 2 },
    ], 2);
    expect(model.findTurn(accountId, conversationId, 'turn')?.firstSequence).toBe(1);
    expect(model.findTurn(accountId, conversationId, 'second')?.firstSequence).toBe(2);
  });
  it('deduplicates interaction retries and fences derived readers immediately at deletion', () => {
    accept();
    const writer = new SessionPersistenceService(db);
    const input = { ...identity, taskId: null, sessionId: 'planner', userInput: 'instruction', systemOutput: 'result', executorUsed: 'planner' };
    writer.recordInteraction(input); writer.recordInteraction(input);
    expect(db.prepare('SELECT count(*) AS n FROM interactions').get()).toEqual({ n: 1 });
    const ref = storeDerivedContent(db, { ...identity, kind: 'task_instruction', text: 'instruction' });
    expect(resolveDerivedContent(db, ref)).toBe('instruction');
    new SqliteConversationDeletionStore(db).begin(accountId, conversationId);
    expect(() => resolveDerivedContent(db, ref)).toThrow('conversation_deleted');
  });
  it('persists order reconciliation diagnostics instead of declaring an unsafe cutover recoverable', () => {
    accept();
    const model = new SqliteConversationReadModel(db);
    const ref = model.putContent(accountId, conversationId, 'older original');
    const migration = new SqliteConversationTurnMigration(db);
    const events = [{ ...event('turn_started', 'old', 'old'), occurredAt: '2026-10-01T00:00:00Z',
      payload: { userInputRef: ref, originalInputHash: ref.hash } }];
    expect(migration.migrate(accountId, conversationId, events)[0]?.reason).toBe('offline_order_reconciliation_required');
    expect(db.prepare('SELECT classification FROM conversation_turn_migration WHERE turn_id = ?').get('old')).toEqual({ classification: 'conflict' });
    expect(store.find({ ...identity, turnId: 'old' })).toBeNull();
  });
  it('keeps file cleanup failures pending and does not run later erasure phases until retry', async () => {
    accept(); answer(); let failing = true; let externalCalls = 0;
    const service = new ConversationDeletionService({ store: new SqliteConversationDeletionStore(db),
      cleanFiles: async () => { if (failing) throw new Error('file locked'); },
      cleanMemory: async () => { externalCalls++; return true; }, onError: () => {} });
    expect(await service.remove(accountId, conversationId)).toBe('pending');
    expect(externalCalls).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM conversation_turns').get()).toEqual({ n: 1 });
    failing = false; await service.retry(accountId);
    expect(store.deletionState(accountId, conversationId)).toBe('completed');
    expect(db.prepare('SELECT count(*) AS n FROM conversation_turns').get()).toEqual({ n: 0 });
  });
  it('does not lose late completions or a new answer version behind the old cursor', () => {
    accept(); accept('second'); answer('second');
    const source = new SqliteMemoryTurnSource(db); const cursors = new MemoryFlushCursorRepo(db);
    const read = () => source.completedTurnsAfter({ accountId, conversationId, afterSequence: cursors.lastSequence(accountId, conversationId), maxTurns: 50 });
    const first = read(); expect(first.map(t => t.turnId)).toEqual(['second']);
    cursors.acknowledge(accountId, conversationId, first); cursors.advance(accountId, conversationId, 2);
    answer(); expect(read().map(t => t.turnId)).toEqual(['turn']);
    cursors.acknowledge(accountId, conversationId, read()); expect(read()).toEqual([]);
    answer('turn', 'v2', 'revised answer'); expect(read()[0]?.assistantAnswer).toBe('revised answer');
    expect(cursors.listPendingCandidates({ accountId, now: Date.now(), idleAfterMs: 0, limit: 10 })).toContain(conversationId);
  });
  it('rebuilds full text search without a second persistent body and finds the tail', () => {
    accept(); const content = 'prefix '.repeat(10000) + 'UNIQUE_END_OF_DOCUMENT'; answer('turn', 'v1', content);
    const model = new SqliteConversationReadModel(db);
    new ConversationReadProjector(model).apply(accountId, conversationId,
      store.pendingEvents(accountId).map((e, i) => ({ ...e, sequence: i + 1 })), 2);
    const search = new SqliteConversationHistorySearch(db, model);
    while (search.maintain(accountId, conversationId)) { /* bounded chunks */ }
    expect(search.search(accountId, conversationId, 'UNIQUE_END_OF_DOCUMENT').hits).toHaveLength(1);
    expect(db.prepare('SELECT count(*) AS n FROM conversation_read_bodies').get()).toEqual({ n: 0 });
  });
  it('records failure without inventing an answer or depositing it', () => {
    accept(); store.recordFailure(identity, '2026-11-01T00:02:00Z');
    expect(store.find(identity)?.answer).toBeNull();
    expect(db.prepare("SELECT json_extract(body_json, '$.status') AS status FROM conversation_history_turns").get()).toEqual({ status: 'failed' });
    expect(new SqliteMemoryTurnSource(db).completedTurnsAfter({ ...identity, afterSequence: 0, maxTurns: 10 })).toEqual([]);
  });
  it('keeps external deletion pending, retries and prevents replay from restoring bodies', async () => {
    accept(); const turn = answer(); let external = false;
    const deletion = new ConversationDeletionService({ store: new SqliteConversationDeletionStore(db),
      cleanFiles: async () => {}, cleanMemory: async () => external, onError: error => { throw error; } });
    const events = store.pendingEvents(accountId);
    expect(await deletion.remove(accountId, conversationId)).toBe('pending');
    expect(() => store.readBody(accountId, turn.input.hash)).toThrow('body_unavailable');
    const model = new SqliteConversationReadModel(db);
    expect(() => new ConversationReadProjector(model).apply(accountId, conversationId, events, 2)).toThrow('conversation_deleted');
    external = true; await deletion.retry(accountId);
    expect(store.deletionState(accountId, conversationId)).toBe('completed');
    expect(await deletion.remove(accountId, conversationId)).toBe('completed');
  });
  it('dry-runs and migrates proven original input, preserves failed status and emits no new notifications', () => {
    const model = new SqliteConversationReadModel(db);
    const inputRef = model.putContent(accountId, conversationId, 'original');
    const answerRef = model.putContent(accountId, conversationId, 'answer');
    const events = [{ ...event('turn_started', 'start'), payload: { userInputRef: inputRef, originalInputHash: inputRef.hash } },
      { ...event('final_answer', 'end'), payload: { answerRef } }];
    db.prepare(`INSERT INTO conversation_history_streams(account_id, conversation_id, kind, last_sequence) VALUES (?, ?, 'conversation', 1)`).run(accountId, conversationId);
    db.prepare(`INSERT INTO conversation_history_turns VALUES (?, ?, 'conversation', 1, 'turn', ?, 100)`)
      .run(accountId, conversationId, JSON.stringify({ id: 'turn', userInput: 'wrong preview', finalAnswer: 'answer', status: 'failed' }));
    const migration = new SqliteConversationTurnMigration(db);
    expect(migration.review(accountId, conversationId, events)[0]?.classification).toBe('recoverable_single_source');
    expect(store.find(identity)).toBeNull();
    migration.migrate(accountId, conversationId, events);
    expect(store.readBody(accountId, store.find(identity)!.input.hash).text).toBe('original');
    expect(store.pendingEvents(accountId)).toEqual([]);
    expect(db.prepare("SELECT json_extract(body_json, '$.status') AS status FROM conversation_history_turns").get()).toEqual({ status: 'failed' });
    expect(migration.migrate(accountId, conversationId, events)[0]?.classification).toBe('exact_match');
    expect(migration.canRetire(accountId, conversationId)).toBe(false);
    const afterWindow = Date.now() + 8 * 24 * 60 * 60 * 1000;
    expect(migration.canRetire(accountId, conversationId, afterWindow)).toBe(true);
    migration.retireCopies(accountId, conversationId, afterWindow);
    expect(db.prepare('SELECT count(*) AS n FROM conversation_read_bodies').get()).toEqual({ n: 0 });
    expect(store.readBody(accountId, inputRef.hash).text).toBe('original');
    expect(migration.canRetire(accountId, conversationId, afterWindow)).toBe(false);

  });
  it('does not promote redacted Gateway bytes or conflicting original inputs', () => {
    const model = new SqliteConversationReadModel(db); const migration = new SqliteConversationTurnMigration(db);
    const first = model.putContent(accountId, conversationId, 'public redacted preview');
    const a = { ...event('turn_started', 'one'), payload: { userInputRef: first } };
    expect(migration.migrate(accountId, conversationId, [a])[0]?.classification).toBe('missing');
    const second = model.putContent(accountId, conversationId, 'different original');
    expect(migration.migrate(accountId, conversationId, [{ ...a, payload: { ...a.payload, originalInputHash: first.hash } },
      { ...event('turn_started', 'two'), payload: { userInputRef: second, originalInputHash: second.hash } }])[0]?.classification).toBe('conflict');
    expect(store.find(identity)).toBeNull();
  });
});
