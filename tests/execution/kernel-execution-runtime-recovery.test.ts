import Database from 'better-sqlite3';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  authorizedExecutorBindingFingerprint,
  type AuthorizedExecutorBinding,
} from '../../src/core/authorized-executor-binding.js';
import { KernelExecutionRuntime } from '../../src/execution/kernel-execution-runtime.js';
import type { KernelDecision, KernelEvent } from '../../src/kernel/control-kernel.js';
import { KernelWorkflowRepo } from '../../src/storage/kernel-workflow-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';

const NOW = '2026-08-13T00:00:00.000Z';
const AGENT_CLASS = 'codex-engineering';

describe('KernelExecutionRuntime executor recovery', () => {
  it('streams presentation-only heartbeats while an Executor is silent', async () => {
    let releaseAttempt!: () => void;
    const attemptReleased = new Promise<void>(resolve => {
      releaseAttempt = resolve;
    });
    const appendExecutionTrace = vi.fn();
    const runtime = new KernelExecutionRuntime({
      executionTraceHeartbeatMs: 5,
      attemptReceiptRepo: {
        findByAttemptId: vi.fn().mockReturnValue(null),
      },
      subtaskRepo: {
        findById: vi.fn().mockReturnValue({
          id: 'subtask-live',
          taskId: 'task-live',
          title: 'Research current AI news',
          goal: 'Collect and summarize the ten most important AI developments',
          deliveryKind: 'report',
          requiredCapabilities: ['public-web-research'],
          acceptance: [{
            key: 'coverage',
            description: 'Cover ten material developments.',
            requiredEvidence: ['source-backed summary'],
          }],
        }),
      },
      taskRuntimeService: {
        findTask: vi.fn().mockReturnValue({
          id: 'task-live',
          status: 'running',
        }),
        attachResource: vi.fn(),
      },
      attemptRunner: {
        run: vi.fn(async () => {
          await attemptReleased;
          return {
            outcome: 'capacity_unavailable',
            attemptId: 'attempt-live',
            agentClassName: AGENT_CLASS,
          };
        }),
      },
      presentation: {
        formatExecutorDispatch: vi.fn().mockReturnValue([]),
      },
      callbacks: {
        appendExecutionTrace,
        appendOutput: vi.fn(),
        setRunningExecutorName: vi.fn(),
        clearRunningExecutorName: vi.fn(),
      },
      kernelExecutorStatusProjector: { recordExecutionOutcome: vi.fn() },
      taskEventRepo: {},
      dispatchItemRepo: {},
      maxConcurrentAttempts: 4,
    } as never);

    const running = (runtime as unknown as {
      runDispatchItem(input: Record<string, unknown>): Promise<KernelEvent>;
    }).runDispatchItem({
      item: {
        ...historicalDispatch(),
        attemptId: 'attempt-live',
        taskId: 'task-live',
        subtaskId: 'subtask-live',
        authorizedBinding: binding('revision-a'),
        status: 'running',
      },
      executionId: 'execution-live',
      request: {},
      progressTracker: { onProgress: vi.fn() },
    });

    await vi.waitFor(() => {
      expect(appendExecutionTrace).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'executor_heartbeat',
        status: 'running',
        details: expect.objectContaining({
          subtaskId: 'subtask-live',
          attemptId: 'attempt-live',
          lastProgressKind: 'dispatch_started',
        }),
      }));
    });

    releaseAttempt();
    await running;
    const heartbeatCount = appendExecutionTrace.mock.calls.filter(
      ([event]) => event.kind === 'executor_heartbeat',
    ).length;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(appendExecutionTrace.mock.calls.filter(
      ([event]) => event.kind === 'executor_heartbeat',
    )).toHaveLength(heartbeatCount);
  });

  it('does not project a safe uncertified receipt as an Executor health failure', () => {
    const recordExecutionOutcome = vi.fn();
    const runtime = new KernelExecutionRuntime({
      kernelExecutorStatusProjector: { recordExecutionOutcome },
      taskEventRepo: {},
      dispatchItemRepo: {},
      maxConcurrentAttempts: 4,
    } as never);

    (runtime as unknown as {
      projectPersistedReceipt(receipt: Record<string, unknown>): void;
    }).projectPersistedReceipt({
      attemptId: 'attempt-uncertified',
      agentClassName: AGENT_CLASS,
      configurationRevision: 'revision-a',
      terminalState: 'uncertified_result',
      failure: null,
      completedAt: NOW,
    });

    expect(recordExecutionOutcome).not.toHaveBeenCalled();
  });

  it('delivers an upgraded historical result without re-running the Harness', async () => {
    const recordResultDelivery = vi.fn();
    const appendOutput = vi.fn();
    const runAttempt = vi.fn();
    const runtime = new KernelExecutionRuntime({
      attemptReceiptRepo: {
        findByAttemptId: vi.fn().mockReturnValue({
          ...historicalReceipt(),
          terminalState: 'contract_blocked',
        }),
      },
      historicalResultUpgrader: {
        upgrade: vi.fn().mockReturnValue({
          resultId: 'result_attempt-historical_safe',
          content: 'Recovered historical body',
          completeness: 'partial',
          certification: 'uncertified',
        }),
      },
      attemptRunner: { run: runAttempt },
      callbacks: {
        recordResultDelivery,
        appendOutput,
      },
      kernelExecutorStatusProjector: { recordExecutionOutcome: vi.fn() },
      taskEventRepo: {},
      dispatchItemRepo: {},
      maxConcurrentAttempts: 4,
    } as never);

    const event = await (runtime as unknown as {
      runDispatchItem(input: Record<string, unknown>): Promise<KernelEvent>;
    }).runDispatchItem({
      item: historicalDispatch(),
      executionId: 'execution-recovery',
      request: {},
      progressTracker: {},
    });

    expect(runAttempt).not.toHaveBeenCalled();
    expect(recordResultDelivery).toHaveBeenCalledWith({
      resultId: 'result_attempt-historical_safe',
      content: 'Recovered historical body',
      completeness: 'partial',
      certification: 'uncertified',
    });
    expect(appendOutput).toHaveBeenCalledWith(
      'Recovered historical body',
      '',
      '结果已返回，任务完成认证待处理。',
    );
    expect(event).toMatchObject({
      type: 'execution_result_observed',
      attemptId: 'attempt-historical',
      resultId: 'result_attempt-historical_safe',
      deliverability: 'deliverable',
      certification: 'uncertified',
      safety: 'safe',
    });
  });

  it('reuses one durable merge conflict identity for duplicate failures at the same repair budget', async () => {
    const publication = {
      id: 'publication-merge',
      conflictChainId: 'conflict-chain-merge',
      sourceAttemptId: 'attempt-primary',
      repairAttemptsUsed: 1,
      conflictReplansUsed: 0,
    };
    const runtime = new KernelExecutionRuntime({
      attemptReceiptRepo: {
        findByAttemptId: vi.fn().mockReturnValue(null),
      },
      subtaskRepo: {
        findById: vi.fn().mockReturnValue({
          id: 'subtask-merge',
          taskId: 'task-merge',
          title: 'Repair report publication',
          goal: 'Repair the publication conflict',
          deliveryKind: 'edit',
          requiredCapabilities: ['workspace-engineering'],
          acceptance: [],
        }),
      },
      taskRuntimeService: {
        findTask: vi.fn().mockReturnValue({
          id: 'task-merge',
          status: 'running',
        }),
      },
      attemptRunner: {
        run: vi.fn().mockResolvedValue({
          outcome: 'cancelled_or_stale',
          attemptId: 'ignored-by-runtime',
          reason: 'duplicate repair dispatch is stale',
        }),
      },
      publicationRepo: {
        find: vi.fn().mockReturnValue(publication),
      },
      presentation: {
        formatExecutorDispatch: vi.fn().mockReturnValue([]),
      },
      callbacks: {
        appendExecutionTrace: vi.fn(),
        appendOutput: vi.fn(),
        setRunningExecutorName: vi.fn(),
        clearRunningExecutorName: vi.fn(),
      },
      kernelExecutorStatusProjector: { recordExecutionOutcome: vi.fn() },
      taskEventRepo: {},
      dispatchItemRepo: {},
      maxConcurrentAttempts: 4,
    } as never);
    const run = (attemptId: string) => (runtime as unknown as {
      runDispatchItem(input: Record<string, unknown>): Promise<KernelEvent>;
    }).runDispatchItem({
      item: {
        ...historicalDispatch(),
        attemptId,
        taskId: 'task-merge',
        subtaskId: 'subtask-merge',
        attemptKind: 'merge_repair',
        sourceAttemptId: 'attempt-primary',
        attemptPayload: {
          protocol: 'metaclaw:merge-repair:v1',
          publicationId: publication.id,
          conflictChainId: publication.conflictChainId,
          conflictingPaths: ['src/shared.ts'],
        },
        authorizedBinding: binding('revision-a'),
        status: 'running',
      },
      executionId: 'execution-merge',
      request: {},
      progressTracker: { onProgress: vi.fn() },
    });

    const first = await run('attempt-merge-a');
    const duplicate = await run('attempt-merge-b');

    expect(first).toMatchObject({
      type: 'merge_conflict_observed',
      repairAttemptsUsed: 1,
    });
    expect(duplicate.id).toBe(first.id);
  });

  it('restores a legacy blocked Subtask only while applying an authorized merge repair dispatch', async () => {
    const updateStatus = vi.fn();
    const enqueue = vi.fn();
    const runtime = new KernelExecutionRuntime({
      workGraphRevisionRepo: {
        findActive: vi.fn().mockReturnValue({
          generationId: 'generation-merge',
        }),
      },
      subtaskRepo: {
        findById: vi.fn().mockReturnValue({
          id: 'subtask-merge',
          taskId: 'task-merge',
          status: 'blocked',
        }),
        updateStatus,
      },
      callbacks: {
        appendExecutionTrace: vi.fn(),
      },
      taskEventRepo: {},
      dispatchItemRepo: {
        listPending: vi.fn().mockReturnValue([]),
      },
      maxConcurrentAttempts: 4,
    } as never);
    Object.defineProperty(runtime, 'attemptSupervisor', {
      value: { enqueue },
    });
    const decision: KernelDecision = {
      schemaVersion: 5,
      configurationRevision: 'revision-a',
      id: 'decision-merge-repair',
      eventId: 'event-merge-conflict',
      reason: 'merge repair 2 of 3 authorized',
      action: {
        type: 'dispatch_batch',
        taskId: 'task-merge',
        items: [{
          order: 0,
          subtaskId: 'subtask-merge',
          attemptId: 'attempt-merge-repair',
          authorizedBinding: binding('revision-a'),
          bindingFingerprint: 'binding-fingerprint',
          attemptKind: 'merge_repair',
          sourceAttemptId: 'attempt-primary',
          recoveryMode: 'recovery_packet',
          attemptPayload: {
            protocol: 'metaclaw:merge-repair:v1',
            publicationId: 'publication-merge',
            conflictChainId: 'conflict-chain-merge',
            conflictingPaths: ['src/shared.ts'],
          },
          defaultResourceGrant: [],
        }],
      },
    };

    await (runtime as unknown as {
      applyExecutionDecision(input: Record<string, unknown>): Promise<KernelEvent | null>;
    }).applyExecutionDecision({
      decision,
      executionId: 'execution-merge',
      request: {},
      progressTracker: {},
      supervisorContext: {},
      attemptFacts: [],
      finishExecution: vi.fn(),
    });

    expect(updateStatus).toHaveBeenCalledWith(
      'subtask-merge',
      'awaiting_decision',
      { error: 'recovering legacy blocked merge conflict' },
    );
    expect(updateStatus.mock.invocationCallOrder[0]).toBeLessThan(
      enqueue.mock.invocationCallOrder[0]!,
    );
  });

  it('applies an authorized uncertified-result resume without clearing awaiting_decision', async () => {
    const updateStatus = vi.fn();
    const unblockTask = vi.fn();
    const transitionTask = vi.fn();
    const runtime = new KernelExecutionRuntime({
      taskRuntimeService: {
        findTask: vi.fn().mockReturnValue({ id: 'task-resume', status: 'running' }),
        unblockTask,
        transitionTask,
      },
      subtaskRepo: {
        findById: vi.fn().mockReturnValue({
          id: 'subtask-resume',
          taskId: 'task-resume',
          status: 'awaiting_decision',
        }),
        updateStatus,
      },
      callbacks: {
        appendExecutionTrace: vi.fn(),
        refreshRuntimeState: vi.fn(),
      },
      taskEventRepo: {},
      dispatchItemRepo: {},
      maxConcurrentAttempts: 4,
    } as never);
    const authorizedBinding = binding('revision-a');
    const decision: KernelDecision = {
      schemaVersion: 5,
      configurationRevision: 'revision-a',
      id: 'decision-resume-uncertified',
      eventId: 'event-resume-uncertified',
      reason: 'Kernel authorized exact uncertified-result recovery',
      action: {
        type: 'resume_task',
        taskId: 'task-resume',
        generationId: 'generation-resume',
        graphRevision: 3,
        subtaskIds: [],
        blockerCategory: 'unknown',
        recovery: {
          subtaskId: 'subtask-resume',
          sourceAttemptId: 'attempt-uncertified',
          authorizedBinding,
          bindingFingerprint: 'sha256:binding',
          attemptKind: 'continuation',
          recoveryMode: 'recovery_packet',
          defaultResourceGrant: [],
        },
      },
    };

    const nextEvent = await (runtime as unknown as {
      applyExecutionDecision(input: Record<string, unknown>): Promise<KernelEvent | null>;
    }).applyExecutionDecision({
      decision,
      executionId: 'execution-resume',
      request: {},
      progressTracker: {},
      supervisorContext: {},
      attemptFacts: [],
      finishExecution: vi.fn(),
    });

    expect(updateStatus).not.toHaveBeenCalled();
    expect(unblockTask).not.toHaveBeenCalled();
    expect(transitionTask).not.toHaveBeenCalled();
    expect(nextEvent).toMatchObject({
      type: 'dispatch_requested',
      taskId: 'task-resume',
      subtaskId: 'subtask-resume',
      recovery: {
        authorizedBinding,
        bindingFingerprint: 'sha256:binding',
        attemptKind: 'continuation',
        sourceAttemptId: 'attempt-uncertified',
        recoveryMode: 'recovery_packet',
        defaultResourceGrant: [],
      },
    });
  });

  it('projects a marker-only uncertified receipt with an active workspace as a resume candidate', () => {
    const authorizedBinding = binding('revision-a');
    const runtime = new KernelExecutionRuntime({
      taskRuntimeService: {
        findTask: vi.fn().mockReturnValue({ id: 'task-resume', status: 'blocked' }),
        getCurrentRunningTask: vi.fn().mockReturnValue(null),
      },
      workGraphRevisionRepo: {
        findActive: vi.fn().mockReturnValue({
          taskId: 'task-resume',
          generationId: 'generation-resume',
          revision: 3,
          configurationRevision: 'revision-a',
        }),
        countAutomaticReplans: vi.fn().mockReturnValue(0),
      },
      subtaskRepo: {
        listActiveByTask: vi.fn().mockReturnValue([{
          id: 'subtask-resume',
          taskId: 'task-resume',
          generationId: 'generation-resume',
          graphRevision: 3,
          title: 'Build HTML report',
          goal: 'Publish the completed HTML report',
          status: 'awaiting_decision',
          dependencies: [],
          requiredCapabilities: ['workspace-engineering'],
          executorBindings: [authorizedBinding],
        }]),
      },
      subtaskHandoffRepo: {
        listByTask: vi.fn().mockReturnValue([]),
      },
      attemptReceiptRepo: {
        listByTask: vi.fn().mockReturnValue([{
          ...historicalReceipt(),
          attemptId: 'attempt-uncertified',
          taskId: 'task-resume',
          subtaskId: 'subtask-resume',
          generationId: 'generation-resume',
          graphRevision: 3,
          terminalState: 'uncertified_result',
          failure: null,
          configurationRevision: 'revision-a',
          authorizedBinding,
          bindingFingerprint: authorizedExecutorBindingFingerprint(authorizedBinding),
          verification: {
            warnings: [],
            violations: [{
              code: 'completion_no_change_reason_mismatch',
              path: 'noChangeReason',
              message: 'edit delivery without workspace changes requires a no-change reason',
            }],
          },
        }]),
      },
      dispatchItemRepo: {
        listByTask: vi.fn().mockReturnValue([]),
      },
      workspaceRepository: {
        findByIdentity: vi.fn().mockReturnValue({
          id: 'workspace-resume',
          status: 'active',
          rootUri: pathToFileURL(process.cwd()).href,
        }),
      },
      resultObjectRepo: {},
      publicationRepo: {
        hasBlockingResidue: vi.fn().mockReturnValue(false),
      },
      generationReplanRepo: {
        findActive: vi.fn().mockReturnValue(null),
      },
      cancellationCoordinator: {
        findCleanupTaskId: vi.fn().mockReturnValue(null),
        completionBlockedReasons: vi.fn().mockReturnValue([]),
      },
      taskEventRepo: {},
      maxConcurrentAttempts: 4,
    } as never);

    const snapshot = (runtime as unknown as {
      buildDispatchSnapshot(
        taskId: string,
        graphState: 'ready',
        stableFacts: Record<string, unknown>,
      ): Extract<import('../../src/kernel/control-kernel.js').KernelSnapshot, { type: 'dispatch' }>;
    }).buildDispatchSnapshot('task-resume', 'ready', {
      executorStatuses: [],
      correctionSupportedAgentClasses: [],
      nativeContinuationAgentClasses: [AGENT_CLASS],
    });

    expect(snapshot.resumeRecoveryCandidates).toEqual([{
      subtaskId: 'subtask-resume',
      sourceAttemptId: 'attempt-uncertified',
      authorizedBinding,
      bindingFingerprint: authorizedExecutorBindingFingerprint(authorizedBinding),
      recoveryMode: 'native_session',
      reason: 'completion_no_change_reason_mismatch',
    }]);
  });

  it('resolves only waiting requests pinned to the recovered configuration revision', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    insertConfigurationRevision(db, 'revision-a');
    insertConfigurationRevision(db, 'revision-b');

    const requests = [
      waitingRequest('request-a', 'task-a', 'revision-a'),
      waitingRequest('request-b', 'task-b', 'revision-b'),
    ];
    const resolve = vi.fn();
    const apply = vi.fn().mockReturnValue({
      outcome: 'applied',
      workGraph: requests[0]!.deferredPlan!.proposal.workGraph,
      subtasks: [],
    });
    const unblockTask = vi.fn();
    const runtime = new KernelExecutionRuntime({
      sessionId: 'session-recovery',
      generationReplanRepo: {
        listWaitingForAvailability: vi.fn().mockReturnValue(requests),
        find: vi.fn((id: string) => requests.find(request => request.id === id) ?? null),
        resolve,
      },
      taskRuntimeService: {
        findTask: vi.fn((taskId: string) => ({
          id: taskId,
          title: taskId,
          goal: `Recover ${taskId}`,
          status: 'blocked',
        })),
        unblockTask,
      },
      workGraphRevisionRepo: {
        findActive: vi.fn((taskId: string) => ({
          id: `active-${taskId}`,
          taskId,
          revision: 1,
          generationId: `generation-${taskId}`,
          configurationRevision: taskId === 'task-a' ? 'revision-a' : 'revision-b',
          authorizedDecisionId: 'decision-initial',
          proposalSource: 'initial',
          automaticReplan: false,
          status: 'active',
          completionKind: null,
          createdAt: NOW,
          updatedAt: NOW,
        })),
      },
      kernelExecutorStatusProjector: {
        list: vi.fn().mockReturnValue([]),
      },
      controlKernel: {
        decide: vi.fn((event: KernelEvent): KernelDecision => {
          const request = requests.find(item => item.id === event.correlationId)!;
          const subtask = request.deferredPlan!.proposal.workGraph!.subtasks[0]!;
          return {
            schemaVersion: 5,
            configurationRevision: request.configurationRevision,
            id: `decision-${event.id}`,
            eventId: event.id,
            reason: 'matching revision recovered',
            action: {
              type: 'activate_deferred_task_plan',
              taskId: request.taskId,
              replanRequestId: request.id,
              task: request.deferredPlan!.proposal.task!,
              workGraph: request.deferredPlan!.proposal.workGraph!,
              authorizedBindingsBySubtask: {
                [subtask.id]: request.deferredBindings,
              },
              generationId: request.generationId,
              graphRevision: 2,
              proposalSource: 'replan',
            },
          };
        }),
      },
      kernelWorkflowStore: new KernelWorkflowRepo(db),
      workGraphRuntimeService: { apply },
      callbacks: { refreshRuntimeState: vi.fn() },
      taskEventRepo: {},
      dispatchItemRepo: {},
      maxConcurrentAttempts: 4,
    } as never);

    await runtime.executorRecovered(AGENT_CLASS, 'revision-a', 'check-a');

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('request-a', expect.any(String));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ id: 'task-a' }),
      authorizedBindingsBySubtask: {
        'subtask-task-a': [binding('revision-a')],
      },
    }));
    expect(unblockTask).toHaveBeenCalledWith('task-a');
    expect(unblockTask).not.toHaveBeenCalledWith('task-b');

    const persistedEvents = db.prepare(`
      SELECT correlation_id, configuration_revision
      FROM kernel_events
      WHERE event_type = 'executor_recovered'
      ORDER BY correlation_id
    `).all();
    expect(persistedEvents).toEqual([{
      correlation_id: 'request-a',
      configuration_revision: 'revision-a',
    }]);
  });

  it('scans uncertain merge-replan applications and emits the exact safe retry event', () => {
    const application = {
      id: 'application-merge-replan',
      decisionId: 'decision-merge-replan',
      eventId: 'event-merge-replan',
      idempotencyKey: 'decision:decision-merge-replan',
      status: 'uncertain',
      applyAttempts: 1,
      observationEvent: null,
      errorSummary: 'startup recovery requires the originating Conversation Planner for merge replan',
      createdAt: NOW,
      updatedAt: NOW,
      decision: {
        schemaVersion: 5,
        configurationRevision: 'revision-a',
        id: 'decision-merge-replan',
        eventId: 'event-merge-conflict',
        reason: 'merge repair exhausted; request semantic replan',
        action: {
          type: 'request_merge_replan',
          taskId: 'task-merge-replan',
          publicationId: 'publication-merge-replan',
          conflictChainId: 'conflict-chain-merge-replan',
          conflictedSubtaskId: 'subtask-old',
        },
      },
    };
    const runtime = new KernelExecutionRuntime({
      workGraphRevisionRepo: {
        findActive: vi.fn().mockReturnValue({
          taskId: 'task-merge-replan',
          generationId: 'generation-merge-replan',
          revision: 2,
        }),
      },
      kernelWorkflowStore: {
        listRecoveryItems: vi.fn().mockReturnValue([application]),
      },
      publicationRepo: {
        find: vi.fn().mockReturnValue({
          id: 'publication-merge-replan',
          taskId: 'task-merge-replan',
          status: 'parked',
        }),
      },
      dispatchItemRepo: {
        listByTask: vi.fn().mockReturnValue([{
          attemptKind: 'merge_repair',
          status: 'terminal',
          attemptPayload: {
            protocol: 'metaclaw:merge-repair:v1',
            publicationId: 'publication-merge-replan',
            conflictChainId: 'conflict-chain-merge-replan',
            conflictingPaths: ['reports/zhipu.html'],
          },
          errorSummary: 'EACCES: permission denied, open \'/workspace/.metaclaw/merge-repair/reports/zhipu.html.base\'',
        }]),
      },
      kernelDecisionRepo: {
        findById: vi.fn().mockReturnValue({
          id: 'decision-merge-replan',
          sessionId: 'session-originating-planner',
        }),
      },
      taskEventRepo: {},
      maxConcurrentAttempts: 4,
    } as never);

    const event = (runtime as unknown as {
      retrySafeLegacySystemBindingRecovery(
        taskId: string,
        occurredAt: string,
      ): KernelEvent | null;
    }).retrySafeLegacySystemBindingRecovery(
      'task-merge-replan',
      '2026-08-25T05:00:00.000Z',
    );

    expect(event).toMatchObject({
      type: 'recovery_resolution_requested',
      taskId: 'task-merge-replan',
      recoveryItemId: 'application-merge-replan',
      resolution: 'retry',
      sessionId: 'session-originating-planner',
    });
  });
});

