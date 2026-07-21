import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { WorkUnitRepo } from '../../src/storage/work-unit-repo.js';
import { WorkUnitClaimService } from '../../src/execution/work-unit-claim-service.js';
import { SubtaskAttemptRunner } from '../../src/execution/subtask-attempt-runner.js';
import { COMPLETION_MARKER_V2 } from '../../src/execution/completion-protocol.js';
import { getBuiltinExecutorAgentClasses } from '../../src/executor/builtin-executor-catalog.js';
import { AgentClassRepo } from '../../src/storage/agent-class-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskRuntimeService } from '../../src/task/task-runtime-service.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import type { Subtask } from '../../src/core/types.js';

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
  const taskRepo = new TaskRepo(db);
  db.prepare(`
    INSERT INTO tasks (
      id, title, goal, status, summary, snapshot_json, resources_json, artifacts_json,
      dependencies_json, priority_json, injected_prefs_json, last_scheduling_reason,
      last_interruption_reason, interruption_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '', '[]', '[]', '[]', '[]', '{}', '[]', '', '', 0, ?, ?)
  `).run('task_phase2', 'Phase 2', 'complete the graph', 'running', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z');
  const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-phase2-attempt-runner');
  const taskRuntimeService = new TaskRuntimeService({
    taskEngine,
    taskRepo,
    orchestration: new OrchestrationEngine(taskEngine),
  });
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
    supportsResponseOnly: vi.fn().mockReturnValue(true),
    runResponseOnly: vi.fn(),
  };
  const runner = new SubtaskAttemptRunner({
    db,
    sessionId: 'session_1',
    taskRuntimeService,
    subtaskRepo,
    workUnitClaimService: new WorkUnitClaimService(workUnitRepo),
    executionRuntime: executionRuntime as never,
    agentClassService: { listAgentClasses: () => getBuiltinExecutorAgentClasses() } as never,
  });
  return { db, runner, taskRuntimeService, subtaskRepo, workUnitRepo, executionRuntime, a, b };
}

