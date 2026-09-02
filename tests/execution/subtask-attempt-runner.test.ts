import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { WorkUnitRepo } from '../../src/storage/work-unit-repo.js';
import { WorkUnitClaimService } from '../../src/execution/work-unit-claim-service.js';
import { SubtaskAttemptRunner } from '../../src/execution/subtask-attempt-runner.js';
import { COMPLETION_MARKER_V4 } from '../../src/execution/completion-protocol.js';
import { builtinCodexAgentClass, builtinPiAgentClass } from '../support/builtin-agent-classes.js';
import { AgentClassRepo } from '../../src/storage/agent-class-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskRuntimeService } from '../../src/task/task-runtime-service.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import type { Subtask } from '../../src/core/types.js';
import { WorkspaceStore } from '../../src/execution/workspace-store.js';
import { ResourceLeaseService } from '../../src/execution/resource-lease-service.js';
import { SqliteResourceLeaseRepository } from '../../src/storage/resource-lease-repo.js';
import { SqlitePermissionRepository } from '../../src/storage/permission-repo.js';
import { KernelWorkflowRepo } from '../../src/storage/kernel-workflow-repo.js';
import { SqliteWorkspaceRepository } from '../../src/storage/workspace-repo.js';
import { buildDefaultResourceClaims } from '../../src/resource/index.js';
import type { AttemptExecutionBackend } from '../../src/execution/attempt-execution-backend.js';
import { KernelDispatchItemRepo } from '../../src/storage/kernel-dispatch-item-repo.js';
import { WorkGraphRevisionRepo } from '../../src/storage/work-graph-revision-repo.js';
import { ResultObjectRepo } from '../../src/storage/result-object-repo.js';
import {
  authorizedExecutorBindingFingerprint,
  type AuthorizedExecutorBinding,
} from '../../src/core/authorized-executor-binding.js';

const configurationRevision = 'configuration_revision_1';
const authorizedBinding: AuthorizedExecutorBinding = {
  agentClassRef: 'codex-cli',
  harnessRef: 'codex-cli-harness',
  providerRef: 'openai',
  modelRef: 'gpt-5-codex',
  permissionProfileRef: 'workspace-engineering',
  configurationRevision,
};
const bindingFingerprint = authorizedExecutorBindingFingerprint(authorizedBinding);
const alternateModelBinding: AuthorizedExecutorBinding = {
  ...authorizedBinding,
  modelRef: 'gpt-5.1-codex',
};
const piAuthorizedBinding: AuthorizedExecutorBinding = {
  agentClassRef: 'pi-agent',
  harnessRef: 'pi-agent-harness',
  providerRef: 'anthropic',
  modelRef: 'claude-sonnet-4.5',
  permissionProfileRef: 'public-web-research',
  configurationRevision,
};

function attemptIdentity(binding = authorizedBinding) {
  return {
    authorizedBinding: binding,
    bindingFingerprint: authorizedExecutorBindingFingerprint(binding),
  };
}

function node(
  id: string,
  dependencies: Subtask['dependencies'] = [],
  executorBindings: AuthorizedExecutorBinding[] = [authorizedBinding],
): Subtask {
  return {
    id, taskId: 'task_phase2', graphRevision: 1, generationId: 'generation_phase2',
    title: id, goal: `complete ${id}`, status: 'ready',
    dependencies, contextRefs: [], requiredCapabilities: ['workspace-engineering'],
    executorBindings, deliveryKind: 'report',
    acceptance: [{ key: 'done', description: 'done', requiredEvidence: [] }], riskLevel: 'low',
    result: '', artifacts: [], verification: { warnings: [], completionSchemaVersion: null }, error: null,
    createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
  };
}