function historicalReceipt() {
  return {
    attemptId: 'attempt-historical',
    executionId: 'execution-historical',
    taskId: 'task-historical',
    subtaskId: 'subtask-historical',
    graphRevision: 1,
    generationId: 'generation-historical',
    attemptKind: 'primary' as const,
    sourceAttemptId: null,
    failure: null,
    recoveryMode: 'fresh' as const,
    workUnitId: 'work-unit-historical',
    agentClassName: AGENT_CLASS,
    configurationRevision: 'revision-a',
    authorizedBinding: binding('revision-a'),
    bindingFingerprint: 'sha256:historical-binding',
    startedAt: NOW,
    completedAt: NOW,
    terminalState: 'contract_blocked' as const,
    rawResponse: 'historical body',
    completionSchemaVersion: 3,
    parsing: { completionContract: { protocol: 'v3' } },
    verification: {
      warnings: [],
      violations: [{
        code: 'completion_malformed' as const,
        path: 'report',
        message: 'historical metadata failure',
      }],
    },
    errorCode: 'completion_malformed',
    errorDetail: 'historical metadata failure',
  };
}

function historicalDispatch() {
  return {
    attemptId: 'attempt-historical',
    decisionId: 'decision-historical',
    batchOrder: 0,
    taskId: 'task-historical',
    generationId: 'generation-historical',
    subtaskId: 'subtask-historical',
    agentClassName: AGENT_CLASS,
    authorizedBinding: binding('revision-a'),
    bindingFingerprint: 'sha256:historical-binding',
    configurationRevision: 'revision-a',
    attemptKind: 'primary' as const,
    sourceAttemptId: null,
    recoveryMode: 'fresh' as const,
    attemptPayload: null,
    defaultResourceGrant: [],
    status: 'terminal' as const,
    backendExecutionId: null,
    errorDetail: null,
    createdAt: NOW,
    updatedAt: NOW,
    terminalAt: NOW,
  };
}

