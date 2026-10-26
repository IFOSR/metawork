import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { SubtaskExecutionContextBuilder } from '../../src/execution/subtask-execution-context.js';
import { TaskExecutionEvidenceRepo } from '../../src/execution/execution-evidence-port.js';
import { MemoryEvidenceService } from '../../src/memory/memory-evidence-service.js';
import { MemoryService } from '../../src/memory/memory-service.js';
import { MemoryBindingsRepo } from '../../src/storage/memory-bindings-repo.js';
import { MemoryFlushCursorRepo } from '../../src/storage/memory-flush-cursor-repo.js';
import { SqliteMemoryTurnSource } from '../../src/storage/memory-turn-source.js';
import { buildEligibleContextRefKeys } from '../../src/work-graph/context-ref-eligibility.js';
import type { MemoryPort } from '../../src/memory/memory-port.js';
import type { Subtask, Task } from '../../src/core/types.js';

const ACCOUNT = 'local-default';

class EngineStub implements MemoryPort {
  body = '用户要求以后都用中文表格输出。';
  async health() { return { ready: true, ftsAvailable: true }; }
  async deposit() { return { accepted: 0 }; }
  async search() { return { items: [], degraded: false }; }
  async materialize() {
    return {
      id: 'tdai-1', type: 'instruction', content: this.body, background: null,
      createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
    };
  }
  async listAssets() { return { items: [], total: 0 }; }
  async updateAsset() { return { memoryId: 'tdai-1', version: 'v2' }; }
  async deleteAsset() { return { deleted: true }; }
  async readPersona() { return { content: null, updatedAt: null }; }
}

function createDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`
    INSERT INTO tasks (
      id, title, goal, status, summary, snapshot_json, resources_json, artifacts_json,
      dependencies_json, priority_json, last_scheduling_reason,
      last_interruption_reason, interruption_count, created_at, updated_at
    ) VALUES ('task_memory', '销售报告', '整理销售数据', 'running', '', '[]', '[]', '[]', '[]', '{}', '', '', 0, ?, ?)
  `).run('2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z');
  return db;
}

function subtask(refs: Subtask['contextRefs']): Subtask {
  return {
    id: 'subtask_memory', taskId: 'task_memory', title: '出报告', goal: '输出中文表格',
    status: 'running', graphRevision: 1, generationId: 'generation_memory',
    dependencies: [], contextRefs: refs, requiredCapabilities: ['workspace-engineering'],
    executorBindings: [], deliveryKind: 'report',
    acceptance: [{ key: 'done', description: 'done', requiredEvidence: [] }], riskLevel: 'low',
    result: '', artifacts: [], verification: { warnings: [], completionSchemaVersion: null }, error: null,
    createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
  };
}

