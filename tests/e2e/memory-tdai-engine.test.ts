/**
 * End-to-end test against the real TDAI MemoryCore.
 *
 * This exercises the whole memory loop with the actual engine:
 *   MetaWork flush -> engine L0 -> engine L1 extraction -> BM25 recall
 *   -> MetaWork binding -> execution evidence
 *
 * The engine is started from a local TDAI checkout with a deterministic mock
 * extraction model, so the test is reproducible. When no checkout is available
 * the test is skipped instead of failing, so the suite stays green on a machine
 * without the engine sources.
 *
 * Provide the checkout with `METAWORK_MEMORY_SIDECAR_DIR` or the default
 * `.tmp/tdai/MemoryCore` location inside the repository.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { MemoryService } from '../../src/memory/memory-service.js';
import { TdaiMemoryAdapter } from '../../src/memory/tdai-memory-adapter.js';
import { MemoryBindingsRepo } from '../../src/storage/memory-bindings-repo.js';
import { MemoryFlushCursorRepo } from '../../src/storage/memory-flush-cursor-repo.js';
import { SqliteMemoryTurnSource } from '../../src/storage/memory-turn-source.js';
import { MemoryRecallRepo } from '../../src/storage/memory-recall-repo.js';
import { MemoryEvidenceService } from '../../src/memory/memory-evidence-service.js';
import { TaskExecutionEvidenceRepo } from '../../src/execution/execution-evidence-port.js';
import { deriveMemoryScope } from '../../src/memory/memory-scope.js';
import { startMockLlm, type MockLlm } from '../support/mock-llm-server.js';
import {
  resolveMemoryEngineRoot,
  startMemoryEngine,
  type MemoryEngineHandle,
} from '../support/memory-engine-harness.js';

const ACCOUNT = 'local-default';
const CONVERSATION = 'conv-e2e';

const engineRoot = resolveMemoryEngineRoot();
const describeEngine = engineRoot ? describe : describe.skip;

describeEngine('memory engine end to end', () => {
  let engine: MemoryEngineHandle;
  let llm: MockLlm;
  let db: Database.Database;

  beforeAll(async () => {
    llm = await startMockLlm();
    engine = await startMemoryEngine({ engineRoot: engineRoot!, llmBaseUrl: llm.baseUrl });

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(`INSERT INTO tasks
      (id, title, goal, status, created_at, updated_at, account_id, conversation_id, workspace_id)
      VALUES ('task-e2e', '记忆任务', '验证端到端', 'running', '2026-10-22T00:00:00.000Z',
        '2026-10-22T00:00:00.000Z', 'local-default', 'conv-e2e', 'ws-1')`).run();
  }, 180_000);

  afterAll(async () => {
    await engine?.stop();
    await llm?.close();
    db?.close();
  });

  function seedTurns(): void {
    const turns = [
      { id: 't1', seq: 1, user: '帮我看下这份销售数据', answer: '好的，数据概览已经整理出来了。' },
      { id: 't2', seq: 2, user: '那把华东区单独拆出来', answer: '华东区单独拆分如下。' },
      { id: 't3', seq: 3, user: '以后都用中文表格输出', answer: '明白，后续默认使用中文表格输出。' },
    ];
    for (const turn of turns) {
      const body = {
        id: turn.id,
        conversationId: CONVERSATION,
        requestId: 'req-1',
        revision: 1,
        firstSequence: turn.seq,
        lastSequence: turn.seq,
        userInput: turn.user,
        userInputRef: null,
        answer: turn.answer,
        answerRef: null,
        resultId: null,
        certification: null,
        completeness: null,
        resultOffset: 0,
        resultPreviewOmitted: false,
        status: 'completed',
        deliveryStatus: 'ready',
        taskId: null,
        startedAt: '2026-10-22T00:00:00.000Z',
        completedAt: '2026-10-22T00:01:00.000Z',
        interactionKind: 'ai_turn',
      };
      db.prepare(`INSERT INTO conversation_read_turns
        (account_id, conversation_id, epoch, turn_id, first_sequence, revision, active, body_json, byte_length)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(ACCOUNT, CONVERSATION, 'epoch-e2e', turn.id, turn.seq, 1, 0, JSON.stringify(body), 100);
    }
  }

  it('deposits, extracts, recalls and delivers a memory through the real engine', async () => {
    seedTurns();
    const adapter = new TdaiMemoryAdapter({
      baseUrl: `http://127.0.0.1:${engine.port}`,
      serviceId: 'metawork',
      kernelAuthToken: engine.kernelAuthToken,
      timeoutMs: 20_000,
    });
    const health = await adapter.health();
    expect(health.ftsAvailable).toBe(true);

    const bindings = new MemoryBindingsRepo(db);
    const service = new MemoryService({
      port: adapter,
      bindings,
      cursors: new MemoryFlushCursorRepo(db),
      turns: new SqliteMemoryTurnSource(db),
      thresholds: { idleAfterMs: 0, maxUnflushedTurns: 1 },
    });

    const outcome = await service.flushConversation({ accountId: ACCOUNT, conversationId: CONVERSATION });
    expect(outcome.flushed).toBe(6);
    expect(outcome.error).toBeUndefined();

    // The engine extracts shortly after the deposit.
    let found = await service.search({ accountId: ACCOUNT, query: '中文表格', limit: 5 });
    for (let attempt = 0; attempt < 40 && found.items.length === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1_000));
      found = await service.search({ accountId: ACCOUNT, query: '中文表格', limit: 5 });
    }
    expect(found.degraded).toBe(false);
    expect(found.items.length).toBeGreaterThan(0);
    expect(found.items[0]!.content).toContain('中文表格');

    // The Planner-facing read model carries a bounded preview, not the body.
    const recall = new MemoryRecallRepo(db);
    const binding = service.bind({
      accountId: ACCOUNT,
      tdaiMemoryId: found.items[0]!.id,
      workspaceId: 'ws-1',
      content: found.items[0]!.content,
    });
    recall.replace({
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      candidates: [{ memoryId: binding.memoryId, type: found.items[0]!.type, preview: found.items[0]!.content, score: 1 }],
    });
    expect(recall.list({ accountId: ACCOUNT, conversationId: CONVERSATION, limit: 5 })).toHaveLength(1);

    // The body reaches the Executor only as evidence.
    const evidence = new MemoryEvidenceService({
      resolveService: () => service,
      evidenceRepo: new TaskExecutionEvidenceRepo(db),
      maxStoredChars: 8_192,
    });
    const materialized = await evidence.materialize({
      accountId: ACCOUNT,
      taskId: 'task-e2e',
      memoryIds: [binding.memoryId],
    });
    expect(materialized.failed).toEqual([]);
    const row = db.prepare('SELECT kind, content FROM task_execution_evidence WHERE task_id = ?')
      .get('task-e2e') as { kind: string; content: string };
    expect(row.kind).toBe('long_term_memory');
    expect(row.content).toContain('中文表格');
  }, 180_000);

  it('keeps the scope of one account separate from another account', async () => {
    const adapter = new TdaiMemoryAdapter({
      baseUrl: `http://127.0.0.1:${engine.port}`,
      serviceId: 'metawork',
      kernelAuthToken: engine.kernelAuthToken,
      timeoutMs: 20_000,
    });
    const other = deriveMemoryScope('account-b');
    const result = await adapter.search({ query: '中文表格', limit: 5 }, other);
    expect(result.items).toEqual([]);
  }, 60_000);
});