function setup(rawResponse: string) {
  const db = new Database(':memory:');
  runMigrations(db);
  db.prepare(`
    INSERT INTO configuration_revisions (
      revision_id, content_hash, source_kind, imported_at
    ) VALUES (?, ?, 'native', ?)
  `).run(configurationRevision, 'sha256:test-configuration', '2026-07-17T00:00:00.000Z');
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
  new WorkGraphRevisionRepo(db).activate({
    id: 'work_graph_revision_phase2_1',
    taskId: 'task_phase2',
    revision: 1,
    generationId: 'generation_phase2',
    configurationRevision,
    authorizedDecisionId: null,
    proposalSource: 'initial',
    automaticReplan: false,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
  });
  new AgentClassRepo(db).upsert(
    builtinCodexAgentClass(),
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
  const attemptExecutionBackend: AttemptExecutionBackend = {
    kind: 'worktree',
    pathMode: 'native',
    resolveImage: vi.fn(), create: vi.fn(), start: vi.fn(), wait: vi.fn(), logs: vi.fn(),
    pause: vi.fn(), resume: vi.fn(), inspect: vi.fn(), stop: vi.fn(), remove: vi.fn(), listManaged: vi.fn(),
  } as unknown as AttemptExecutionBackend;
  const fixtureRoot = `/tmp/metaclaw-phase2-attempt-runner/${randomUUID()}`;
  const resultRoot = join(fixtureRoot, 'results');
  const sourceRoot = join(fixtureRoot, 'source');
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(join(sourceRoot, 'README.md'), 'fixture\n');
  const workspaceStore = new WorkspaceStore(join(fixtureRoot, 'store'));
  const workUnitClaimService = new WorkUnitClaimService(workUnitRepo);
  const claimAttempt = vi.spyOn(workUnitClaimService, 'claim');
  const attemptRunner = new SubtaskAttemptRunner({
    db,
    sessionId: 'session_1',
    taskRuntimeService,
    subtaskRepo,
    workUnitClaimService,
    executionRuntime: executionRuntime as never,
    agentClassService: { listExecutorAgentClassNames: () => ['codex-cli', 'pi-agent'], hasExecutorAgentClass: () => true } as never,
    workspaceStore,
    attemptExecutionBackend,
    resourceLeaseService: new ResourceLeaseService(new SqliteResourceLeaseRepository(db)),
    permissionRepository: new SqlitePermissionRepository(db),
    kernelWorkflowStore: new KernelWorkflowRepo(db),
    workspaceRepository: new SqliteWorkspaceRepository(db),
    accountId: 'local-default',
    resultRoot,
    sourceRoot,
    controlNetwork: 'metaclaw-control',
  });
  const defaultResourceGrant = buildDefaultResourceClaims({
    workspaceId: `workspace-task_phase2-${a.generationId}-${a.id}`,
    sourceMountId: 'source-task_phase2', inputsMountId: 'inputs-task_phase2', handoffsMountId: 'handoffs-task_phase2',
    gitMetadataMountId: 'git-task_phase2',
  });
  const dispatchItems = new KernelDispatchItemRepo(db);
  const authorize = (input: {
    attemptId: string;
    authorizedBinding: AuthorizedExecutorBinding;
    bindingFingerprint: string;
    attemptKind?: 'primary' | 'continuation' | 'fallback' | 'contract_correction' | 'merge_repair';
    sourceAttemptId?: string | null;
    recoveryMode?: 'fresh' | 'native_session' | 'recovery_packet';
    attemptPayload?: Parameters<SubtaskAttemptRunner['run']>[0]['attemptPayload'];
  }) => {
    if (dispatchItems.find(input.attemptId)) return;
    const now = '2026-07-28T00:00:00.000Z';
    dispatchItems.insertBatch({
      schemaVersion: 5,
      configurationRevision: input.authorizedBinding.configurationRevision,
      id: `decision_${input.attemptId}`,
      eventId: `dispatch_${input.attemptId}`,
      reason: 'test dispatch authorization',
      action: {
        type: 'dispatch_batch',
        taskId: 'task_phase2',
        items: [{
          order: 0,
          subtaskId: a.id,
          attemptId: input.attemptId,
          authorizedBinding: input.authorizedBinding,
          bindingFingerprint: input.bindingFingerprint,
          attemptKind: input.attemptKind ?? 'primary',
          sourceAttemptId: input.sourceAttemptId ?? null,
          recoveryMode: input.recoveryMode ?? 'fresh',
          attemptPayload: input.attemptPayload ?? null,
          defaultResourceGrant,
        }],
      },
    }, {
      generationId: a.generationId,
      configurationRevision: input.authorizedBinding.configurationRevision,
      attempts: {
        [input.attemptId]: {
          authorizedBinding: input.authorizedBinding,
          bindingFingerprint: input.bindingFingerprint,
        },
      },
    }, now);
    if (dispatchItems.claimPending(input.attemptId, now)) {
      dispatchItems.markRunning(input.attemptId, null, now);
    }
  };
  const runner = {
    run: async (input: Parameters<SubtaskAttemptRunner['run']>[0]) => {
      authorize(input);
      return attemptRunner.run(input);
    },
    runCorrection: async (input: Parameters<SubtaskAttemptRunner['runCorrection']>[0]) => {
      authorize({
        ...input,
        attemptKind: 'contract_correction',
        recoveryMode: 'fresh',
        attemptPayload: {
          protocol: 'completion-correction-v2',
          completionContract: input.completionContract as never,
          violations: input.violations,
        },
      });
      return attemptRunner.runCorrection(input);
    },
  };
  return {
    db,
    runner,
    taskRuntimeService,
    subtaskRepo,
    workUnitRepo,
    claimAttempt,
    executionRuntime,
    dispatchItems,
    workflow: new KernelWorkflowRepo(db),
    resultObjectRepo: new ResultObjectRepo(db, resultRoot),
    a,
    b,
    defaultResourceGrant,
  };
}

function authorizeRunningAttempt(
  setupResult: ReturnType<typeof setup>,
  attemptId: string,
  attempt: {
    attemptKind?: 'primary' | 'continuation' | 'fallback' | 'contract_correction' | 'merge_repair';
    sourceAttemptId?: string | null;
    recoveryMode?: 'fresh' | 'native_session' | 'recovery_packet';
  } = {},
): void {
  const now = '2026-07-28T00:00:00.000Z';
  setupResult.dispatchItems.insertBatch({
    schemaVersion: 5,
    configurationRevision,
    id: `decision_${attemptId}`,
    eventId: `dispatch_${attemptId}`,
    reason: 'test dispatch authorization',
    action: {
      type: 'dispatch_batch',
      taskId: 'task_phase2',
      items: [{
        order: 0,
        subtaskId: setupResult.a.id,
        attemptId,
        authorizedBinding,
        bindingFingerprint,
        attemptKind: attempt.attemptKind ?? 'primary',
        sourceAttemptId: attempt.sourceAttemptId ?? null,
        recoveryMode: attempt.recoveryMode ?? 'fresh',
        attemptPayload: null,
        defaultResourceGrant: setupResult.defaultResourceGrant,
      }],
    },
  }, {
    generationId: setupResult.a.generationId,
    configurationRevision,
    attempts: {
      [attemptId]: { authorizedBinding, bindingFingerprint },
    },
  }, now);
  expect(setupResult.dispatchItems.claimPending(attemptId, now)).not.toBeNull();
  expect(setupResult.dispatchItems.markRunning(attemptId, null, now)).toBe(true);
}

function validResponse(): string {
  return `A completed.\n\n${COMPLETION_MARKER_V4}\n${JSON.stringify({
    evidence: ['verified A'],
    noChangeReason: null,
  })}`;
}

describe('SubtaskAttemptRunner', () => {
  it('atomically records a candidate receipt without publishing handoffs before integration', async () => {
    const setupResult = setup(validResponse());
    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_1',
      executionId: 'exec_1', taskId: 'task_phase2', subtaskId: setupResult.a.id,
      ...attemptIdentity(), executionMode: 'fresh', defaultResourceGrant: setupResult.defaultResourceGrant,
    });
    expect(outcome).toMatchObject({ outcome: 'completed', output: 'A completed.' });
    expect(setupResult.subtaskRepo.findById(setupResult.a.id)).toMatchObject({
      status: 'awaiting_integration',
      result: '',
    });
    expect(setupResult.db.prepare('SELECT terminal_state, raw_response FROM executor_attempt_receipts').get())
      .toMatchObject({ terminal_state: 'completed', raw_response: '' });
    expect(setupResult.db.prepare(`
      SELECT kind, completeness
      FROM result_objects
      ORDER BY kind
    `).all()).toEqual([
      { kind: 'business_result', completeness: 'complete' },
      { kind: 'raw_attempt_output', completeness: 'complete' },
      { kind: 'safe_projection', completeness: 'complete' },
    ]);
    expect(setupResult.db.prepare('SELECT COUNT(*) AS count FROM subtask_handoffs').get())
      .toEqual({ count: 0 });
    expect(setupResult.db.prepare(`
      SELECT subtask_id, source_attempt_id, status FROM workspace_publications
    `).get()).toEqual({
      subtask_id: setupResult.a.id,
      source_attempt_id: 'attempt_1',
      status: 'pending',
    });
    expect(setupResult.dispatchItems.find('attempt_1')?.status).toBe('terminal');
    expect(setupResult.workflow.findEvent('event_attempt_1_execution_outcome')).toMatchObject({
      type: 'execution_outcome',
      terminalKind: 'completed',
      attemptId: 'attempt_1',
      configurationRevision,
      authorizedBinding,
      bindingFingerprint,
    });
    expect(setupResult.claimAttempt).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: 'attempt_1',
      authorizedBinding,
    }));
    expect(setupResult.workUnitRepo.findById('executor-codex')).toMatchObject({
      state: 'idle', claimedTaskId: null, claimedSubtaskId: null, claimedAttemptId: null,
    });
  });

  it('publishes a report that persists research files in the task workspace', async () => {
    const setupResult = setup(validResponse());
    setupResult.executionRuntime.run.mockImplementationOnce(async input => {
      writeFileSync(
        join(input.executorInput.executionBinding!.workspacePath, 'research-notes.html'),
        '<!doctype html><html><body>research notes</body></html>',
      );
      return {
        taskId: 'task_phase2',
        executionId: 'exec_report_workspace',
        status: 'success',
        executorName: 'codex-cli',
        output: validResponse(),
        error: null,
        artifacts: [],
        subtaskResults: [],
        durationMs: 10,
      };
    });

    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_report_workspace',
      executionId: 'exec_report_workspace',
      taskId: 'task_phase2',
      subtaskId: setupResult.a.id,
      ...attemptIdentity(),
      executionMode: 'fresh',
      defaultResourceGrant: setupResult.defaultResourceGrant,
    });

    expect(outcome).toMatchObject({
      outcome: 'completed',
      attemptId: 'attempt_report_workspace',
    });
    expect(setupResult.db.prepare(`
      SELECT status FROM workspace_publications WHERE source_attempt_id = ?
    `).get('attempt_report_workspace')).toEqual({ status: 'pending' });
    expect(setupResult.db.prepare(`
      SELECT verification_json FROM executor_attempt_receipts WHERE attempt_id = ?
    `).get('attempt_report_workspace')).toMatchObject({
      verification_json: expect.not.stringContaining('completion_report_workspace_changed'),
    });
  });

  it('persists and returns a safe result when completion metadata is missing', async () => {
    const setupResult = setup('plain response without envelope');
    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_1',
      executionId: 'exec_1', taskId: 'task_phase2', subtaskId: setupResult.a.id,
      ...attemptIdentity(), executionMode: 'fresh', defaultResourceGrant: setupResult.defaultResourceGrant,
    });
    expect(outcome).toMatchObject({
      outcome: 'contract_failed',
      output: 'plain response without envelope',
      resultId: 'result_attempt_1_safe',
    });
    expect(setupResult.subtaskRepo.findById(setupResult.a.id)).toMatchObject({ status: 'awaiting_decision', result: '' });
    expect(setupResult.db.prepare(`
      SELECT terminal_state, raw_response, parsing_json
      FROM executor_attempt_receipts
    `).get()).toMatchObject({
      terminal_state: 'uncertified_result',
      raw_response: '',
      parsing_json: expect.stringContaining('"safeProjectionId":"result_attempt_1_safe"'),
    });
    expect(setupResult.db.prepare(`
      SELECT result_id, kind, completeness
      FROM result_objects
      ORDER BY result_id
    `).all()).toEqual([
      { result_id: 'result_attempt_1_business', kind: 'business_result', completeness: 'partial' },
      { result_id: 'result_attempt_1_raw', kind: 'raw_attempt_output', completeness: 'partial' },
      { result_id: 'result_attempt_1_safe', kind: 'safe_projection', completeness: 'partial' },
    ]);
    expect(setupResult.db.prepare('SELECT COUNT(*) AS count FROM subtask_handoffs').get()).toEqual({ count: 0 });
    expect(setupResult.taskRuntimeService.findTask('task_phase2')).toMatchObject({ status: 'running' });
    expect(setupResult.workUnitRepo.findById('executor-codex')).toMatchObject({
      state: 'idle', claimedTaskId: null, claimedSubtaskId: null, claimedAttemptId: null,
    });
    expect(setupResult.db.prepare(`
      SELECT event_type, state, attempt_id FROM work_unit_events
      WHERE work_unit_id = 'executor-codex' AND event_type IN ('waiting', 'released')
      ORDER BY rowid
    `).all()).toEqual([
      { event_type: 'waiting', state: 'waiting', attempt_id: outcome.attemptId },
      { event_type: 'released', state: 'idle', attempt_id: outcome.attemptId },
    ]);
  });

  it('persists the streamed raw Harness output separately from the normalized business result', async () => {
    const setupResult = setup(validResponse());
    const rawHarnessOutput = [
      '{"type":"agent_start"}\n',
      '{"type":"tool_execution_end","toolName":"web_search"}\n',
      '{"type":"message_end","message":{"role":"assistant"}}\n',
    ].join('');
    setupResult.executionRuntime.run.mockImplementationOnce(async input => {
      input.executorInput.onRawOutput?.(rawHarnessOutput, 'stdout');
      return {
        taskId: 'task_phase2',
        executionId: 'exec_1',
        status: 'success',
        executorName: 'codex-cli',
        output: validResponse(),
        error: null,
        artifacts: [],
        subtaskResults: [],
        durationMs: 10,
      };
    });

    await setupResult.runner.run({
      attemptId: 'attempt_streamed_raw',
      executionId: 'exec_1',
      taskId: 'task_phase2',
      subtaskId: setupResult.a.id,
      ...attemptIdentity(),
      executionMode: 'fresh',
      defaultResourceGrant: setupResult.defaultResourceGrant,
    });

    const raw = setupResult.resultObjectRepo.findObject('result_attempt_streamed_raw_raw');
    const business = setupResult.resultObjectRepo.findObject('result_attempt_streamed_raw_business');
    expect(raw).not.toBeNull();
    expect(business).not.toBeNull();
    expect(setupResult.resultObjectRepo.readRange(
      raw!.resultId,
      0,
      raw!.byteLength,
    ).content).toBe(rawHarnessOutput);
    expect(setupResult.resultObjectRepo.readRange(
      business!.resultId,
      0,
      business!.byteLength,
    ).content).toBe('A completed.');
  });

  it('delivers and persists a redacted safe projection while retaining the business result', async () => {
    const response = `Sensitive report\n\ntoken=secret-value\n\n${COMPLETION_MARKER_V4}\n${JSON.stringify({
      evidence: ['verified report'],
      noChangeReason: null,
    })}`;
    const setupResult = setup(response);

    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_secret_projection',
      executionId: 'exec_1',
      taskId: 'task_phase2',
      subtaskId: setupResult.a.id,
      ...attemptIdentity(),
      executionMode: 'fresh',
      defaultResourceGrant: setupResult.defaultResourceGrant,
    });

    expect(outcome).toMatchObject({
      outcome: 'completed',
      output: 'Sensitive report\n\ntoken=[REDACTED]',
    });
    const business = setupResult.resultObjectRepo.findObject(
      'result_attempt_secret_projection_business',
    )!;
    const safe = setupResult.resultObjectRepo.findObject(
      'result_attempt_secret_projection_safe',
    )!;
    expect(setupResult.resultObjectRepo.readRange(
      business.resultId,
      0,
      business.byteLength,
    ).content).toContain('token=secret-value');
    expect(setupResult.resultObjectRepo.readRange(
      safe.resultId,
      0,
      safe.byteLength,
    ).content).toBe('Sensitive report\n\ntoken=[REDACTED]');
  });

  it('terminates a stale attempt without leaving its Subtask running or releasing its WorkUnit as idle', async () => {
    const setupResult = setup(validResponse());
    setupResult.executionRuntime.run.mockImplementationOnce(async () => {
      setupResult.taskRuntimeService.cancelTask('task_phase2', 'cancelled while executor was running');
      setupResult.subtaskRepo.updateStatus(setupResult.a.id, 'cancelled', {
        error: 'cancelled while executor was running',
      });
      return {
        taskId: 'task_phase2', executionId: 'exec_1', status: 'success', executorName: 'codex-cli',
        output: validResponse(), error: null, artifacts: [], subtaskResults: [], durationMs: 10,
      };
    });

    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_1',
      executionId: 'exec_1', taskId: 'task_phase2', subtaskId: setupResult.a.id,
      ...attemptIdentity(), executionMode: 'fresh', defaultResourceGrant: setupResult.defaultResourceGrant,
    });

    expect(outcome).toMatchObject({ outcome: 'cancelled_or_stale' });
    expect(setupResult.taskRuntimeService.findTask('task_phase2')).toMatchObject({ status: 'cancelled' });
    expect(setupResult.subtaskRepo.findById(setupResult.a.id)).toMatchObject({
      status: 'cancelled', error: 'cancelled while executor was running',
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

  it('does not resurrect a cancelled Subtask when the running Executor reports cancellation', async () => {
    const setupResult = setup(validResponse());
    setupResult.executionRuntime.run.mockImplementationOnce(async () => {
      setupResult.taskRuntimeService.cancelTask('task_phase2', 'cancelled while executor was running');
      setupResult.subtaskRepo.updateStatus(setupResult.a.id, 'cancelled', {
        error: 'cancelled while executor was running',
      });
      return {
        taskId: 'task_phase2',
        executionId: 'exec_1',
        status: 'cancelled',
        executorName: 'codex-cli',
        output: '',
        error: 'attempt cancelled',
        artifacts: [],
        subtaskResults: [],
        durationMs: 10,
      };
    });

    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_cancelled',
      executionId: 'exec_1',
      taskId: 'task_phase2',
      subtaskId: setupResult.a.id,
      ...attemptIdentity(),
      executionMode: 'fresh',
      defaultResourceGrant: setupResult.defaultResourceGrant,
    });

    expect(outcome).toMatchObject({ outcome: 'cancelled_or_stale' });
    expect(setupResult.subtaskRepo.findById(setupResult.a.id)).toMatchObject({
      status: 'cancelled',
      error: 'cancelled while executor was running',
    });
    expect(setupResult.db.prepare(`
      SELECT terminal_state, error_code FROM executor_attempt_receipts
      WHERE attempt_id = 'attempt_cancelled'
    `).get()).toEqual({
      terminal_state: 'cancelled_or_stale',
      error_code: 'attempt_cancelled',
    });
  });

  it('does not reject completion because evidence or existing handoffs are large', async () => {
    const rawResponse = `A completed.\n\n${COMPLETION_MARKER_V4}\n${JSON.stringify({
      evidence: [
        'x'.repeat(1_000),
        'x'.repeat(1_000),
        'x'.repeat(1_000),
        'x'.repeat(997),
      ],
      noChangeReason: null,
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
      ...attemptIdentity(), executionMode: 'fresh', defaultResourceGrant: setupResult.defaultResourceGrant,
    });
    expect(outcome).toMatchObject({
      outcome: 'completed',
      output: 'A completed.',
    });
    expect(setupResult.db.prepare('SELECT COUNT(*) AS count FROM subtask_handoffs').get()).toEqual({ count: 1 });
    expect(setupResult.db.prepare(`
      SELECT status FROM workspace_publications WHERE source_attempt_id = 'attempt_1'
    `).get()).toEqual({ status: 'pending' });
  });

  it('preserves timeout as the primary failure when a failed attempt has partial output', async () => {
    const setupResult = setup(validResponse());
    setupResult.executionRuntime.run.mockResolvedValueOnce({
      taskId: 'task_phase2',
      executionId: 'exec_partial',
      status: 'failed',
      executorName: 'codex-cli',
      output: 'PARTIAL_RESULT_FROM_HARNESS',
      error: 'Executor timed out after producing a partial answer',
      failure: {
        kind: 'timeout',
        scope: 'attempt',
        code: 'executor_timeout',
        summary: 'Executor timed out after producing a partial answer',
      },
      artifacts: [],
      subtaskResults: [],
      durationMs: 10,
      diagnostics: {
        providerRef: 'deepseek',
        modelId: 'deepseek-v4-flash',
        process: {
          terminationSource: 'idle_watchdog',
          stdoutBytes: 6_900_000,
          stderrBytes: 0,
        },
        harness: {
          lastEventKind: 'message_update:text_delta',
          turnIndex: 7,
          assistantStreamOpen: true,
          safeTextBytes: 27,
        },
        provisionalOutput: true,
      },
    });

    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_partial',
      executionId: 'exec_partial',
      taskId: 'task_phase2',
      subtaskId: setupResult.a.id,
      ...attemptIdentity(),
      executionMode: 'fresh',
      defaultResourceGrant: setupResult.defaultResourceGrant,
    });

    expect(outcome).toMatchObject({
      outcome: 'executor_failed',
      failure: {
        kind: 'timeout',
        code: 'executor_timeout',
      },
    });
    expect(setupResult.subtaskRepo.findById(setupResult.a.id)).toMatchObject({
      status: 'awaiting_decision',
    });
    expect(setupResult.db.prepare(`
      SELECT terminal_state, raw_response, parsing_json
      FROM executor_attempt_receipts WHERE attempt_id = 'attempt_partial'
    `).get()).toMatchObject({
      terminal_state: 'executor_failed',
      raw_response: '',
    });
    const parsing = JSON.parse((setupResult.db.prepare(`
      SELECT parsing_json FROM executor_attempt_receipts WHERE attempt_id = 'attempt_partial'
    `).get() as { parsing_json: string }).parsing_json) as {
      resultObjects: { businessResultId: string; safeProjectionId: string };
      completionAssessment: { result: { kind: string } } | null;
    };
    expect(parsing.completionAssessment).toBeNull();
    expect(setupResult.resultObjectRepo.readRange(
      parsing.resultObjects.businessResultId,
      0,
      setupResult.resultObjectRepo.findObject(parsing.resultObjects.businessResultId)!.byteLength,
    ).content).toBe('PARTIAL_RESULT_FROM_HARNESS');
    const runtimeProgress = JSON.parse((setupResult.db.prepare(`
      SELECT progress_json FROM executor_attempt_runtime WHERE attempt_id = 'attempt_partial'
    `).get() as { progress_json: string }).progress_json) as {
      history: unknown[];
      diagnostics: Record<string, unknown>;
    };
    expect(runtimeProgress.history.length).toBeGreaterThan(0);
    expect(runtimeProgress.diagnostics).toMatchObject({
      providerRef: 'deepseek',
      modelId: 'deepseek-v4-flash',
      process: {
        terminationSource: 'idle_watchdog',
        stdoutBytes: 6_900_000,
      },
      harness: {
        lastEventKind: 'message_update:text_delta',
        turnIndex: 7,
        assistantStreamOpen: true,
      },
      provisionalOutput: true,
    });
  });

  it('persists an executor failure and releases the exact attempt claim when execution throws', async () => {
    const setupResult = setup(validResponse());
    setupResult.executionRuntime.run.mockRejectedValueOnce(new Error('progress callback failed'));
    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_1',
      executionId: 'exec_1', taskId: 'task_phase2', subtaskId: setupResult.a.id,
      ...attemptIdentity(), executionMode: 'fresh', defaultResourceGrant: setupResult.defaultResourceGrant,
    });
    expect(outcome).toMatchObject({ outcome: 'executor_failed', error: 'progress callback failed' });
    expect(setupResult.subtaskRepo.findById(setupResult.a.id)).toMatchObject({ status: 'awaiting_decision' });
    expect(setupResult.db.prepare('SELECT terminal_state, error_detail FROM executor_attempt_receipts').get())
      .toEqual({ terminal_state: 'executor_failed', error_detail: 'progress callback failed' });
    expect(setupResult.workUnitRepo.findById('executor-codex')).toMatchObject({
      state: 'failed', claimedTaskId: null, claimedSubtaskId: null, claimedAttemptId: null,
    });
  });

  it('lands receipt, Subtask state, dispatch terminal and Kernel outcome inbox together', async () => {
    const setupResult = setup(validResponse());
    authorizeRunningAttempt(setupResult, 'attempt_atomic_terminal');
    setupResult.executionRuntime.run.mockRejectedValueOnce(new Error('executor process crashed'));

    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_atomic_terminal',
      executionId: 'exec_atomic_terminal',
      taskId: 'task_phase2',
      subtaskId: setupResult.a.id,
      ...attemptIdentity(),
      executionMode: 'fresh',
      defaultResourceGrant: setupResult.defaultResourceGrant,
    });

    expect(outcome).toMatchObject({ outcome: 'executor_failed' });
    expect(setupResult.subtaskRepo.findById(setupResult.a.id)?.status).toBe('awaiting_decision');
    expect(setupResult.dispatchItems.find('attempt_atomic_terminal')?.status).toBe('terminal');
    expect(setupResult.workflow.findEvent(
      'event_attempt_atomic_terminal_execution_outcome',
    )).toMatchObject({
      type: 'execution_outcome',
      attemptId: 'attempt_atomic_terminal',
      terminalKind: 'failed',
    });
  });

  it('lands heartbeat loss with the exact authorized binding identity', () => {
    const setupResult = setup(validResponse());
    authorizeRunningAttempt(setupResult, 'attempt_heartbeat_lost', {
      attemptKind: 'fallback',
      sourceAttemptId: 'attempt_primary_failed',
      recoveryMode: 'recovery_packet',
    });
    setupResult.subtaskRepo.updateStatus(setupResult.a.id, 'running');

    const runner = new SubtaskAttemptRunner({
      db: setupResult.db,
      sessionId: 'session_1',
      taskRuntimeService: setupResult.taskRuntimeService,
      subtaskRepo: setupResult.subtaskRepo,
      workUnitClaimService: {
        claim: vi.fn(),
        isClaimCurrent: vi.fn(),
      },
      executionRuntime: setupResult.executionRuntime as never,
      agentClassService: { listExecutorAgentClassNames: () => ['codex-cli', 'pi-agent'], hasExecutorAgentClass: () => true } as never,
      workspaceStore: new WorkspaceStore(`/tmp/metaclaw-heartbeat-${randomUUID()}`),
      attemptExecutionBackend: {
        kind: 'worktree',
        pathMode: 'native',
      } as AttemptExecutionBackend,
      resourceLeaseService: new ResourceLeaseService(
        new SqliteResourceLeaseRepository(setupResult.db),
      ),
      permissionRepository: new SqlitePermissionRepository(setupResult.db),
      kernelWorkflowStore: new KernelWorkflowRepo(setupResult.db),
      workspaceRepository: new SqliteWorkspaceRepository(setupResult.db),
      resultRoot: `/tmp/metaclaw-heartbeat-results-${randomUUID()}`,
      sourceRoot: '/tmp/metaclaw-heartbeat-source',
      controlNetwork: 'metaclaw-control',
    });

    runner.landHeartbeatLost({
      attemptId: 'attempt_heartbeat_lost',
      executionId: 'exec_heartbeat_lost',
      taskId: 'task_phase2',
      subtaskId: setupResult.a.id,
      workUnitId: 'executor-codex',
      ...attemptIdentity(),
    });

    expect(setupResult.db.prepare(`
      SELECT terminal_state, configuration_revision, authorized_binding_json,
             binding_fingerprint
      FROM executor_attempt_receipts
      WHERE attempt_id = 'attempt_heartbeat_lost'
    `).get()).toEqual({
      terminal_state: 'heartbeat_lost',
      configuration_revision: configurationRevision,
      authorized_binding_json: JSON.stringify(authorizedBinding),
      binding_fingerprint: bindingFingerprint,
    });
    expect(setupResult.workflow.findEvent(
      'event_attempt_heartbeat_lost_execution_outcome',
    )).toMatchObject({
      configurationRevision,
      authorizedBinding,
      bindingFingerprint,
      terminalKind: 'failed',
      attemptKind: 'fallback',
      sourceAttemptId: 'attempt_primary_failed',
    });
    expect(setupResult.db.prepare(`
      SELECT COUNT(*) AS count
      FROM kernel_events
      WHERE attempt_id = 'attempt_heartbeat_lost'
        AND event_type = 'execution_outcome'
    `).get()).toEqual({ count: 1 });
  });

  it('keeps attempt ownership for reconciliation when terminal sealing fails', async () => {
    const setupResult = setup(validResponse());
    setupResult.db.exec(`
      CREATE TRIGGER reject_runner_terminal_outcome
      BEFORE INSERT ON kernel_events
      WHEN NEW.id = 'event_attempt_terminal_blocked_execution_outcome'
      BEGIN
        SELECT RAISE(ABORT, 'injected runner terminal seal failure');
      END
    `);

    await expect(setupResult.runner.run({
      attemptId: 'attempt_terminal_blocked',
      executionId: 'exec_terminal_blocked',
      taskId: 'task_phase2',
      subtaskId: setupResult.a.id,
      ...attemptIdentity(),
      executionMode: 'fresh',
      defaultResourceGrant: setupResult.defaultResourceGrant,
    })).rejects.toThrow('injected runner terminal seal failure');

    expect(setupResult.subtaskRepo.findById(setupResult.a.id)?.status).toBe('running');
    expect(setupResult.dispatchItems.find('attempt_terminal_blocked')?.status).toBe('running');
    expect(setupResult.db.prepare(`
      SELECT COUNT(*) AS count FROM executor_attempt_receipts
      WHERE attempt_id = 'attempt_terminal_blocked'
    `).get()).toEqual({ count: 0 });
    expect(setupResult.workUnitRepo.findById('executor-codex')).toMatchObject({
      state: 'running',
      claimedTaskId: 'task_phase2',
      claimedSubtaskId: setupResult.a.id,
      claimedAttemptId: 'attempt_terminal_blocked',
    });
    expect(setupResult.db.prepare(`
      SELECT COUNT(*) AS count FROM resource_leases
      WHERE attempt_id = 'attempt_terminal_blocked' AND released_at IS NULL
    `).get()).toEqual({ count: setupResult.defaultResourceGrant.length });
  });

  it('runs a Kernel-authorized fallback from awaiting_decision without treating it as stale', async () => {
    const setupResult = setup(validResponse());
    setupResult.subtaskRepo.updateStatus(setupResult.a.id, 'awaiting_decision', { error: 'source attempt failed' });

    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_fallback', sourceAttemptId: 'attempt_source', attemptKind: 'fallback',
      recoveryMode: 'recovery_packet', executionId: 'exec_2', taskId: 'task_phase2',
      subtaskId: setupResult.a.id, ...attemptIdentity(), executionMode: 'follow-up', defaultResourceGrant: setupResult.defaultResourceGrant,
    });

    expect(outcome).toMatchObject({ outcome: 'completed', attemptId: 'attempt_fallback' });
    expect(setupResult.subtaskRepo.findById(setupResult.a.id)).toMatchObject({
      status: 'awaiting_integration',
    });
  });

  it('validates a continuation against the source attempt chain workspace baseline', async () => {
    const setupResult = setup(validResponse());
    setupResult.subtaskRepo.upsert({
      ...setupResult.a,
      deliveryKind: 'edit',
    });
    setupResult.executionRuntime.run
      .mockImplementationOnce(async input => {
        writeFileSync(
          join(input.executorInput.executionBinding.workspacePath, 'report.html'),
          '<!doctype html><html><body>complete</body></html>',
        );
        return {
          taskId: 'task_phase2',
          executionId: 'exec_source',
          status: 'success',
          executorName: 'codex-cli',
          output: 'Report created without a completion marker.',
          error: null,
          artifacts: [],
          subtaskResults: [],
          durationMs: 10,
        };
      })
      .mockResolvedValueOnce({
        taskId: 'task_phase2',
        executionId: 'exec_continuation',
        status: 'success',
        executorName: 'codex-cli',
        output: `Recovered report verified.\n\n${COMPLETION_MARKER_V4}\n${JSON.stringify({
          evidence: ['report.html exists and was verified'],
          noChangeReason: null,
        })}`,
        error: null,
        artifacts: [],
        subtaskResults: [],
        durationMs: 10,
      });

    const source = await setupResult.runner.run({
      attemptId: 'attempt_source_workspace_change',
      executionId: 'exec_source',
      taskId: 'task_phase2',
      subtaskId: setupResult.a.id,
      ...attemptIdentity(),
      executionMode: 'fresh',
      defaultResourceGrant: setupResult.defaultResourceGrant,
    });
    expect(source).toMatchObject({ outcome: 'contract_failed' });
    setupResult.workUnitRepo.updateState('executor-codex', 'idle');

    const recovered = await setupResult.runner.run({
      attemptId: 'attempt_workspace_continuation',
      sourceAttemptId: 'attempt_source_workspace_change',
      attemptKind: 'continuation',
      recoveryMode: 'recovery_packet',
      executionId: 'exec_continuation',
      taskId: 'task_phase2',
      subtaskId: setupResult.a.id,
      ...attemptIdentity(),
      executionMode: 'follow-up',
      defaultResourceGrant: setupResult.defaultResourceGrant,
    });

    expect(recovered).toMatchObject({
      outcome: 'completed',
      output: 'Recovered report verified.',
    });
    expect(setupResult.subtaskRepo.findById(setupResult.a.id)).toMatchObject({
      status: 'awaiting_integration',
    });
  });

  it('does not start a stale fallback after the Task was cancelled', async () => {
    const setupResult = setup(validResponse());
    setupResult.subtaskRepo.updateStatus(setupResult.a.id, 'awaiting_decision', { error: 'source attempt failed' });
    setupResult.taskRuntimeService.cancelTask('task_phase2', 'cancelled before retry wake');

    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_stale_fallback', sourceAttemptId: 'attempt_source', attemptKind: 'fallback',
      recoveryMode: 'recovery_packet', executionId: 'exec_2', taskId: 'task_phase2',
      subtaskId: setupResult.a.id, ...attemptIdentity(), executionMode: 'follow-up', defaultResourceGrant: setupResult.defaultResourceGrant,
    });

    expect(outcome).toMatchObject({ outcome: 'cancelled_or_stale' });
    expect(setupResult.executionRuntime.run).not.toHaveBeenCalled();
    expect(setupResult.workUnitRepo.findById('executor-codex')).toMatchObject({ state: 'idle' });
  });

  it('uses correction only for metadata and preserves the original safe business result', async () => {
    const originalBody = 'ORIGINAL_RESULT_BODY';
    const setupResult = setup(originalBody);
    const first = await setupResult.runner.run({
      attemptId: 'attempt_primary', executionId: 'exec_1', taskId: 'task_phase2', subtaskId: setupResult.a.id,
      ...attemptIdentity(), executionMode: 'fresh', defaultResourceGrant: setupResult.defaultResourceGrant,
    });
    expect(first.outcome).toBe('contract_failed');
    if (first.outcome !== 'contract_failed') return;
    setupResult.workUnitRepo.updateState('executor-codex', 'idle');
    setupResult.executionRuntime.runResponseOnly.mockResolvedValue({
      success: true,
      output: `REWRITTEN_BODY_MUST_BE_IGNORED\n\n${COMPLETION_MARKER_V4}\n${JSON.stringify({
        evidence: ['metadata repaired'],
        noChangeReason: null,
      })}`,
      exitCode: 0,
      durationMs: 5,
    });

    const corrected = await setupResult.runner.runCorrection({
      attemptId: 'attempt_correction', sourceAttemptId: first.attemptId, executionId: 'exec_1',
      taskId: 'task_phase2', subtaskId: setupResult.a.id, ...attemptIdentity(),
      completionContract: first.completionContract, violations: first.violations,
    });

    expect(corrected).toMatchObject({ outcome: 'completed', output: originalBody });
    expect(setupResult.executionRuntime.runResponseOnly).toHaveBeenCalledTimes(1);
    const correctionPrompt = setupResult.executionRuntime.runResponseOnly.mock.calls[0][1];
    expect(correctionPrompt).not.toContain(originalBody);
    expect(correctionPrompt).not.toContain('REWRITTEN_BODY_MUST_BE_IGNORED');
    expect(correctionPrompt).toContain('{"evidence":["<evidence>"],"noChangeReason":null}');
    expect(correctionPrompt).not.toContain('concise evidence');
    expect(correctionPrompt).not.toContain('Completion contract:');
    expect(correctionPrompt).not.toContain('task_phase2_a');
    expect(correctionPrompt).not.toContain('acceptanceEvidence');
    expect(setupResult.db.prepare(`
      SELECT attempt_id, terminal_state, raw_response FROM executor_attempt_receipts ORDER BY completed_at, attempt_id
    `).all()).toEqual(expect.arrayContaining([
      { attempt_id: 'attempt_primary', terminal_state: 'uncertified_result', raw_response: '' },
      { attempt_id: 'attempt_correction', terminal_state: 'completed', raw_response: '' },
    ]));
    expect(setupResult.subtaskRepo.findById(setupResult.a.id)).toMatchObject({
      status: 'done',
      result: originalBody,
    });
    const correctionReceipt = setupResult.db.prepare(`
      SELECT parsing_json FROM executor_attempt_receipts WHERE attempt_id = 'attempt_correction'
    `).get() as { parsing_json: string };
    const correctionObjects = JSON.parse(correctionReceipt.parsing_json).resultObjects as {
      businessResultId: string;
      safeProjectionId: string;
    };
    expect(correctionObjects).toMatchObject({
      businessResultId: 'result_attempt_primary_business',
      safeProjectionId: 'result_attempt_primary_safe',
    });
    expect(setupResult.db.prepare(`
      SELECT COUNT(*) AS count FROM workspace_publications
    `).get()).toEqual({ count: 0 });
    expect(setupResult.workflow.findEvent(
      'event_attempt_correction_execution_outcome',
    )).toMatchObject({
      configurationRevision,
      authorizedBinding,
      bindingFingerprint,
    });
  });

  it('rejects a correction that changes model identity within the same AgentClass', async () => {
    const setupResult = setup('first malformed response');
    const first = await setupResult.runner.run({
      attemptId: 'attempt_primary',
      executionId: 'exec_1',
      taskId: 'task_phase2',
      subtaskId: setupResult.a.id,
      ...attemptIdentity(),
      executionMode: 'fresh',
      defaultResourceGrant: setupResult.defaultResourceGrant,
    });
    expect(first.outcome).toBe('contract_failed');
    if (first.outcome !== 'contract_failed') return;
    setupResult.workUnitRepo.updateState('executor-codex', 'idle');

    const corrected = await setupResult.runner.runCorrection({
      attemptId: 'attempt_correction_other_model',
      sourceAttemptId: first.attemptId,
      executionId: 'exec_2',
      taskId: 'task_phase2',
      subtaskId: setupResult.a.id,
      ...attemptIdentity(alternateModelBinding),
      completionContract: first.completionContract,
      violations: first.violations,
    });

    expect(corrected).toMatchObject({
      outcome: 'cancelled_or_stale',
      reason: 'response-only correction binding does not match its source attempt',
    });
    expect(setupResult.executionRuntime.runResponseOnly).not.toHaveBeenCalled();
    expect(setupResult.claimAttempt).toHaveBeenCalledTimes(1);
  });

  it('rejects native continuation with a different model in the same AgentClass', async () => {
    const setupResult = setup('first malformed response');
    const first = await setupResult.runner.run({
      attemptId: 'attempt_primary',
      executionId: 'exec_1',
      taskId: 'task_phase2',
      subtaskId: setupResult.a.id,
      ...attemptIdentity(),
      executionMode: 'fresh',
      defaultResourceGrant: setupResult.defaultResourceGrant,
    });
    expect(first.outcome).toBe('contract_failed');
    setupResult.workUnitRepo.updateState('executor-codex', 'idle');

    const continued = await setupResult.runner.run({
      attemptId: 'attempt_continuation_other_model',
      sourceAttemptId: 'attempt_primary',
      attemptKind: 'continuation',
      recoveryMode: 'native_session',
      executionId: 'exec_2',
      taskId: 'task_phase2',
      subtaskId: setupResult.a.id,
      ...attemptIdentity(alternateModelBinding),
      executionMode: 'follow-up',
      defaultResourceGrant: setupResult.defaultResourceGrant,
    });

    expect(continued).toMatchObject({
      outcome: 'cancelled_or_stale',
      reason: 'continuation binding does not match its source attempt',
    });
    expect(setupResult.executionRuntime.run).toHaveBeenCalledTimes(1);
    expect(setupResult.claimAttempt).toHaveBeenCalledTimes(1);
  });

  it('wires exact Task resource rules into the production permission workflow', async () => {
    const setupResult = setup(validResponse());
    setupResult.db.prepare('UPDATE tasks SET resources_json = ? WHERE id = ?')
      .run(JSON.stringify(['report.pdf']), 'task_phase2');
    let permissionResult: { status: string; grantId: string | null } | null = null;
    setupResult.executionRuntime.run.mockImplementationOnce(async (invocation: any) => {
      const binding = invocation.executorInput.executionBinding.capabilityBinding;
      const response = await fetch(binding.jsonUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${binding.bearerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          capability: 'additional_read_resource', resource: 'report.pdf', operation: 'read',
          reason: 'inspect the Task-provided report', suggestedScope: 'once',
        }),
      });
      permissionResult = await response.json() as { status: string; grantId: string | null };
      return {
        taskId: 'task_phase2', executionId: 'exec_1', status: 'success', executorName: 'codex-cli',
        output: validResponse(), error: null, artifacts: [], subtaskResults: [], durationMs: 10,
      };
    });

    const previousControlHost = process.env.METACLAW_CONTROL_HOST;
    process.env.METACLAW_CONTROL_HOST = '127.0.0.1';
    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_registered_read', executionId: 'exec_1', taskId: 'task_phase2',
      subtaskId: setupResult.a.id, ...attemptIdentity(), executionMode: 'fresh',
      defaultResourceGrant: setupResult.defaultResourceGrant,
    }).finally(() => {
      if (previousControlHost === undefined) delete process.env.METACLAW_CONTROL_HOST;
      else process.env.METACLAW_CONTROL_HOST = previousControlHost;
    });

    expect(outcome).toMatchObject({ outcome: 'completed' });
    expect(permissionResult).toMatchObject({ status: 'granted' });
    expect(permissionResult?.grantId).toMatch(/^permission_grant_/u);
  });

  it('materializes image task resources into the image Executor inputs directory', async () => {
    const setupResult = setup(validResponse());
    const resourceRoot = `/tmp/metawork-image-resource-${randomUUID()}`;
    const imagePath = join(resourceRoot, 'black-sausage.jpg');
    mkdirSync(resourceRoot, { recursive: true });
    writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x10, 0x00, 0xff]));
    setupResult.db.prepare('UPDATE tasks SET resources_json = ? WHERE id = ?')
      .run(JSON.stringify([imagePath]), 'task_phase2');
    setupResult.a.requiredCapabilities = ['image-editing'];
    setupResult.a.contextRefs = [{ kind: 'task_resource', locator: imagePath }];
    setupResult.subtaskRepo.upsert(setupResult.a);
    let inputFiles: string[] = [];
    let inputBytes: Buffer | null = null;
    setupResult.executionRuntime.run.mockImplementationOnce(async input => {
      const inputsPath = input.executorInput.executionBinding!.inputsPath;
      inputFiles = readdirSync(inputsPath);
      inputBytes = readFileSync(join(inputsPath, inputFiles[0]!));
      return {
        taskId: 'task_phase2',
        executionId: 'exec_image_resource',
        status: 'success',
        executorName: 'codex-cli',
        output: validResponse(),
        error: null,
        artifacts: [],
        subtaskResults: [],
        durationMs: 10,
      };
    });

    try {
      await setupResult.runner.run({
        attemptId: 'attempt_image_resource',
        executionId: 'exec_image_resource',
        taskId: 'task_phase2',
        subtaskId: setupResult.a.id,
        ...attemptIdentity(),
        executionMode: 'fresh',
        defaultResourceGrant: setupResult.defaultResourceGrant,
      });

      expect(inputFiles).toHaveLength(1);
      expect(inputFiles[0]).toMatch(/\.jpg$/u);
      expect(inputBytes).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x10, 0x00, 0xff]));
    } finally {
      rmSync(resourceRoot, { recursive: true, force: true });
    }
  });

  it('combines a historical artifact and current task image resource without exposing the published path', async () => {
    const setupResult = setup(validResponse());
    const resourceRoot = `/tmp/metawork-image-context-${randomUUID()}`;
    const currentImagePath = join(resourceRoot, 'current-reference.jpg');
    const historicalImagePath = join(resourceRoot, 'historical-output.jpg');
    mkdirSync(resourceRoot, { recursive: true });
    writeFileSync(currentImagePath, Buffer.from([0xff, 0xd8, 0xff, 0x10]));
    writeFileSync(historicalImagePath, Buffer.from([0xff, 0xd8, 0xff, 0x20]));
    setupResult.db.prepare(`
      UPDATE tasks
      SET account_id = 'local-default',
          conversation_id = 'conversation-image-context',
          workspace_id = 'workspace-image-context'
      WHERE id = 'task_phase2'
    `).run();
    setupResult.db.prepare('UPDATE tasks SET resources_json = ? WHERE id = ?')
      .run(JSON.stringify([currentImagePath]), 'task_phase2');
    setupResult.db.prepare(`
      INSERT INTO task_artifacts (
        artifact_id, account_id, task_id, generation_id, subtask_id,
        publication_id, display_name, relative_path, published_path,
        media_type, preview_kind, content_hash, byte_length, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?)
    `).run(
      'artifact-historical-output',
      'local-default',
      'task_phase2',
      'generation-previous',
      'subtask-previous',
      'publication-previous',
      'historical-output.jpg',
      'metaclaw-tasks/previous/historical-output.jpg',
      historicalImagePath,
      'image/jpeg',
      'image',
      'sha256:placeholder',
      4,
      '2026-08-31T00:00:00.000Z',
      '2026-08-31T00:00:00.000Z',
    );
    const historicalHash = `sha256:${createHash('sha256').update(readFileSync(historicalImagePath)).digest('hex')}`;
    setupResult.db.prepare('UPDATE task_artifacts SET content_hash = ? WHERE artifact_id = ?')
      .run(historicalHash, 'artifact-historical-output');
    setupResult.a.requiredCapabilities = ['image-editing'];
    setupResult.a.contextRefs = [
      { kind: 'artifact', artifactId: 'artifact-historical-output' },
      { kind: 'task_resource', locator: currentImagePath },
    ];
    setupResult.subtaskRepo.upsert(setupResult.a);
    let inputFiles: string[] = [];
    let inputBytes: Buffer[] = [];
    setupResult.executionRuntime.run.mockImplementationOnce(async input => {
      const inputsPath = input.executorInput.executionBinding!.inputsPath;
      inputFiles = readdirSync(inputsPath).sort();
      inputBytes = inputFiles.map(name => readFileSync(join(inputsPath, name)));
      return {
        taskId: 'task_phase2',
        executionId: 'exec_image_context',
        status: 'success',
        executorName: 'codex-cli',
        output: validResponse(),
        error: null,
        artifacts: [],
        subtaskResults: [],
        durationMs: 10,
      };
    });

    try {
      await setupResult.runner.run({
        attemptId: 'attempt_image_context',
        executionId: 'exec_image_context',
        taskId: 'task_phase2',
        subtaskId: setupResult.a.id,
        ...attemptIdentity(),
        executionMode: 'fresh',
        defaultResourceGrant: setupResult.defaultResourceGrant,
      });

      expect(inputFiles).toEqual([
        'input-01-historical-output.jpg',
        'input-02-current-reference.jpg',
      ]);
      expect(inputBytes).toEqual([
        Buffer.from([0xff, 0xd8, 0xff, 0x20]),
        Buffer.from([0xff, 0xd8, 0xff, 0x10]),
      ]);
      expect(JSON.stringify(inputFiles)).not.toContain(historicalImagePath);
    } finally {
      rmSync(resourceRoot, { recursive: true, force: true });
    }
  });

  it('wires public network rules only for the public-web-research AgentClass profile', async () => {
    const setupResult = setup(validResponse());
    new AgentClassRepo(setupResult.db).upsert(
      builtinPiAgentClass(),
    );
    setupResult.workUnitRepo.upsert({
      id: 'executor-pi', agentClassName: 'pi-agent', agentClassKind: 'executor', state: 'idle',
      claimedTaskId: null, claimedSubtaskId: null, claimedAttemptId: null,
      heartbeatAt: null, leaseExpiresAt: null,
      createdAt: '2026-07-23T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z',
    });
    let permissionResult: { status: string; grantId: string | null } | null = null;
    setupResult.executionRuntime.run.mockImplementationOnce(async (invocation: any) => {
      const binding = invocation.executorInput.executionBinding.capabilityBinding;
      const response = await fetch(binding.jsonUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${binding.bearerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          capability: 'network_target', resource: 'https://example.com/reports/latest', operation: 'fetch',
          reason: 'retrieve a public source', suggestedScope: 'attempt',
        }),
      });
      permissionResult = await response.json() as { status: string; grantId: string | null };
      return {
        taskId: 'task_phase2', executionId: 'exec_1', status: 'success', executorName: 'pi-agent',
        output: validResponse(), error: null, artifacts: [], subtaskResults: [], durationMs: 10,
      };
    });

    const previousControlHost = process.env.METACLAW_CONTROL_HOST;
    process.env.METACLAW_CONTROL_HOST = '127.0.0.1';
    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_public_network', executionId: 'exec_1', taskId: 'task_phase2',
      subtaskId: setupResult.a.id, ...attemptIdentity(piAuthorizedBinding), executionMode: 'fresh',
      defaultResourceGrant: setupResult.defaultResourceGrant,
    }).finally(() => {
      if (previousControlHost === undefined) delete process.env.METACLAW_CONTROL_HOST;
      else process.env.METACLAW_CONTROL_HOST = previousControlHost;
    });

    expect(outcome).toMatchObject({ outcome: 'completed' });
    expect(permissionResult).toMatchObject({ status: 'granted' });
    expect(permissionResult?.grantId).toMatch(/^permission_grant_/u);
  });
});
