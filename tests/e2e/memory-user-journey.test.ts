/**
 * User journey for long-term memory.
 *
 * These cases are written from the user's point of view:
 *   1. The user talks to MetaWork and states a preference.
 *   2. The preference is deposited and extracted by the memory engine.
 *   3. In a later session the system recalls it and the Executor receives it
 *      as evidence — never as a prompt injection.
 *   4. The user can disable one asset, and it stops reaching the Executor.
 *   5. The user can turn memory off completely; nothing runs and nothing is
 *      spent.
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
import { SubtaskExecutionContextBuilder } from '../../src/execution/subtask-execution-context.js';
import { buildEligibleContextRefKeys } from '../../src/work-graph/context-ref-eligibility.js';
import { resolveMemoryRuntimePolicy } from '../../src/memory/memory-runtime-policy.js';
import { startMockLlm, type MockLlm } from '../support/mock-llm-server.js';
import {
  resolveMemoryEngineRoot,
  startMemoryEngine,
  type MemoryEngineHandle,
} from '../support/memory-engine-harness.js';
import type { Subtask, Task } from '../../src/core/types.js';

const ACCOUNT = 'local-default';

const engineRoot = resolveMemoryEngineRoot();
const describeEngine = engineRoot ? describe : describe.skip;

describeEngine('long-term memory user journey', () => {
  let engine: MemoryEngineHandle;
  let llm: MockLlm;
  let db: Database.Database;

  beforeAll(async () => {
    llm = await startMockLlm();
    engine = await startMemoryEngine({ engineRoot: engineRoot!, llmBaseUrl: llm.baseUrl });

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    for (const taskId of ['task-session-1', 'task-session-2']) {
      db.prepare(`INSERT INTO tasks
        (id, title, goal, status, created_at, updated_at, account_id, conversation_id, workspace_id)
        VALUES (?, '销售报告', '整理销售数据', 'running', '2026-10-22T00:00:00.000Z',
          '2026-10-22T00:00:00.000Z', 'local-default', ?, 'ws-1')`).run(taskId, `conv-${taskId}`);
    }
  }, 180_000);

  afterAll(async () => {
    await engine?.stop();
    await llm?.close();
    db?.close();
  });

  /** Record one completed conversation turn, the way the Server stores it. */
  function recordTurn(conversationId: string, turnId: string, sequence: number, user: string, answer: string): void {
    const body = {
      id: turnId,
      conversationId,
      requestId: 'req-1',
      revision: 1,
      firstSequence: sequence,
      lastSequence: sequence,
      userInput: user,
      userInputRef: null,
      answer,
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
      .run(ACCOUNT, conversationId, `epoch-${conversationId}`, turnId, sequence, 1, 0, JSON.stringify(body), 100);
  }

  function buildStack() {
    const adapter = new TdaiMemoryAdapter({
      baseUrl: `http://127.0.0.1:${engine.port}`,
      serviceId: 'metawork',
      kernelAuthToken: engine.kernelAuthToken,
      timeoutMs: 20_000,
    });
    const bindings = new MemoryBindingsRepo(db);
    const service = new MemoryService({
      port: adapter,
      bindings,
      cursors: new MemoryFlushCursorRepo(db),
      turns: new SqliteMemoryTurnSource(db),
      thresholds: { idleAfterMs: 0, maxUnflushedTurns: 1 },
    });
    const recall = new MemoryRecallRepo(db);
    const evidence = new MemoryEvidenceService({
      resolveService: () => service,
      evidenceRepo: new TaskExecutionEvidenceRepo(db),
      maxStoredChars: 8_192,
    });
    return { adapter, bindings, service, recall, evidence };
  }

  /** What the Server does before a Planner turn: refresh the recall read model. */
  async function refreshRecall(
    stack: ReturnType<typeof buildStack>,
    conversationId: string,
    query: string,
  ): Promise<Array<{ memoryId: string; type: string; preview: string; score: number }>> {
    const result = await stack.service.search({ accountId: ACCOUNT, query, limit: 5 });
    const candidates = result.items.map(item => {
      const binding = stack.service.bind({
        accountId: ACCOUNT,
        tdaiMemoryId: item.id,
        workspaceId: 'ws-1',
        content: item.content,
      });
      return {
        memoryId: binding.memoryId,
        type: item.type,
        preview: item.content.slice(0, 240),
        score: item.score,
      };
    });
    stack.recall.replace({ accountId: ACCOUNT, conversationId, candidates });
    return candidates;
  }

  it('carries a stated preference from one session into a later session', async () => {
    const stack = buildStack();

    // Session 1: the user works with the assistant and states a durable rule.
    recordTurn('conv-task-session-1', 't1', 1, '帮我看下这份销售数据', '好的，数据概览已经整理出来了。');
    recordTurn('conv-task-session-1', 't2', 2, '以后都用中文表格输出', '明白，后续默认使用中文表格输出。');
    const flushed = await stack.service.flushConversation({
      accountId: ACCOUNT,
      conversationId: 'conv-task-session-1',
    });
    expect(flushed.flushed).toBe(4);
    expect(flushed.error).toBeUndefined();

    // The engine extracts the preference shortly after the deposit.
    let candidates: Array<{ memoryId: string; type: string; preview: string; score: number }> = [];
    for (let attempt = 0; attempt < 40 && candidates.length === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1_000));
      candidates = await refreshRecall(stack, 'conv-task-session-2', '中文表格');
    }
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.preview).toContain('中文表格');

    // Session 2: the Planner sees the candidate and references it.
    const eligible = buildEligibleContextRefKeys({
      db,
      sessionId: 'session-2',
      accountId: ACCOUNT,
      refs: [{ kind: 'memory', memoryId: candidates[0]!.memoryId }],
      targetTask: null,
      userInput: '再整理一份销售周报',
    });
    expect(eligible).toEqual([`memory:${candidates[0]!.memoryId}`]);

    // The Runtime materializes it and the Executor receives it as evidence.
    const materialized = await stack.evidence.materialize({
      accountId: ACCOUNT,
      taskId: 'task-session-2',
      memoryIds: [candidates[0]!.memoryId],
    });
    expect(materialized.failed).toEqual([]);

    const task: Task = {
      id: 'task-session-2', title: '销售报告', goal: '整理销售数据', status: 'running', summary: '',
      snapshots: [], resources: [], artifacts: [], dependencies: [],
      prioritySignals: { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
      injectedPreferences: [], lastSchedulingReason: '', lastInterruptionReason: '', interruptionCount: 0,
      createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
    };
    const subtask: Subtask = {
      id: 'subtask-session-2', taskId: task.id, title: '出周报', goal: '输出中文表格',
      status: 'running', graphRevision: 1, generationId: 'generation-2',
      dependencies: [], contextRefs: [{ kind: 'memory', memoryId: candidates[0]!.memoryId }],
      requiredCapabilities: ['workspace-engineering'], executorBindings: [], deliveryKind: 'report',
      acceptance: [{ key: 'done', description: 'done', requiredEvidence: [] }], riskLevel: 'low',
      result: '', artifacts: [], verification: { warnings: [], completionSchemaVersion: null }, error: null,
      createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
    };
    const built = new SubtaskExecutionContextBuilder(db, {
      accountId: ACCOUNT,
      resultRoot: '/tmp/metawork-memory-journey-results',
    }).build({
      executionId: 'exec-2', task, subtask, allSubtasks: [subtask],
      attemptId: 'attempt-2', workUnitId: 'wu-2', sessionId: 'session-2',
      workspaceContext: { allowFilesystem: true, workingDirectory: '/repo', targetPaths: ['/repo/out'] },
      evidenceToolsAvailable: true,
    });
    expect(built.context.selectedEvidence).toHaveLength(1);
    expect(built.context.selectedEvidence[0]!.content).toContain('中文表格');
    // The memory is evidence, not a prompt injection: it never appears in the
    // task background.
    expect(JSON.stringify(built.context.taskBackground)).not.toContain('中文表格');
  }, 180_000);

  it('stops delivering a memory the user disabled', async () => {
    const stack = buildStack();
    const candidates = await refreshRecall(stack, 'conv-task-session-2', '中文表格');
    expect(candidates.length).toBeGreaterThan(0);
    const target = candidates[0]!.memoryId;

    stack.bindings.setEnabled(target, ACCOUNT, false);

    const eligible = buildEligibleContextRefKeys({
      db,
      sessionId: 'session-3',
      accountId: ACCOUNT,
      refs: [{ kind: 'memory', memoryId: target }],
      targetTask: null,
      userInput: '再整理一份销售周报',
    });
    expect(eligible).toEqual([]);

    const materialized = await stack.evidence.materialize({
      accountId: ACCOUNT,
      taskId: 'task-session-2',
      memoryIds: [target],
    });
    expect(materialized.failed).toHaveLength(1);
    expect(materialized.failed[0]?.reason).toMatch(/memory_not_authorized/u);
  }, 120_000);

  it('runs nothing and spends nothing when memory is switched off', () => {
    const configuration = {
      schemaVersion: 2 as const,
      providers: {},
      models: {},
      harnesses: {},
      agentClasses: {},
      permissionProfiles: {},
      runtimePolicy: { maxConcurrentAttempts: 2, maxConcurrentAttemptsPerTask: 1 },
      gateway: {},
      memory: { enabled: false },
    };
    const policy = resolveMemoryRuntimePolicy(configuration);
    expect(policy.mode).toBe('disabled');
    expect(policy.providerRef).toBeNull();
    expect(policy.modelId).toBeNull();
    // A disabled memory never reaches the engine, so no request is made.
    expect(policy.baseUrl).toBeNull();
  });
});
