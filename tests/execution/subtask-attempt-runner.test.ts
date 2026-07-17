import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { WorkUnitRepo } from '../../src/storage/work-unit-repo.js';
import { WorkUnitClaimService } from '../../src/execution/work-unit-claim-service.js';
import { SubtaskAttemptRunner } from '../../src/execution/subtask-attempt-runner.js';
import { COMPLETION_MARKER_V1 } from '../../src/execution/completion-protocol.js';
import { getBuiltinExecutorAgentClasses } from '../../src/executor/builtin-executor-catalog.js';
import { AgentClassRepo } from '../../src/storage/agent-class-repo.js';
import type { Subtask, Task } from '../../src/core/types.js';

function task(): Task {
  return {
    id: 'task_phase2', title: 'Phase 2', goal: 'complete the graph', status: 'running', summary: '',
    snapshots: [], resources: [], artifacts: [], dependencies: [],
    prioritySignals: { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
    injectedPreferences: [], lastSchedulingReason: '', lastInterruptionReason: '', interruptionCount: 0,
    createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
  };
}

function node(id: string, dependencies: Subtask['dependencies'] = []): Subtask {
  return {
    id, taskId: 'task_phase2', title: id, goal: `complete ${id}`, status: 'ready',
    dependencies, contextRefs: [], requiredCapabilities: ['workspace-engineering'],
    preferredAgentClassList: ['codex-cli'], expectedOutput: 'summary',
    acceptance: [{ key: 'done', description: 'done', requiredEvidence: [] }], riskLevel: 'low',
    result: '', artifacts: [], verification: { warnings: [], completionSchemaVersion: null }, error: null,
    createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
  };
}

function setup(rawResponse: string) {
  const db = new Database(':memory:');
  runMigrations(db);
  db.prepare(`
    INSERT INTO tasks (
      id, title, goal, status, summary, snapshot_json, resources_json, artifacts_json,
      dependencies_json, priority_json, injected_prefs_json, last_scheduling_reason,
      last_interruption_reason, interruption_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '', '[]', '[]', '[]', '[]', '{}', '[]', '', '', 0, ?, ?)
  `).run('task_phase2', 'Phase 2', 'complete the graph', 'running', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z');
  const subtaskRepo = new SubtaskRepo(db);
  new AgentClassRepo(db).upsert(
    getBuiltinExecutorAgentClasses().find(item => item.name === 'codex-cli')!,
  );
  const a = node('task_phase2_a');
  const b = node('task_phase2_b', [{
    fromSubtaskId: a.id,
    requiredItems: [{ key: 'summary', type: 'text', description: 'A summary' }],
  }]);
  subtaskRepo.upsert(a);
  subtaskRepo.upsert(b);
  const workUnitRepo = new WorkUnitRepo(db);
  workUnitRepo.upsert({
    id: 'executor-codex', agentClassName: 'codex-cli', agentClassKind: 'executor', state: 'idle',
    claimedTaskId: null, claimedSubtaskId: null, claimedAttemptId: null,
    heartbeatAt: null, leaseExpiresAt: null,
    createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
  });
  const executionRuntime = {
    run: vi.fn().mockResolvedValue({
      taskId: 'task_phase2', executionId: 'exec_1', status: 'success', executorName: 'codex-cli',
      output: rawResponse, error: null, artifacts: [], subtaskResults: [], durationMs: 10,
    }),
  };
  const runner = new SubtaskAttemptRunner({
    db,
    sessionId: 'session_1',
    taskRuntimeService: { findTask: vi.fn().mockReturnValue(task()) } as never,
    subtaskRepo,
    workUnitClaimService: new WorkUnitClaimService(workUnitRepo),
    executionRuntime: executionRuntime as never,
    agentClassService: { listAgentClasses: () => getBuiltinExecutorAgentClasses() } as never,
  });
  return { db, runner, subtaskRepo, workUnitRepo, executionRuntime, a, b };
}

function validResponse(): string {
  return `A completed.\n\n${COMPLETION_MARKER_V1}\n${JSON.stringify({
    schemaVersion: 1,
    subtaskId: 'task_phase2_a',
    acceptanceEvidence: [{ key: 'done', evidence: ['verified A'] }],
    artifacts: [],
    handoffs: [{ toSubtaskId: 'task_phase2_b', items: [{ key: 'summary', type: 'text', value: 'A completed' }] }],
  })}`;
}

describe('SubtaskAttemptRunner', () => {
  it('atomically commits clean body, receipt and immutable handoff then releases the claim', async () => {
    const setupResult = setup(validResponse());
    const outcome = await setupResult.runner.run({
      executionId: 'exec_1', taskId: 'task_phase2', subtaskId: setupResult.a.id,
      agentClassName: 'codex-cli', executionMode: 'fresh',
    });
    expect(outcome).toMatchObject({ outcome: 'completed', output: 'A completed.' });
    expect(setupResult.subtaskRepo.findById(setupResult.a.id)).toMatchObject({ status: 'done', result: 'A completed.' });
    expect(setupResult.db.prepare('SELECT terminal_state, raw_response FROM executor_attempt_receipts').get())
      .toMatchObject({ terminal_state: 'completed', raw_response: validResponse() });
    expect(setupResult.db.prepare('SELECT from_subtask_id, to_subtask_id FROM subtask_handoffs').get())
      .toEqual({ from_subtask_id: setupResult.a.id, to_subtask_id: setupResult.b.id });
    expect(setupResult.workUnitRepo.findById('executor-codex')).toMatchObject({
      state: 'idle', claimedTaskId: null, claimedSubtaskId: null, claimedAttemptId: null,
    });
  });

  it('blocks malformed completion without exposing it as a successful Subtask result', async () => {
    const setupResult = setup('plain response without envelope');
    const outcome = await setupResult.runner.run({
      executionId: 'exec_1', taskId: 'task_phase2', subtaskId: setupResult.a.id,
      agentClassName: 'codex-cli', executionMode: 'fresh',
    });
    expect(outcome.outcome).toBe('contract_blocked');
    expect(setupResult.subtaskRepo.findById(setupResult.a.id)).toMatchObject({ status: 'blocked', result: '' });
    expect(setupResult.db.prepare('SELECT terminal_state, raw_response FROM executor_attempt_receipts').get())
      .toEqual({ terminal_state: 'contract_blocked', raw_response: 'plain response without envelope' });
    expect(setupResult.db.prepare('SELECT COUNT(*) AS count FROM subtask_handoffs').get()).toEqual({ count: 0 });
    expect(setupResult.workUnitRepo.findById('executor-codex')).toMatchObject({ claimedAttemptId: null });
  });

  it('blocks a handoff that would exceed the downstream aggregate budget', async () => {
    const rawResponse = `A completed.\n\n${COMPLETION_MARKER_V1}\n${JSON.stringify({
      schemaVersion: 1,
      subtaskId: 'task_phase2_a',
      acceptanceEvidence: [{ key: 'done', evidence: ['verified A'] }],
      artifacts: [],
      handoffs: [{
        toSubtaskId: 'task_phase2_b',
        items: [{ key: 'summary', type: 'text', value: 'x'.repeat(4_000) }],
      }],
    })}`;
    const setupResult = setup(rawResponse);
    setupResult.subtaskRepo.upsert(node('task_phase2_c'));
    setupResult.db.prepare(`
      INSERT INTO subtask_handoffs (
        task_id, from_subtask_id, to_subtask_id, attempt_id,
        items_json, completion_schema_version, created_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(
      'task_phase2',
      'task_phase2_c',
      'task_phase2_b',
      'attempt_existing',
      JSON.stringify(Array.from({ length: 6 }, (_, index) => ({
        key: `existing_${index}`,
        type: 'text',
        value: 'y'.repeat(3_500),
      }))),
      '2026-07-17T00:00:00.000Z',
    );

    const outcome = await setupResult.runner.run({
      executionId: 'exec_1', taskId: 'task_phase2', subtaskId: setupResult.a.id,
      agentClassName: 'codex-cli', executionMode: 'fresh',
    });
    expect(outcome).toMatchObject({ outcome: 'contract_blocked' });
    expect(outcome.outcome === 'contract_blocked' ? outcome.violations : []).toContainEqual(expect.objectContaining({
      code: 'completion_budget_exceeded',
      path: 'handoffs.0.toSubtaskId',
    }));
    expect(setupResult.db.prepare('SELECT COUNT(*) AS count FROM subtask_handoffs').get()).toEqual({ count: 1 });
  });

  it('persists an executor failure and releases the exact attempt claim when execution throws', async () => {
    const setupResult = setup(validResponse());
    setupResult.executionRuntime.run.mockRejectedValueOnce(new Error('progress callback failed'));
    const outcome = await setupResult.runner.run({
      executionId: 'exec_1', taskId: 'task_phase2', subtaskId: setupResult.a.id,
      agentClassName: 'codex-cli', executionMode: 'fresh',
    });
    expect(outcome).toMatchObject({ outcome: 'executor_failed', error: 'progress callback failed' });
    expect(setupResult.subtaskRepo.findById(setupResult.a.id)).toMatchObject({ status: 'blocked' });
    expect(setupResult.db.prepare('SELECT terminal_state, error_detail FROM executor_attempt_receipts').get())
      .toEqual({ terminal_state: 'executor_failed', error_detail: 'progress callback failed' });
    expect(setupResult.workUnitRepo.findById('executor-codex')).toMatchObject({
      state: 'failed', claimedTaskId: null, claimedSubtaskId: null, claimedAttemptId: null,
    });
  });
});