function waitingRequest(id: string, taskId: string, configurationRevision: string) {
  const authorizedBinding = binding(configurationRevision);
  return {
    id,
    taskId,
    generationId: `generation-${taskId}`,
    sourceRevision: 1,
    configurationRevision,
    status: 'waiting_for_availability' as const,
    triggerDecisionId: `trigger-${id}`,
    quiescenceToken: `quiescence-${id}`,
    errorSummary: null,
    deferredPlan: {
      schemaVersion: 5 as const,
      configurationRevision,
      type: 'plan_proposed' as const,
      id: `plan-${id}`,
      correlationId: id,
      causationId: id,
      occurredAt: NOW,
      sessionId: 'session-recovery',
      taskId,
      requestText: `Recover ${taskId}`,
      generationId: `generation-${taskId}`,
      proposalSource: 'replan' as const,
      targetGraphRevision: 2,
      proposal: {
        task: {
          title: taskId,
          goal: `Recover ${taskId}`,
        },
        workGraph: {
          schemaVersion: 7 as const,
          configurationRevision,
          reason: 'recovery test',
          subtasks: [{
            id: `subtask-${taskId}`,
            title: 'Execute',
            goal: 'Execute recovered work',
            dependencies: [],
            contextRefs: [],
            requiredCapabilities: ['workspace-engineering'],
            executorBindings: [{ agentClassRef: AGENT_CLASS }],
            deliveryKind: 'report' as const,
            acceptance: [],
            riskLevel: 'low' as const,
          }],
        },
      },
    },
    deferredBindings: [authorizedBinding],
    availabilityExplanation: 'waiting for executor recovery',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function binding(configurationRevision: string): AuthorizedExecutorBinding {
  return {
    agentClassRef: AGENT_CLASS,
    harnessRef: 'codex-cli',
    providerRef: 'openai',
    modelRef: 'engineering-model',
    permissionProfileRef: 'workspace-default',
    configurationRevision,
  };
}

function insertConfigurationRevision(db: Database.Database, revisionId: string): void {
  db.prepare(`
    INSERT INTO configuration_revisions (
      revision_id, content_hash, source_kind, imported_at
    ) VALUES (?, ?, 'native', ?)
  `).run(revisionId, `sha256:${revisionId}`, NOW);
}
