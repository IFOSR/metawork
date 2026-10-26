import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { MemoryService } from '../../src/memory/memory-service.js';
import { MemoryBindingsRepo } from '../../src/storage/memory-bindings-repo.js';
import { MemoryFlushCursorRepo } from '../../src/storage/memory-flush-cursor-repo.js';
import { SqliteMemoryTurnSource } from '../../src/storage/memory-turn-source.js';
import type { MemoryPort } from '../../src/memory/memory-port.js';
import type { MemoryScope } from '../../src/memory/memory-types.js';

const ACCOUNT = 'local-default';
const CONVERSATION = 'conv-1';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

interface TurnInput {
  turnId: string;
  sequence: number;
  status?: string;
  userInput?: string;
  answer?: string;
  completedAt?: string;
}

function seedTurn(db: Database.Database, input: TurnInput): void {
  const body = {
    id: input.turnId,
    conversationId: CONVERSATION,
    requestId: 'req-1',
    revision: 1,
    firstSequence: input.sequence,
    lastSequence: input.sequence,
    userInput: input.userInput ?? '帮我看下销售数据',
    userInputRef: null,
    answer: input.answer ?? '好的，数据概览已经整理出来了。',
    answerRef: null,
    resultId: null,
    certification: null,
    completeness: null,
    resultOffset: 0,
    resultPreviewOmitted: false,
    status: input.status ?? 'completed',
    deliveryStatus: 'ready',
    taskId: null,
    startedAt: '2026-10-22T00:00:00.000Z',
    completedAt: input.completedAt ?? '2026-10-22T00:01:00.000Z',
    interactionKind: 'ai_turn',
  };
  db.prepare(`INSERT INTO conversation_read_turns
    (account_id, conversation_id, epoch, turn_id, first_sequence, revision, active, body_json, byte_length)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(ACCOUNT, CONVERSATION, 'epoch-1', input.turnId, input.sequence, 1, 0, JSON.stringify(body), 100);
}

class RecordingPort implements MemoryPort {
  deposits: Array<{ batch: { conversationId: string; turns: Array<{ userInput: string; assistantAnswer: string }> }; scope: MemoryScope }> = [];
  failNext = false;

  async health() { return { ready: true, ftsAvailable: true }; }
  async deposit(batch: { conversationId: string; workspaceId: string | null; turns: readonly { userInput: string; assistantAnswer: string }[] }, scope: MemoryScope) {
    if (this.failNext) throw new Error('engine unavailable');
    this.deposits.push({ batch, scope });
    return { accepted: batch.turns.length * 2 };
  }
  async search() { return { items: [], degraded: false }; }
  async materialize() {
    return { id: 'mem-1', type: 'persona', content: '偏好中文', background: null, createdAt: '', updatedAt: '' };
  }
  async listAssets() { return { items: [], total: 0 }; }
  async updateAsset() { return { memoryId: 'mem-1', version: 'v2' }; }
  async deleteAsset() { return { deleted: true }; }
  async readPersona() { return { content: null, updatedAt: null }; }
}

describe('MemoryService', () => {
  let db: Database.Database;
  let port: RecordingPort;
  let service: MemoryService;
  let cursors: MemoryFlushCursorRepo;

  beforeEach(() => {
    db = createTestDb();
    port = new RecordingPort();
    cursors = new MemoryFlushCursorRepo(db);
    service = new MemoryService({
      port,
      bindings: new MemoryBindingsRepo(db),
      cursors,
      turns: new SqliteMemoryTurnSource(db),
      thresholds: { idleAfterMs: 0, maxUnflushedTurns: 1, maxBatchTurns: 100 },
    });
  });

  it('deposits a whole batch of completed turns in one call', async () => {
    seedTurn(db, { turnId: 't1', sequence: 1 });
    seedTurn(db, { turnId: 't2', sequence: 2 });
    const outcome = await service.flushConversation({ accountId: ACCOUNT, conversationId: CONVERSATION });
    expect(port.deposits).toHaveLength(1);
    expect(port.deposits[0]!.batch.turns).toHaveLength(2);
    expect(outcome.flushed).toBe(4);
    expect(outcome.advancedTo).toBe(2);
  });

  it('never deposits a failed, cancelled or blocked turn', async () => {
    seedTurn(db, { turnId: 't1', sequence: 1, status: 'completed' });
    seedTurn(db, { turnId: 't2', sequence: 2, status: 'failed' });
    seedTurn(db, { turnId: 't3', sequence: 3, status: 'cancelled' });
    seedTurn(db, { turnId: 't4', sequence: 4, status: 'blocked' });
    await service.flushConversation({ accountId: ACCOUNT, conversationId: CONVERSATION });
    expect(port.deposits[0]!.batch.turns).toHaveLength(1);
  });

  it('advances the cursor only after the engine accepted the batch', async () => {
    seedTurn(db, { turnId: 't1', sequence: 1 });
    port.failNext = true;
    const outcome = await service.flushConversation({ accountId: ACCOUNT, conversationId: CONVERSATION });
    expect(outcome.flushed).toBe(0);
    expect(outcome.error).toBeTruthy();
    expect(cursors.lastSequence(ACCOUNT, CONVERSATION)).toBe(0);

    port.failNext = false;
    const retry = await service.flushConversation({ accountId: ACCOUNT, conversationId: CONVERSATION });
    expect(retry.flushed).toBe(2);
    expect(cursors.lastSequence(ACCOUNT, CONVERSATION)).toBe(1);
  });

  it('never deposits the same turn twice', async () => {
    seedTurn(db, { turnId: 't1', sequence: 1 });
    await service.flushConversation({ accountId: ACCOUNT, conversationId: CONVERSATION });
    await service.flushConversation({ accountId: ACCOUNT, conversationId: CONVERSATION });
    expect(port.deposits).toHaveLength(1);
  });

  it('redacts a secret before the batch reaches the engine', async () => {
    seedTurn(db, { turnId: 't1', sequence: 1, userInput: '我的 key 是 sk-abcdefgh12345678' });
    await service.flushConversation({ accountId: ACCOUNT, conversationId: CONVERSATION });
    expect(port.deposits[0]!.batch.turns[0]!.userInput).not.toContain('sk-abcdefgh12345678');
  });

  it('drops a refused turn and still advances the cursor', async () => {
    seedTurn(db, {
      turnId: 't1', sequence: 1, answer: '-----BEGIN RSA PRIVATE KEY-----\nAAA',
    });
    const outcome = await service.flushConversation({ accountId: ACCOUNT, conversationId: CONVERSATION });
    expect(port.deposits).toHaveLength(0);
    expect(outcome.refused).toBe(1);
    expect(cursors.lastSequence(ACCOUNT, CONVERSATION)).toBe(1);
  });

  it('refuses to materialize a memory of another account', async () => {
    const bindings = new MemoryBindingsRepo(db);
    bindings.upsert({ tdaiMemoryId: 'tdai-1', accountId: 'account-b' });
    await expect(service.materialize({ accountId: ACCOUNT, memoryId: 'mem_x' }))
      .rejects.toThrow(/memory_not_authorized/u);
  });

  it('refuses to materialize a disabled memory', async () => {
    const bindings = new MemoryBindingsRepo(db);
    const record = bindings.upsert({ tdaiMemoryId: 'tdai-1', accountId: ACCOUNT });
    bindings.setEnabled(record.memoryId, ACCOUNT, false);
    await expect(service.materialize({ accountId: ACCOUNT, memoryId: record.memoryId }))
      .rejects.toThrow(/memory_not_authorized/u);
  });

  it('materializes an enabled memory of the account', async () => {
    const bindings = new MemoryBindingsRepo(db);
    const record = bindings.upsert({ tdaiMemoryId: 'tdai-1', accountId: ACCOUNT });
    const materialization = await service.materialize({ accountId: ACCOUNT, memoryId: record.memoryId });
    expect(materialization.content).toBe('偏好中文');
  });

  it('degrades to an empty recall instead of failing the task chain', async () => {
    const failing: MemoryPort = {
      ...port,
      search: async () => { throw new Error('engine down'); },
    } as unknown as MemoryPort;
    const degraded = new MemoryService({
      port: failing,
      bindings: new MemoryBindingsRepo(db),
      cursors,
      turns: new SqliteMemoryTurnSource(db),
    });
    const result = await degraded.search({ accountId: ACCOUNT, query: 'x', limit: 5 });
    expect(result.degraded).toBe(true);
    expect(result.items).toEqual([]);
  });

  it('does not flush an active conversation before the idle threshold', async () => {
    seedTurn(db, { turnId: 't1', sequence: 1, completedAt: new Date().toISOString() });
    const active = new MemoryService({
      port,
      bindings: new MemoryBindingsRepo(db),
      cursors,
      turns: new SqliteMemoryTurnSource(db),
      thresholds: { idleAfterMs: 60_000, maxUnflushedTurns: 20 },
      now: () => Date.now(),
    });
    const outcome = await active.flushConversation({ accountId: ACCOUNT, conversationId: CONVERSATION });
    expect(outcome.flushed).toBe(0);
    expect(port.deposits).toHaveLength(0);
  });

  it('flushes an active conversation once the fallback threshold is reached', async () => {
    for (let index = 1; index <= 20; index++) {
      seedTurn(db, { turnId: `t${index}`, sequence: index, completedAt: new Date().toISOString() });
    }
    const active = new MemoryService({
      port,
      bindings: new MemoryBindingsRepo(db),
      cursors,
      turns: new SqliteMemoryTurnSource(db),
      thresholds: { idleAfterMs: 60_000, maxUnflushedTurns: 20 },
      now: () => Date.now(),
    });
    const outcome = await active.flushConversation({ accountId: ACCOUNT, conversationId: CONVERSATION });
    expect(outcome.flushed).toBe(40);
  });
});
