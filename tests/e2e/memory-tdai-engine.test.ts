import { seedAuthoritativeTurn } from '../support/conversation-turn-fixture.js';
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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { MemoryService } from '../../src/memory/memory-service.js';
import { TdaiMemoryAdapter } from '../../src/memory/tdai-memory-adapter.js';
import { MemoryBindingsRepo } from '../../src/storage/memory-bindings-repo.js';
import { MemoryFlushCursorRepo } from '../../src/storage/memory-flush-cursor-repo.js';
import { SqliteMemoryTurnSource } from '../../src/storage/memory-turn-source.js';
import { MemoryRecallRepo } from '../../src/storage/memory-recall-repo.js';
import { buildEligibleContextRefKeys } from '../../src/work-graph/context-ref-eligibility.js';
import { SubtaskExecutionContextBuilder } from '../../src/execution/subtask-execution-context.js';
import type { Subtask, Task } from '../../src/core/types.js';
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
      seedAuthoritativeTurn(db, ACCOUNT, CONVERSATION, body);
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
    expect(outcome.flushed).toBeGreaterThan(0);
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
    await expect(adapter.search({ query: '中文表格', limit: 5 }, other))
      .rejects.toThrow(/memory_scope_mismatch/u);
  }, 60_000);

  it('round-trips scoped L2 scenes and L3 persona with stable revisions', async () => {
    const scope = deriveMemoryScope(ACCOUNT);
    const adapter = new TdaiMemoryAdapter({
      baseUrl: `http://127.0.0.1:${engine.port}`,
      serviceId: 'metawork',
      kernelAuthToken: engine.kernelAuthToken,
      timeoutMs: 20_000,
    });
    const dataDir = join(engine.dataDir, 'data');
    mkdirSync(join(dataDir, 'scene_blocks'), { recursive: true });
    mkdirSync(join(dataDir, '.metadata'), { recursive: true });
    writeFileSync(join(dataDir, 'scene_blocks', 'weekly-report.md'), [
      '-----META-START-----', 'created: 2026-11-01', 'updated: 2026-11-01',
      'summary: 制作周报和管理汇报', 'heat: 4', '-----META-END-----', '',
      '周报经验正文：先给管理者结论，再列本周指标。',
    ].join('\n'));
    writeFileSync(join(dataDir, '.metadata', 'scene_index.json'), JSON.stringify([{
      filename: 'weekly-report.md', summary: '制作周报和管理汇报', heat: 4,
      created: '2026-11-01', updated: '2026-11-01',
    }]));
    writeFileSync(join(dataDir, 'persona.md'), '默认使用中文，面向管理者简洁汇报。\n\n---\n## 🗺️ Scene Navigation (Scene Index)\ninternal navigation\n');

    const scenes = await adapter.searchScenarios!({ query: '制作周报', limit: 3 }, scope);
    expect(scenes.degraded).toBe(false);
    expect(scenes.items).toHaveLength(1);
    expect(scenes.items[0]!.preview).toContain('制作周报');
    const scene = await adapter.materialize(scenes.items[0]!.id, scope, 'l2');
    expect(scene.content).toContain('周报经验正文');
    expect(scene.revision).toBe(scenes.items[0]!.revision);

    const persona = await adapter.readPersona(scope);
    expect(persona.content).toContain('面向管理者');
    expect(persona.content).not.toContain('internal navigation');
    expect(persona.id).toMatch(/^tdai:l3:/u);
    const materializedPersona = await adapter.materialize(persona.id!, scope, 'l3');
    expect(materializedPersona.revision).toBe(persona.revision);
    expect(materializedPersona.content).toBe(persona.content);

    const bindings = new MemoryBindingsRepo(db);
    const service = new MemoryService({
      port: adapter,
      bindings,
      cursors: new MemoryFlushCursorRepo(db),
      turns: new SqliteMemoryTurnSource(db),
    });
    const sceneBinding = service.bind({
      accountId: ACCOUNT, tdaiMemoryId: scene.id, layer: 'l2', revision: scene.revision,
      title: scene.title, content: scene.content,
    });
    const personaBinding = service.bind({
      accountId: ACCOUNT, tdaiMemoryId: persona.id!, layer: 'l3', revision: persona.revision,
      title: 'User persona', content: persona.content,
    });
    const recall = new MemoryRecallRepo(db);
    recall.replace({ accountId: ACCOUNT, conversationId: CONVERSATION, candidates: [
      { memoryId: sceneBinding.memoryId, type: 'scene', title: scene.title, layer: 'l2',
        preview: scenes.items[0]!.preview, revision: scene.revision, source: 'profile', score: 1 },
      { memoryId: personaBinding.memoryId, type: 'persona', title: 'User persona', layer: 'l3',
        preview: persona.content!, revision: persona.revision!, source: 'profile', score: 1 },
    ] });
    const refs = [
      { kind: 'memory' as const, memoryId: sceneBinding.memoryId, revision: scene.revision },
      { kind: 'memory' as const, memoryId: personaBinding.memoryId, revision: persona.revision! },
    ];
    const eligible = buildEligibleContextRefKeys({
      db, sessionId: 'session-memory-e2e', conversationId: CONVERSATION, accountId: ACCOUNT,
      refs, targetTask: null, userInput: '制作周报',
    });
    expect(eligible).toEqual([
      `memory:${sceneBinding.memoryId}:${scene.revision}`,
      `memory:${personaBinding.memoryId}:${persona.revision}`,
    ]);
    const evidence = new MemoryEvidenceService({
      resolveService: () => service,
      evidenceRepo: new TaskExecutionEvidenceRepo(db),
      recallRepo: recall,
      maxStoredChars: 8_192,
    });
    const delivered = await evidence.materialize({
      accountId: ACCOUNT, taskId: 'task-e2e', conversationId: CONVERSATION,
      memoryIds: refs.map(ref => ({ memoryId: ref.memoryId, revision: ref.revision })),
    });
    expect(delivered.failed).toEqual([]);
    expect(delivered.materialized).toHaveLength(2);
    const rows = db.prepare(`SELECT source_id, content FROM task_execution_evidence
      WHERE task_id = 'task-e2e' AND kind = 'long_term_memory'
        AND (source_id LIKE 'l2:%' OR source_id LIKE 'l3:%') ORDER BY source_id`).all() as Array<{
        source_id: string; content: string;
      }>;
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.source_id.startsWith('l2:'))?.content).toContain('周报经验正文');
    expect(rows.find(row => row.source_id.startsWith('l3:'))?.content).toContain('面向管理者');

    const executionTask = {
      id: 'task-e2e', title: '周报任务', goal: '制作周报', status: 'running', summary: '',
      snapshots: [], resources: [], artifacts: [], dependencies: [],
      prioritySignals: { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
      lastSchedulingReason: '', lastInterruptionReason: '', interruptionCount: 0,
      createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    } as unknown as Task;
    const executionSubtask = {
      id: 'subtask-e2e', taskId: executionTask.id, title: '起草周报', goal: '依据场景经验与用户画像制作周报',
      status: 'running', graphRevision: 1, generationId: 'generation-e2e', dependencies: [], contextRefs: refs,
      requiredCapabilities: ['workspace-engineering'], executorBindings: [], deliveryKind: 'report',
      acceptance: [{ key: 'done', description: '完成周报', requiredEvidence: [] }], riskLevel: 'low',
      result: '', artifacts: [], verification: { warnings: [], completionSchemaVersion: null }, error: null,
      createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    } as unknown as Subtask;
    const executionContext = new SubtaskExecutionContextBuilder(db, {
      accountId: ACCOUNT, resultRoot: '/tmp/metawork-memory-layered-e2e',
    }).build({
      executionId: 'exec-e2e', task: executionTask, subtask: executionSubtask, allSubtasks: [executionSubtask],
      attemptId: 'attempt-e2e', workUnitId: 'work-unit-e2e', sessionId: 'session-memory-e2e',
      workspaceContext: { allowFilesystem: true, workingDirectory: '/repo', targetPaths: ['/repo/out'] },
      evidenceToolsAvailable: true,
    });
    expect(executionContext.context.selectedEvidence).toHaveLength(2);
    expect(executionContext.context.selectedEvidence.map(item => item.content).join('\n'))
      .toContain('周报经验正文');
    expect(executionContext.context.selectedEvidence.map(item => item.content).join('\n'))
      .toContain('面向管理者');

    writeFileSync(join(dataDir, 'scene_blocks', 'weekly-report.md'), [
      '-----META-START-----', 'created: 2026-11-01', 'updated: 2026-11-01',
      'summary: 制作周报和管理汇报', 'heat: 4', '-----META-END-----', '',
      '已修改的周报经验正文。',
    ].join('\n'));
    const changed = await evidence.materialize({
      accountId: ACCOUNT, taskId: 'task-e2e', conversationId: CONVERSATION,
      memoryIds: [{ memoryId: sceneBinding.memoryId, revision: scene.revision }],
    });
    expect(changed.materialized).toEqual([]);
    expect(changed.failed[0]?.reason).toContain('memory_revision_changed');
  }, 60_000);
});
