import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { AuthorizedExecutorBinding } from '../../src/core/authorized-executor-binding.js';
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