function validResponse(): string {
  return `A completed.\n\n${COMPLETION_MARKER_V2}\n${JSON.stringify({
    schemaVersion: 2,
    status: 'completed',
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
      attemptId: 'attempt_1',
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
      attemptId: 'attempt_1',
      executionId: 'exec_1', taskId: 'task_phase2', subtaskId: setupResult.a.id,
      agentClassName: 'codex-cli', executionMode: 'fresh',
    });
    expect(outcome.outcome).toBe('contract_failed');
    expect(setupResult.subtaskRepo.findById(setupResult.a.id)).toMatchObject({ status: 'awaiting_decision', result: '' });
    expect(setupResult.db.prepare('SELECT terminal_state, raw_response FROM executor_attempt_receipts').get())
      .toEqual({ terminal_state: 'contract_blocked', raw_response: 'plain response without envelope' });
    expect(setupResult.db.prepare('SELECT COUNT(*) AS count FROM subtask_handoffs').get()).toEqual({ count: 0 });
    expect(setupResult.taskRuntimeService.findTask('task_phase2')).toMatchObject({ status: 'running' });
    expect(setupResult.workUnitRepo.findById('executor-codex')).toMatchObject({
      state: 'failed', claimedTaskId: null, claimedSubtaskId: null, claimedAttemptId: null,
    });
    expect(setupResult.db.prepare(`
      SELECT event_type, state, attempt_id FROM work_unit_events
      WHERE work_unit_id = 'executor-codex' AND event_type IN ('failed', 'released')
      ORDER BY rowid
    `).all()).toEqual([
      { event_type: 'failed', state: 'failed', attempt_id: outcome.attemptId },
      { event_type: 'released', state: 'failed', attempt_id: outcome.attemptId },
    ]);
  });

  it('terminates a stale attempt without leaving its Subtask running or releasing its WorkUnit as idle', async () => {
    const setupResult = setup(validResponse());
    setupResult.executionRuntime.run.mockImplementationOnce(async () => {
      setupResult.taskRuntimeService.cancelTask('task_phase2', 'cancelled while executor was running');
      return {
        taskId: 'task_phase2', executionId: 'exec_1', status: 'success', executorName: 'codex-cli',
        output: validResponse(), error: null, artifacts: [], subtaskResults: [], durationMs: 10,
      };
    });

    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_1',
      executionId: 'exec_1', taskId: 'task_phase2', subtaskId: setupResult.a.id,
      agentClassName: 'codex-cli', executionMode: 'fresh',
    });

    expect(outcome).toMatchObject({ outcome: 'cancelled_or_stale' });
    expect(setupResult.taskRuntimeService.findTask('task_phase2')).toMatchObject({ status: 'cancelled' });
    expect(setupResult.subtaskRepo.findById(setupResult.a.id)).toMatchObject({
      status: 'awaiting_decision', error: 'Task, Subtask, or WorkUnit claim changed before commit',
    });
    expect(setupResult.db.prepare('SELECT terminal_state, error_code FROM executor_attempt_receipts').get())
      .toEqual({ terminal_state: 'cancelled_or_stale', error_code: 'attempt_stale' });
    expect(setupResult.db.prepare('SELECT COUNT(*) AS count FROM subtask_handoffs').get()).toEqual({ count: 0 });
    expect(setupResult.workUnitRepo.findById('executor-codex')).toMatchObject({
      state: 'failed', claimedTaskId: null, claimedSubtaskId: null, claimedAttemptId: null,
    });
    expect(setupResult.db.prepare(`
      SELECT event_type, state, attempt_id FROM work_unit_events
      WHERE work_unit_id = 'executor-codex' AND event_type IN ('failed', 'released')
      ORDER BY rowid
    `).all()).toEqual([
      { event_type: 'failed', state: 'failed', attempt_id: outcome.attemptId },
      { event_type: 'released', state: 'failed', attempt_id: outcome.attemptId },
    ]);
  });

  it('blocks a handoff that would exceed the downstream aggregate budget', async () => {
    const rawResponse = `A completed.\n\n${COMPLETION_MARKER_V2}\n${JSON.stringify({
      schemaVersion: 2,
      status: 'completed',
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
      attemptId: 'attempt_1',
      executionId: 'exec_1', taskId: 'task_phase2', subtaskId: setupResult.a.id,
      agentClassName: 'codex-cli', executionMode: 'fresh',
    });
    expect(outcome).toMatchObject({ outcome: 'contract_failed' });
    expect(outcome.outcome === 'contract_failed' ? outcome.violations : []).toContainEqual(expect.objectContaining({
      code: 'completion_budget_exceeded',
      path: 'handoffs.0.toSubtaskId',
    }));
    expect(setupResult.db.prepare('SELECT COUNT(*) AS count FROM subtask_handoffs').get()).toEqual({ count: 1 });
  });

  it('persists an executor failure and releases the exact attempt claim when execution throws', async () => {
    const setupResult = setup(validResponse());
    setupResult.executionRuntime.run.mockRejectedValueOnce(new Error('progress callback failed'));
    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_1',
      executionId: 'exec_1', taskId: 'task_phase2', subtaskId: setupResult.a.id,
      agentClassName: 'codex-cli', executionMode: 'fresh',
    });
    expect(outcome).toMatchObject({ outcome: 'executor_failed', error: 'progress callback failed' });
    expect(setupResult.subtaskRepo.findById(setupResult.a.id)).toMatchObject({ status: 'awaiting_decision' });
    expect(setupResult.db.prepare('SELECT terminal_state, error_detail FROM executor_attempt_receipts').get())
      .toEqual({ terminal_state: 'executor_failed', error_detail: 'progress callback failed' });
    expect(setupResult.workUnitRepo.findById('executor-codex')).toMatchObject({
      state: 'failed', claimedTaskId: null, claimedSubtaskId: null, claimedAttemptId: null,
    });
  });

  it('runs a Kernel-authorized fallback from awaiting_decision without treating it as stale', async () => {
    const setupResult = setup(validResponse());
    setupResult.subtaskRepo.updateStatus(setupResult.a.id, 'awaiting_decision', { error: 'source attempt failed' });

    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_fallback', sourceAttemptId: 'attempt_source', attemptKind: 'fallback',
      recoveryMode: 'recovery_packet', executionId: 'exec_2', taskId: 'task_phase2',
      subtaskId: setupResult.a.id, agentClassName: 'codex-cli', executionMode: 'follow-up',
    });

    expect(outcome).toMatchObject({ outcome: 'completed', attemptId: 'attempt_fallback' });
    expect(setupResult.subtaskRepo.findById(setupResult.a.id)).toMatchObject({ status: 'done' });
  });

  it('does not start a stale fallback after the Task was cancelled', async () => {
    const setupResult = setup(validResponse());
    setupResult.subtaskRepo.updateStatus(setupResult.a.id, 'awaiting_decision', { error: 'source attempt failed' });
    setupResult.taskRuntimeService.cancelTask('task_phase2', 'cancelled before retry wake');

    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_stale_fallback', sourceAttemptId: 'attempt_source', attemptKind: 'fallback',
      recoveryMode: 'recovery_packet', executionId: 'exec_2', taskId: 'task_phase2',
      subtaskId: setupResult.a.id, agentClassName: 'codex-cli', executionMode: 'follow-up',
    });

    expect(outcome).toMatchObject({ outcome: 'cancelled_or_stale' });
    expect(setupResult.executionRuntime.run).not.toHaveBeenCalled();
    expect(setupResult.workUnitRepo.findById('executor-codex')).toMatchObject({ state: 'idle' });
  });

  it('publishes only a corrected response from one isolated response-only attempt', async () => {
    const setupResult = setup('first malformed response');
    const first = await setupResult.runner.run({
      attemptId: 'attempt_primary', executionId: 'exec_1', taskId: 'task_phase2', subtaskId: setupResult.a.id,
      agentClassName: 'codex-cli', executionMode: 'fresh',
    });
    expect(first.outcome).toBe('contract_failed');
    if (first.outcome !== 'contract_failed') return;
    setupResult.workUnitRepo.updateState('executor-codex', 'idle');
    setupResult.executionRuntime.runResponseOnly.mockResolvedValue({
      success: true, output: validResponse(), exitCode: 0, durationMs: 5,
    });

    const corrected = await setupResult.runner.runCorrection({
      attemptId: 'attempt_correction', sourceAttemptId: first.attemptId, executionId: 'exec_1',
      taskId: 'task_phase2', subtaskId: setupResult.a.id, agentClassName: 'codex-cli',
      completionContract: first.completionContract, violations: first.violations,
    });

    expect(corrected).toMatchObject({ outcome: 'completed', output: 'A completed.' });
    expect(setupResult.executionRuntime.runResponseOnly).toHaveBeenCalledTimes(1);
    expect(setupResult.executionRuntime.runResponseOnly.mock.calls[0][1]).toContain('first malformed response');
    expect(setupResult.db.prepare(`
      SELECT attempt_id, terminal_state, raw_response FROM executor_attempt_receipts ORDER BY completed_at, attempt_id
    `).all()).toEqual(expect.arrayContaining([
      { attempt_id: 'attempt_primary', terminal_state: 'contract_blocked', raw_response: 'first malformed response' },
      { attempt_id: 'attempt_correction', terminal_state: 'completed', raw_response: validResponse() },
    ]));
    expect(setupResult.subtaskRepo.findById(setupResult.a.id)).toMatchObject({ status: 'done', result: 'A completed.' });
  });
});
