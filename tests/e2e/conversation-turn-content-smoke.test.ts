import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { runMigrations } from '../../src/storage/migrations.js';
import { SqliteConversationTurnStore } from '../../src/storage/conversation-turn-repo.js';
import { SqliteMemoryTurnSource } from '../../src/storage/memory-turn-source.js';
import { TdaiMemoryAdapter } from '../../src/memory/tdai-memory-adapter.js';
import { deriveMemoryScope } from '../../src/memory/memory-scope.js';
import { resolveMemoryEngineRoot, startMemoryEngine, type MemoryEngineHandle } from '../support/memory-engine-harness.js';
import { startMockLlm, type MockLlm } from '../support/mock-llm-server.js';

/** Real SQLite -> Memory Port -> HTTP sidecar -> durable L0, with a deterministic model. */
const engineRoot = resolveMemoryEngineRoot();
describe.skipIf(!engineRoot)('Turn content smoke with real memory engine', () => {
  let engine: MemoryEngineHandle;
  let llm: MockLlm;
  let db: Database.Database;
  let adapter: TdaiMemoryAdapter;
  const identity = { accountId: 'local-default', conversationId: 'conv-content-smoke', turnId: 'turn-1' };
  const scope = deriveMemoryScope(identity.accountId);
  beforeAll(async () => {
    llm = await startMockLlm();
    engine = await startMemoryEngine({ engineRoot: engineRoot!, llmBaseUrl: llm.baseUrl });
    db = new Database(':memory:'); db.pragma('foreign_keys = ON'); runMigrations(db);
    adapter = new TdaiMemoryAdapter({ baseUrl: `http://127.0.0.1:${engine.port}`, serviceId: 'metawork', kernelAuthToken: engine.kernelAuthToken, timeoutMs: 20_000, retries: 0 });
  }, 180_000);
  afterAll(async () => { await engine?.stop(); await llm?.close(); db?.close(); });

  it('deposits full Unicode content, retries idempotently, deletes L0 and rejects resurrection', async () => {
    const store = new SqliteConversationTurnStore(db);
    const common = { ...identity, protocolVersion: 2 as const, sequence: 0, requestId: 'r', occurredAt: new Date().toISOString() };
    const input = '请根据北京天气做PPT🙂'.repeat(1600);
    const output = '完整演示内容与结论'.repeat(100000) + '最后一行不可丢失';
    store.accept({ ...identity, userInput: input, requestKey: 'r', event: { ...common, eventId: 'e1', kind: 'turn_started', payload: {} } });
    store.appendFinalAnswer({ ...identity, content: output, revisionKey: 'a1', event: { ...common, eventId: 'e2', kind: 'final_answer', payload: {} } });
    const turns = new SqliteMemoryTurnSource(db).completedTurnsAfter({ ...identity, afterSequence: 0, maxTurns: 10 });
    expect(turns[0]?.userInput).toBe(input); expect(turns[0]?.assistantAnswer).toBe(output);
    const batch = { conversationId: identity.conversationId, workspaceId: null, turns };
    expect((await adapter.deposit(batch, scope)).accepted).toBe(2);
    const memoryDb = new Database(resolve(engine.dataDir, 'data/vectors.db'), { readonly: true });
    const read = () => memoryDb.prepare(`SELECT record_id, role, message_text, recorded_at FROM l0_conversations
      WHERE session_key = ? ORDER BY recorded_at, record_id`).all(identity.conversationId) as
      { record_id: string; role: string; message_text: string; recorded_at: string }[];
    const stored = read();
    expect(stored.length).toBeGreaterThan(100);
    for (const [role, content] of [['user', input], ['assistant', output]]) {
      expect(stored.filter(row => row.role === role).map(row => row.message_text).join('')).toBe(content);
    }
    expect((await adapter.deposit(batch, scope)).accepted).toBe(2);
    expect(read()).toEqual(stored);
    expect(await adapter.deleteConversation(identity.conversationId, scope)).toBe(true);
    expect(await adapter.deleteConversation(identity.conversationId, scope)).toBe(true);
    expect(read()).toEqual([]);
    memoryDb.close();
    await expect(adapter.deposit(batch, scope)).rejects.toThrow();
  }, 60_000);
});