const task: Task = {
  id: 'task_memory', title: '销售报告', goal: '整理销售数据', status: 'running', summary: '',
  snapshots: [], resources: [], artifacts: [], dependencies: [],
  prioritySignals: { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
  lastSchedulingReason: '', lastInterruptionReason: '', interruptionCount: 0,
  createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
};

describe('memory evidence delivery end to end', () => {
  it('delivers a referenced memory to the Executor through the evidence channel', async () => {
    const db = createDb();
    const port = new EngineStub();
    const bindings = new MemoryBindingsRepo(db);
    const binding = bindings.upsert({
      tdaiMemoryId: 'tdai-1',
      accountId: ACCOUNT,
      workspaceId: 'ws-1',
    });
    const service = new MemoryService({
      port,
      bindings,
      cursors: new MemoryFlushCursorRepo(db),
      turns: new SqliteMemoryTurnSource(db),
    });
    const evidenceRepo = new TaskExecutionEvidenceRepo(db);
    const evidence = new MemoryEvidenceService({ resolveService: () => service, evidenceRepo, maxStoredChars: 8_192 });

    const refs = [{ kind: 'memory' as const, memoryId: binding.memoryId }];
    const eligible = buildEligibleContextRefKeys({
      db,
      sessionId: 'session-1',
      accountId: ACCOUNT,
      refs,
      targetTask: task,
      userInput: '整理销售数据',
    });
    expect(eligible).toEqual([`memory:${binding.memoryId}`]);

    const materialized = await evidence.materialize({
      accountId: ACCOUNT,
      taskId: task.id,
      memoryIds: [binding.memoryId],
    });
    expect(materialized.failed).toEqual([]);

    const built = new SubtaskExecutionContextBuilder(db, {
      accountId: ACCOUNT,
      resultRoot: '/tmp/metawork-memory-results',
    }).build({
      executionId: 'exec', task, subtask: subtask(refs), allSubtasks: [subtask(refs)],
      attemptId: 'attempt-1', workUnitId: 'wu-1', sessionId: 'session-1',
      workspaceContext: { allowFilesystem: true, workingDirectory: '/repo', targetPaths: ['/repo/out'] },
      evidenceToolsAvailable: true,
    });

    const selected = built.context.selectedEvidence;
    expect(selected).toHaveLength(1);
    expect(selected[0]!.content).toBe('用户要求以后都用中文表格输出。');
    expect(selected[0]!.ref).toEqual({ kind: 'memory', memoryId: binding.memoryId });
    expect(selected[0]!.truncated).toBe(false);

    // The evidence tool exposes it for on-demand paging.
    const page = built.evidenceCapability.list({});
    expect(page.items.some(item => item.kind === 'long_term_memory')).toBe(true);
  });

  it('fails the attempt explicitly when the memory was never materialized', () => {
    const db = createDb();
    const bindings = new MemoryBindingsRepo(db);
    const binding = bindings.upsert({ tdaiMemoryId: 'tdai-1', accountId: ACCOUNT });
    const refs = [{ kind: 'memory' as const, memoryId: binding.memoryId }];
    expect(() => new SubtaskExecutionContextBuilder(db, {
      accountId: ACCOUNT,
      resultRoot: '/tmp/metawork-memory-results',
    }).build({
      executionId: 'exec', task, subtask: subtask(refs), allSubtasks: [subtask(refs)],
      attemptId: 'attempt-1', workUnitId: 'wu-1', sessionId: 'session-1',
      workspaceContext: { allowFilesystem: true, workingDirectory: '/repo', targetPaths: ['/repo/out'] },
      evidenceToolsAvailable: true,
    })).toThrow(/memory_not_authorized/u);
  });

  it('never delivers a memory of another account', async () => {
    const db = createDb();
    const port = new EngineStub();
    const bindings = new MemoryBindingsRepo(db);
    const binding = bindings.upsert({ tdaiMemoryId: 'tdai-1', accountId: 'account-b' });
    const service = new MemoryService({
      port,
      bindings,
      cursors: new MemoryFlushCursorRepo(db),
      turns: new SqliteMemoryTurnSource(db),
    });
    const evidence = new MemoryEvidenceService({
      resolveService: () => service,
      evidenceRepo: new TaskExecutionEvidenceRepo(db),
      maxStoredChars: 8_192,
    });
    const result = await evidence.materialize({
      accountId: ACCOUNT,
      taskId: task.id,
      memoryIds: [binding.memoryId],
    });
    expect(result.materialized).toEqual([]);
    expect(result.failed).toHaveLength(1);
  });

  it('keeps the per-evidence budget of 4000 characters', async () => {
    const db = createDb();
    const port = new EngineStub();
    port.body = 'x'.repeat(20_000);
    const bindings = new MemoryBindingsRepo(db);
    const binding = bindings.upsert({ tdaiMemoryId: 'tdai-1', accountId: ACCOUNT });
    const service = new MemoryService({
      port,
      bindings,
      cursors: new MemoryFlushCursorRepo(db),
      turns: new SqliteMemoryTurnSource(db),
    });
    const evidenceRepo = new TaskExecutionEvidenceRepo(db);
    const evidence = new MemoryEvidenceService({ resolveService: () => service, evidenceRepo, maxStoredChars: 8_192 });
    const refs = [{ kind: 'memory' as const, memoryId: binding.memoryId }];
    await evidence.materialize({ accountId: ACCOUNT, taskId: task.id, memoryIds: [binding.memoryId] });
    const built = new SubtaskExecutionContextBuilder(db, {
      accountId: ACCOUNT,
      resultRoot: '/tmp/metawork-memory-results',
    }).build({
      executionId: 'exec', task, subtask: subtask(refs), allSubtasks: [subtask(refs)],
      attemptId: 'attempt-1', workUnitId: 'wu-1', sessionId: 'session-1',
      workspaceContext: { allowFilesystem: true, workingDirectory: '/repo', targetPaths: ['/repo/out'] },
      evidenceToolsAvailable: true,
    });
    const selected = built.context.selectedEvidence[0]!;
    expect(selected.content.length).toBeLessThanOrEqual(4_000);
    expect(selected.truncated).toBe(true);
    expect(selected.content).toContain('[TRUNCATED');
  });
});
