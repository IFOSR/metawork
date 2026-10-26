/**
 * User-perspective acceptance for long-term memory (ADR-0049).
 *
 * This is the closest automated equivalent to a person using MetaWork:
 * every case is phrased as a user-visible outcome, and the whole session is
 * driven through the same seams production uses — the real schema migrations,
 * the real MemoryService scheduler, the real adapter against a real TDAI
 * MemoryCore sidecar, the real Planner read model, the real ContextRef
 * eligibility check and the real execution-context builder.
 *
 * Run it on its own with `npm run test:memory-e2e`.
 *
 * The engine checkout is discovered from `METAWORK_MEMORY_SIDECAR_DIR` or the
 * repository-local `.tmp/tdai/MemoryCore`. Without it the suite skips rather
 * than failing, so a machine without the engine sources stays green.
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
import { MemoryFlushScheduler } from '../../src/memory/memory-flush-scheduler.js';
import { MemorySanitizer } from '../../src/memory/memory-sanitizer.js';
import { TaskExecutionEvidenceRepo } from '../../src/execution/execution-evidence-port.js';
import { SubtaskExecutionContextBuilder } from '../../src/execution/subtask-execution-context.js';
import { buildEligibleContextRefKeys } from '../../src/work-graph/context-ref-eligibility.js';
import { deriveMemoryScope } from '../../src/memory/memory-scope.js';
import { PlannerDataReader } from '../../src/planning/planner-mcp-server.js';
import { startMockLlm, type MockLlm } from '../support/mock-llm-server.js';
import {
  resolveMemoryEngineRoot,
  startMemoryEngine,
  type MemoryEngineHandle,
} from '../support/memory-engine-harness.js';
import type { Subtask, Task } from '../../src/core/types.js';

const ACCOUNT = 'local-default';
const SESSION_ONE = 'conv-session-1';
const SESSION_TWO = 'conv-session-2';

const engineRoot = resolveMemoryEngineRoot();
const describeAcceptance = engineRoot ? describe : describe.skip;

describeAcceptance('long-term memory acceptance (user perspective)', () => {
  let engine: MemoryEngineHandle;
  let llm: MockLlm;
  let db: Database.Database;
  let service: MemoryService;
  let bindings: MemoryBindingsRepo;
  let cursors: MemoryFlushCursorRepo;
  let recall: MemoryRecallRepo;
  let evidence: MemoryEvidenceService;
  let adapter: TdaiMemoryAdapter;

  beforeAll(async () => {
    llm = await startMockLlm();
    engine = await startMemoryEngine({ engineRoot: engineRoot!, llmBaseUrl: llm.baseUrl });

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    adapter = new TdaiMemoryAdapter({
      baseUrl: `http://127.0.0.1:${engine.port}`,
      serviceId: 'metawork',
      kernelAuthToken: engine.kernelAuthToken,
      timeoutMs: 20_000,
    });
    bindings = new MemoryBindingsRepo(db);
    cursors = new MemoryFlushCursorRepo(db);
    service = new MemoryService({
      port: adapter,
      bindings,
      cursors,
      turns: new SqliteMemoryTurnSource(db),
      sanitizer: new MemorySanitizer(),
      thresholds: { idleAfterMs: 0, maxUnflushedTurns: 1 },
    });
    recall = new MemoryRecallRepo(db);
    evidence = new MemoryEvidenceService({
      resolveService: () => service,
      evidenceRepo: new TaskExecutionEvidenceRepo(db),
      maxStoredChars: 8_192,
    });
  }, 180_000);

  afterAll(async () => {
    await engine?.stop();
    await llm?.close();
    db?.close();
  });

  /** A completed turn, recorded the way the Server records it. */
  function recordTurn(input: {
    conversationId: string;
    turnId: string;
    sequence: number;
    userInput: string;
    answer: string;
    status?: string;
  }): void {
    const body = {
      id: input.turnId,
      conversationId: input.conversationId,
      requestId: 'req-1',
      revision: 1,
      firstSequence: input.sequence,
      lastSequence: input.sequence,
      userInput: input.userInput,
      userInputRef: null,
      answer: input.answer,
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
      completedAt: '2026-10-22T00:01:00.000Z',
      interactionKind: 'ai_turn',
    };
    db.prepare(`INSERT INTO conversation_read_turns
      (account_id, conversation_id, epoch, turn_id, first_sequence, revision, active, body_json, byte_length)
      VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`)
      .run(ACCOUNT, input.conversationId, `epoch-${input.conversationId}`, input.turnId,
        input.sequence, JSON.stringify(body), 100);
  }

  function task(id: string, conversationId: string): Task {
    db.prepare(`INSERT INTO tasks
      (id, title, goal, status, created_at, updated_at, account_id, conversation_id, workspace_id)
      VALUES (?, '销售周报', '整理销售数据', 'running', '2026-10-22T00:00:00.000Z',
        '2026-10-22T00:00:00.000Z', 'local-default', ?, 'ws-1')`).run(id, conversationId);
    return {
      id, title: '销售周报', goal: '整理销售数据', status: 'running', summary: '',
      snapshots: [], resources: [], artifacts: [], dependencies: [],
      prioritySignals: { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
      injectedPreferences: [], lastSchedulingReason: '', lastInterruptionReason: '', interruptionCount: 0,
      createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
    };
  }

  function subtask(taskId: string, memoryId: string): Subtask {
    return {
      id: `subtask-${taskId}`, taskId, title: '出周报', goal: '输出中文表格',
      status: 'running', graphRevision: 1, generationId: `generation-${taskId}`,
      dependencies: [], contextRefs: [{ kind: 'memory', memoryId }],
      requiredCapabilities: ['workspace-engineering'], executorBindings: [], deliveryKind: 'report',
      acceptance: [{ key: 'done', description: 'done', requiredEvidence: [] }], riskLevel: 'low',
      result: '', artifacts: [], verification: { warnings: [], completionSchemaVersion: null }, error: null,
      createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
    };
  }

  /** Wait for the engine to finish extraction after a deposit. */
  async function recallEventually(query: string): Promise<Array<{ id: string; type: string; content: string; score: number }>> {
    for (let attempt = 0; attempt < 40; attempt++) {
      const result = await service.search({ accountId: ACCOUNT, query, limit: 5 });
      if (result.items.length > 0) return [...result.items];
      await new Promise(done => setTimeout(done, 1_000));
    }
    return [];
  }

  it('schema migrations install the memory index', () => {
    const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    expect(version).toBeGreaterThanOrEqual(52);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memory_%' ORDER BY name")
      .all() as Array<{ name: string }>).map(row => row.name);
    expect(tables).toContain('memory_bindings');
    expect(tables).toContain('memory_recall_candidates');
  });

  it('keeps the memory index free of memory bodies', () => {
    const columns = (db.prepare('PRAGMA table_info(memory_bindings)').all() as Array<{ name: string }>)
      .map(column => column.name);
    expect(columns).toContain('content_digest');
    // No column can hold the body: the engine is the only body owner.
    expect(columns).not.toContain('content');
    expect(columns).not.toContain('body');
  });

  it('remembers a preference the user stated once and recalls it later', async () => {
    recordTurn({ conversationId: SESSION_ONE, turnId: 't1', sequence: 1,
      userInput: '帮我看下这份销售数据', answer: '好的，数据概览已经整理出来了。' });
    recordTurn({ conversationId: SESSION_ONE, turnId: 't2', sequence: 2,
      userInput: '那把华东区单独拆出来', answer: '华东区单独拆分如下。' });
    recordTurn({ conversationId: SESSION_ONE, turnId: 't3', sequence: 3,
      userInput: '以后都用中文表格输出', answer: '明白，后续默认使用中文表格输出。' });

    const scheduler = new MemoryFlushScheduler({ service, accountId: ACCOUNT, intervalMs: 60_000 });
    await scheduler.tick();
    expect(scheduler.status.lastError).toBeNull();
    expect(cursors.lastSequence(ACCOUNT, SESSION_ONE)).toBeGreaterThan(0);

    const items = await recallEventually('中文表格');
    expect(items.length).toBeGreaterThan(0);
    expect(items.some(item => item.content.includes('中文表格'))).toBe(true);
  }, 120_000);

  it('does not remember a cancelled round', async () => {
    recordTurn({ conversationId: SESSION_ONE, turnId: 't4', sequence: 4,
      userInput: '这次先不看了', answer: '已取消本次任务。', status: 'cancelled' });
    const outcome = await service.flushConversation({
      accountId: ACCOUNT, conversationId: SESSION_ONE, force: true,
    });
    expect(outcome.error).toBeUndefined();
    const cancelled = await service.search({ accountId: ACCOUNT, query: '这次先不看了', limit: 5 });
    expect(cancelled.items.some(item => item.content.includes('这次先不看了'))).toBe(false);
  }, 60_000);

  it('shows the Planner a bounded preview and no credential', async () => {
    const items = await recallEventually('中文表格');
    expect(items.length).toBeGreaterThan(0);
    const bound = items.map(item => bindings.upsert({
      tdaiMemoryId: item.id,
      accountId: ACCOUNT,
      workspaceId: 'ws-1',
      content: item.content,
    }));
    recall.replace({
      accountId: ACCOUNT,
      conversationId: SESSION_TWO,
      candidates: items.map((item, index) => ({
        memoryId: bound[index]!.memoryId,
        type: item.type,
        preview: item.content.slice(0, 240),
        score: item.score,
      })),
    });

    const reader = new PlannerDataReader(
      db, 'session-2', () => ({ capabilities: [], agents: [] }) as never,
      SESSION_TWO, () => [], ACCOUNT, [],
    );
    const plannerView = reader.searchMemory({});
    expect(plannerView.count).toBeGreaterThan(0);
    expect(plannerView.items[0]!.preview.length).toBeLessThanOrEqual(240);
    expect(JSON.stringify(plannerView)).not.toContain(engine.kernelAuthToken);
    expect(reader.listMemoryAssets().count).toBeGreaterThan(0);
  }, 60_000);

  it('delivers the remembered preference to the Executor as evidence in a later session', async () => {
    const items = await recallEventually('中文表格');
    const binding = bindings.findByTdaiMemoryId(items[0]!.id);
    expect(binding).not.toBeNull();

    const target = task('task-session-2', SESSION_TWO);
    const eligible = buildEligibleContextRefKeys({
      db, sessionId: 'session-2', accountId: ACCOUNT,
      refs: [{ kind: 'memory', memoryId: binding!.memoryId }],
      targetTask: target, userInput: '再整理一份销售周报',
    });
    expect(eligible).toEqual([`memory:${binding!.memoryId}`]);

    const materialized = await evidence.materialize({
      accountId: ACCOUNT, taskId: target.id, memoryIds: [binding!.memoryId],
    });
    expect(materialized.failed).toEqual([]);

    const built = new SubtaskExecutionContextBuilder(db, {
      accountId: ACCOUNT, resultRoot: `${engine.dataDir}/results`,
    }).build({
      executionId: 'exec-2', task: target, subtask: subtask(target.id, binding!.memoryId),
      allSubtasks: [subtask(target.id, binding!.memoryId)],
      attemptId: 'attempt-2', workUnitId: 'wu-2', sessionId: 'session-2',
      workspaceContext: { allowFilesystem: true, workingDirectory: '/repo', targetPaths: ['/repo/out'] },
      evidenceToolsAvailable: true,
    });

    expect(built.context.selectedEvidence).toHaveLength(1);
    expect(built.context.selectedEvidence[0]!.content).toContain('中文表格');
    // Pull semantics: the memory is evidence, never a background/prompt injection.
    expect(JSON.stringify(built.context.taskBackground)).not.toContain('中文表格');
    expect(built.context.selectedEvidence[0]!.content.length).toBeLessThanOrEqual(4_000);
    expect(built.evidenceCapability.list({}).items.some(item => item.kind === 'long_term_memory')).toBe(true);
  }, 60_000);

  it('stops delivering a memory as soon as the user disables it', async () => {
    const items = await recallEventually('中文表格');
    const binding = bindings.findByTdaiMemoryId(items[0]!.id)!;
    expect(service.setEnabled({ accountId: ACCOUNT, memoryId: binding.memoryId, enabled: false }))
      .not.toBeNull();

    expect(buildEligibleContextRefKeys({
      db, sessionId: 'session-3', accountId: ACCOUNT,
      refs: [{ kind: 'memory', memoryId: binding.memoryId }],
      targetTask: null, userInput: '再整理一份销售周报',
    })).toEqual([]);

    const refused = await evidence.materialize({
      accountId: ACCOUNT, taskId: 'task-session-3', memoryIds: [binding.memoryId],
    });
    expect(refused.materialized).toEqual([]);
    expect(refused.failed[0]?.reason).toMatch(/memory_not_authorized/u);

    // Re-binding must not silently undo the user's decision.
    const rebound = service.bind({ accountId: ACCOUNT, tdaiMemoryId: binding.tdaiMemoryId });
    expect(rebound.enabled).toBe(false);
    expect(service.setEnabled({ accountId: ACCOUNT, memoryId: binding.memoryId, enabled: true }))
      .not.toBeNull();
  }, 60_000);

  it('never shares memory with another account', async () => {
    const other = await adapter.search({ query: '中文表格', limit: 5 }, deriveMemoryScope('account-b'));
    expect(other.items).toEqual([]);
  }, 60_000);

  it('redacts a pasted secret instead of storing it', () => {
    const sanitized = new MemorySanitizer().sanitize('我的 key 是 sk-abcdefgh12345678 请记下来');
    expect(sanitized.content).not.toContain('sk-abcdefgh12345678');
    expect(sanitized.content).toContain('[REDACTED]');
  });

  it('degrades to an empty recall instead of failing when the engine dies', async () => {
    await engine.stop();
    await new Promise(done => setTimeout(done, 1_500));
    const degraded = await service.search({ accountId: ACCOUNT, query: '中文表格', limit: 5 });
    expect(degraded.degraded).toBe(true);
    expect(degraded.items).toEqual([]);
    const flush = await service.flushConversation({
      accountId: ACCOUNT, conversationId: SESSION_ONE, force: true,
    });
    expect(flush.flushed).toBe(0);
  }, 60_000);
});
