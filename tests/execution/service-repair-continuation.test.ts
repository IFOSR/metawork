import { describe, expect, it, vi } from 'vitest';
import { recordingTaskStateAuthority } from '../support/task-state-fixture.js';
import type { AuthorizedExecutorBinding } from '../../src/core/authorized-executor-binding.js';
import { authorizedExecutorBindingFingerprint } from '../../src/core/authorized-executor-binding.js';
import { KernelExecutionRuntime } from '../../src/execution/kernel-execution-runtime.js';
import { ControlKernel, type KernelEvent, type KernelSnapshot } from '../../src/kernel/control-kernel.js';
import type { LocalServiceSpecification } from '../../src/task/local-service.js';
import { localServiceSpecificationRevision } from '../../src/core/local-service-revision.js';

const binding: AuthorizedExecutorBinding = {
  agentClassRef: 'pi-engineering',
  harnessRef: 'pi',
  providerRef: 'provider',
  modelRef: 'model',
  permissionProfileRef: 'workspace-write',
  configurationRevision: 'revision-1',
} as AuthorizedExecutorBinding;
const fingerprint = authorizedExecutorBindingFingerprint(binding);

const specification: LocalServiceSpecification = {
  serviceId: 'backend',
  taskId: 'task-1',
  command: 'node',
  args: ['server.mjs'],
  environmentReferences: {},
  host: '127.0.0.1',
  port: 8811,
  healthPath: '/health',
  startupTimeoutMs: 2000,
  restartPolicy: 'explicit',
};

function runtimeWith(overrides: {
  receipts?: unknown[];
  dispatchItems?: unknown[];
  subtaskStatus?: string;
  subtaskStatuses?: Record<string, string>;
  fileOutputs?: string[];
  serviceObservation?: unknown;
  taskStatus?: string;
  attemptRuntime?: { workspaceDelta: unknown } | null;
}) {
  const operations: Array<Record<string, unknown>> = [];
  const traces: Array<Record<string, unknown>> = [];
  const outputs: string[] = [];
  const transitions: Array<{ to: string }> = [];
  const submitted: KernelEvent[] = [];
  const taskState = recordingTaskStateAuthority();
  let subtaskStatus = overrides.subtaskStatus ?? 'done';
  const runtime = new KernelExecutionRuntime({
    callbacks: {
      appendOutput: (...parts: string[]) => { outputs.push(parts.join(' ')); },
      appendExecutionTrace: (input: Record<string, unknown>) => { traces.push(input); },
      refreshRuntimeState: () => undefined,
      recordResultDelivery: () => undefined,
    },
    taskStateAuthority: taskState.authority,
    taskOperationResults: {
      record: (record: Record<string, unknown>) => { operations.push(record); },
    },
    taskRuntimeService: {
      findTask: () => ({ id: 'task-1', status: overrides.taskStatus ?? 'running', goal: 'run the service' }),
    },
    subtaskRepo: {
      findById: (id: string) => ({
        id,
        taskId: 'task-1',
        status: overrides.subtaskStatuses?.[id] ?? subtaskStatus,
        generationId: 'generation-1',
        executorBindings: [binding],
        fileOutputs: overrides.fileOutputs ?? [],
      }),
      listActiveByTask: () => [],
      updateStatus: (_id: string, status: string) => {
        subtaskStatus = status;
        transitions.push({ to: status });
      },
    },
    workGraphRevisionRepo: {
      findActive: () => ({ generationId: 'generation-1', revision: 1, configurationRevision: 'revision-1' }),
    },
    attemptReceiptRepo: {
      listByTask: () => overrides.receipts ?? [{
        attemptId: 'attempt-producer',
        taskId: 'task-1',
        subtaskId: 'subtask-1',
        generationId: 'generation-1',
        terminalState: 'completed',
        authorizedBinding: binding,
        bindingFingerprint: fingerprint,
      }],
    },
    dispatchItemRepo: {
      listByTask: () => overrides.dispatchItems ?? [],
      insertBatch: vi.fn(),
    },
    managedLocalServices: {
      observe: async () => overrides.serviceObservation ?? {
        view: { serviceId: 'backend', taskId: 'task-1', state: 'failed', url: 'http://127.0.0.1:8811', message: '服务进程已退出，需显式重启' },
        diagnostics: {
          workspaceId: 'workspace-1',
          specificationRevision: localServiceSpecificationRevision(specification),
          processId: 42,
          exitObserved: true,
          logTail: 'Error: listen EADDRINUSE',
          healthStatus: null,
          retryable: true,
        },
      },
    },
    agentClassService: { listExecutorAgentClassNames: () => ['pi-engineering'] },
    kernelExecutorStatusProjector: { list: () => [] },
    attemptRunner: { supportsContinuation: () => true, supportsResponseOnly: () => true },
    maxConcurrentAttempts: 4,
  } as never);
  return { runtime, operations, traces, outputs, transitions, submitted, taskState };
}

const view = {
  serviceId: 'backend',
  taskId: 'task-1',
  state: 'failed' as const,
  url: 'http://127.0.0.1:8811',
  message: '服务进程已退出，需显式重启',
};

describe('service repair continuation', () => {
  it('records a bounded repair request instead of a final failure', async () => {
    const { runtime, operations, traces, outputs, transitions } = runtimeWith({});
    const projection = runtime as unknown as {
      requestServiceRepair(input: Record<string, unknown>): Promise<boolean>;
    };
    const dispatched = await projection.requestServiceRepair({
      taskId: 'task-1',
      spec: specification,
      workspaceId: 'workspace-1',
      view,
      // No workflow: the durable request waits for the next drive.
    });
    expect(dispatched).toBe(false);
    const failure = operations.find(record => record.operationKind === 'service');
    expect(failure).toMatchObject({
      taskId: 'task-1',
      outcome: 'repair_pending',
      reasonCode: 'service_start_failed',
    });
    // Item 7: the idempotency key names the source Attempt, revision and round.
    expect(String(failure!.operationKey)).toBe(
      `service:start:backend:${localServiceSpecificationRevision(specification)}:attempt-producer:0`,
    );
    expect(String(failure!.message)).toContain('服务进程已退出');
    // The real diagnosis reaches the user, and the trace keeps the repair input.
    expect(outputs.join('\n')).toContain('Error: listen EADDRINUSE');
    const trace = traces.at(-1) as { kind: string; details: { service: Record<string, unknown> } };
    expect(trace.kind).toBe('service_verification_failed');
    expect(trace.details.service).toMatchObject({
      serviceId: 'backend',
      workspaceId: 'workspace-1',
      exitObserved: true,
      retryable: true,
      repairOrdinal: 0,
      budgetExhausted: false,
    });
    expect(trace.details.service.logTail).toBe('Error: listen EADDRINUSE');
    // No workflow means no authorization yet: the completed node must stay
    // completed so the next drive can still find the repair target.
    expect(transitions).toEqual([]);
  });

  it('dispatches one Kernel-authorized continuation for the same Executor', async () => {
    const { runtime, submitted, transitions } = runtimeWith({});
    const drain = vi.fn().mockResolvedValue(undefined);
    (runtime as unknown as { attemptSupervisor: { drain: typeof drain } }).attemptSupervisor.drain = drain;
    const projection = runtime as unknown as {
      requestServiceRepair(input: Record<string, unknown>): Promise<boolean>;
    };
    const workflow = {
      submit: vi.fn(async (event: KernelEvent) => {
        submitted.push(event);
        return {
          decisions: [{
            eventId: event.id,
            action: { type: 'dispatch_batch', taskId: 'task-1', items: [{ subtaskId: 'subtask-1' }] },
          }],
        };
      }),
    };
    const dispatched = await projection.requestServiceRepair({
      taskId: 'task-1',
      spec: specification,
      workspaceId: 'workspace-1',
      view,
      workflow,
    });
    expect(dispatched).toBe(true);
    expect(workflow.submit).toHaveBeenCalledTimes(1);
    // The completed node remains unchanged until the authorized dispatch is
    // applied. The workflow event is the durable recovery boundary.
    expect(transitions).toEqual([]);
    expect(drain).toHaveBeenCalledWith('task-1');
    const event = submitted[0] as Extract<KernelEvent, { type: 'dispatch_requested' }>;
    expect(event.type).toBe('dispatch_requested');
    expect(event.subtaskId).toBe('subtask-1');
    expect(event.recovery).toMatchObject({
      attemptKind: 'continuation',
      sourceAttemptId: 'attempt-producer',
      bindingFingerprint: fingerprint,
      recoveryMode: 'native_session',
      authorizedBinding: { agentClassRef: 'pi-engineering' },
    });
    const payload = event.recovery!.attemptPayload as Extract<
      NonNullable<typeof event.recovery>,
      { attemptPayload: unknown }
    >['attemptPayload'] as Record<string, unknown>;
    expect(payload).toMatchObject({
      protocol: 'metawork:service-repair:v1',
      serviceId: 'backend',
      repairOrdinal: 0,
      failure: { kind: 'service', code: 'service_start_failed' },
    });
    expect((payload.service as Record<string, unknown>).logTail).toContain('EADDRINUSE');
  });

  it('stops repairing when the Kernel budget is exhausted and reports the real error', async () => {
    const repairRounds = [0, 1, 2].map(index => ({
      attemptId: `repair-${index}`,
      subtaskId: 'subtask-1',
      status: 'terminal',
      attemptPayload: { protocol: 'metawork:service-repair:v1', repairOrdinal: index },
    }));
    const { runtime, operations, outputs } = runtimeWith({ dispatchItems: repairRounds });
    const projection = runtime as unknown as {
      requestServiceRepair(input: Record<string, unknown>): Promise<boolean>;
    };
    const workflow = { submit: vi.fn() };
    const dispatched = await projection.requestServiceRepair({
      taskId: 'task-1',
      spec: specification,
      workspaceId: 'workspace-1',
      view,
      workflow,
    });
    expect(dispatched).toBe(false);
    expect(workflow.submit).not.toHaveBeenCalled();
    const failure = operations.at(-1)!;
    expect(failure).toMatchObject({ outcome: 'definite_failure', reasonCode: 'service_start_failed' });
    expect(String(failure.operationKey)).toContain('attempt-producer:3');
    expect(outputs.join('\n')).toContain('已尝试 3 轮自动修复仍未通过');
  });

  it('refuses a repair target that is not a completed Attempt', async () => {
    const { runtime, operations } = runtimeWith({
      receipts: [{
        attemptId: 'attempt-failed',
        taskId: 'task-1',
        subtaskId: 'subtask-1',
        generationId: 'generation-1',
        terminalState: 'executor_failed',
        authorizedBinding: binding,
        bindingFingerprint: fingerprint,
      }],
    });
    const projection = runtime as unknown as {
      requestServiceRepair(input: Record<string, unknown>): Promise<boolean>;
    };
    const dispatched = await projection.requestServiceRepair({
      taskId: 'task-1',
      spec: specification,
      workspaceId: 'workspace-1',
      view,
      workflow: { submit: vi.fn() },
    });
    expect(dispatched).toBe(false);
    // No executor work to hand the feedback to: the real failure is recorded.
    expect(operations.at(-1)).toMatchObject({ outcome: 'definite_failure' });
  });
});

describe('Kernel authorization of a service repair round', () => {
  function dispatchSnapshot(repairAttempts: Record<string, number>): KernelSnapshot {
    return {
      schemaVersion: 5,
      type: 'dispatch',
      task: { id: 'task-1', status: 'running', conversationId: 'conversation-1' },
      runningTaskId: 'task-1',
      graphState: 'ready',
      subtasks: [{
        id: 'subtask-1',
        taskId: 'task-1',
        status: 'awaiting_decision',
        executorBindings: [binding],
      }],
      frontier: [],
      dispatchItems: [],
      maxConcurrentAttempts: 1,
      availableSlots: 1,
      resourceConflictSubtaskIds: [],
      capacityProbeBindingFingerprints: {},
      serviceRepairAttemptsBySubtask: repairAttempts,
      executorStatuses: [],
      correctionSupportedAgentClasses: [],
      nativeContinuationAgentClasses: [],
      attempts: [],
      generationId: 'generation-1',
      graphRevision: 1,
      automaticReplansUsed: 0,
      recoverySafety: 'safe',
      automaticRecoveryAllowed: true,
      resourceGrantsBySubtask: { 'subtask-1': [] },
      completionBlockedReasons: [],
      generationReplanRequest: null,
      generationQuiescent: true,
    } as unknown as KernelSnapshot;
  }

  function repairEvent(ordinal: number): KernelEvent {
    return {
      schemaVersion: 5,
      configurationRevision: 'revision-1',
      id: `service_repair_event_${ordinal}`,
      correlationId: 'task-1',
      causationId: 'attempt-producer',
      occurredAt: new Date().toISOString(),
      sessionId: 'session-1',
      taskId: 'task-1',
      subtaskId: 'subtask-1',
      type: 'dispatch_requested',
      reason: 'service did not become healthy',
      recovery: {
        authorizedBinding: binding,
        bindingFingerprint: fingerprint,
        attemptKind: 'continuation',
        sourceAttemptId: 'attempt-producer',
        recoveryMode: 'native_session',
        defaultResourceGrant: [],
        attemptPayload: {
          protocol: 'metawork:service-repair:v1',
          serviceId: 'backend',
          workspaceId: 'workspace-1',
          specificationRevision: 'service_revision_x',
          repairOrdinal: ordinal,
          failure: { kind: 'service', code: 'service_start_failed', summary: 'exit 1' },
          service: {
            command: 'node',
            args: ['server.mjs'],
            healthUrl: 'http://127.0.0.1:8811/health',
            state: 'failed',
            exitObserved: true,
            healthStatus: null,
            logTail: 'Error',
          },
          knownProgress: [],
          unknownItems: [],
        },
      },
    } as KernelEvent;
  }

  it('authorizes exactly the next repair round', () => {
    const decision = new ControlKernel().decide(repairEvent(0), dispatchSnapshot({}));
    expect(decision.action).toMatchObject({
      type: 'dispatch_batch',
      items: [{ subtaskId: 'subtask-1', attemptKind: 'continuation', sourceAttemptId: 'attempt-producer' }],
    });
  });

  it('refuses an out-of-order or exhausted repair round', () => {
    const kernel = new ControlKernel();
    expect(kernel.decide(repairEvent(1), dispatchSnapshot({ 'subtask-1': 0 })).action)
      .toMatchObject({ type: 'block_work' });
    const exhausted = kernel.decide(repairEvent(3), dispatchSnapshot({ 'subtask-1': 3 }));
    expect(exhausted.action).toMatchObject({ type: 'block_work' });
    expect(exhausted.reason).toContain('service repair budget exhausted');
  });

  it('accepts a completed Subtask only for service repair and still requires its binding', () => {
    const kernel = new ControlKernel();
    const stale = dispatchSnapshot({});
    (stale as unknown as { subtasks: Array<{ status: string }> }).subtasks[0]!.status = 'done';
    expect(kernel.decide(repairEvent(0), stale).action).toMatchObject({ type: 'dispatch_batch' });
    // A self-consistent fingerprint is not enough: the Subtask must still list
    // this binding, otherwise a revoked or expired Executor would run the round.
    const foreign = dispatchSnapshot({});
    (foreign as unknown as { subtasks: Array<{ executorBindings: AuthorizedExecutorBinding[] }> })
      .subtasks[0]!.executorBindings = [];
    expect(kernel.decide(repairEvent(0), foreign).action).toMatchObject({ type: 'block_work' });
  });

  it('reopens a completed Subtask only while applying the authorized dispatch', async () => {
    const { runtime, transitions } = runtimeWith({});
    const enqueue = vi.fn();
    Object.defineProperty(runtime, 'attemptSupervisor', { value: { enqueue } });
    const decision = new ControlKernel().decide(repairEvent(0), dispatchSnapshot({}));
    expect(decision.action.type).toBe('dispatch_batch');
    await (runtime as unknown as {
      applyExecutionDecision(input: Record<string, unknown>): Promise<KernelEvent | null>;
    }).applyExecutionDecision({
      decision,
      executionId: 'execution-service-repair',
      request: { workspacePath: '/tmp/metawork-test-source' },
      progressTracker: {},
      supervisorContext: {},
      attemptFacts: [],
      finishExecution: vi.fn(),
    });
    expect(transitions.map(item => item.to)).toEqual(['awaiting_decision']);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('service verification loop', () => {
  function loopRuntime() {
    const operations: Array<Record<string, unknown>> = [];
    const outputs: string[] = [];
    const taskState = recordingTaskStateAuthority();
    const runtime = new KernelExecutionRuntime({
      callbacks: {
        appendOutput: (...parts: string[]) => { outputs.push(parts.join(' ')); },
        appendExecutionTrace: () => undefined,
        refreshRuntimeState: () => undefined,
      },
      taskStateAuthority: taskState.authority,
      taskOperationResults: { record: (record: Record<string, unknown>) => { operations.push(record); } },
      taskRuntimeService: {
        findTask: () => ({
          id: 'task-1',
          status: 'running',
          goal: 'run the service',
          startServiceAfterPublish: true,
          executionMode: 'in_place',
        }),
      },
      subtaskRepo: {
        findById: () => ({ id: 'subtask-1', taskId: 'task-1', status: 'done', generationId: 'generation-1', executorBindings: [binding] }),
        listActiveByTask: () => [{ id: 'subtask-1', status: 'done' }],
        updateStatus: () => undefined,
      },
      workGraphRevisionRepo: { findActive: () => ({ generationId: 'generation-1', revision: 1, configurationRevision: 'revision-1' }) },
      attemptReceiptRepo: { listByTask: () => [] },
      dispatchItemRepo: { listByTask: () => [] },
      managedLocalServices: {
        isPublished: async () => true,
        resolveServiceWorkspaceId: async () => 'workspace-1',
      },
      maxConcurrentAttempts: 4,
    } as never);
    return { runtime, operations, outputs };
  }

  it('re-verifies after each authorized round and reports the real error at the budget', async () => {
    const { runtime, operations, outputs } = loopRuntime();
    const projection = runtime as unknown as {
      startRequestedPublishedService(taskId: string, workflow?: unknown): Promise<void>;
      verifyRequestedService: (taskId: string, resourceTaskId: string) => Promise<unknown>;
      requestServiceRepair: (input: Record<string, unknown>) => Promise<boolean>;
    };
    let verification = 0;
    projection.verifyRequestedService = async () => {
      verification += 1;
      return {
        spec: specification,
        workspaceId: 'workspace-1',
        view: { ...view, message: `still failing #${verification}` },
      };
    };
    let repairs = 0;
    projection.requestServiceRepair = async () => {
      repairs += 1;
      return repairs <= 3;
    };
    await projection.startRequestedPublishedService('task-1', { submit: async () => ({ decisions: [] }) });

    // Three authorized repair rounds, then a fourth verification decides.
    expect(repairs).toBe(3);
    expect(verification).toBeGreaterThanOrEqual(4);
    expect(outputs.join('\n')).toContain('still failing #1');
  }, 15000);

  it('stops the loop as soon as the service is healthy', async () => {
    const { runtime, outputs } = loopRuntime();
    const projection = runtime as unknown as {
      startRequestedPublishedService(taskId: string, workflow?: unknown): Promise<void>;
      verifyRequestedService: (taskId: string, resourceTaskId: string) => Promise<unknown>;
      requestServiceRepair: (input: Record<string, unknown>) => Promise<boolean>;
      recordServiceStarted: () => void;
    };
    let verification = 0;
    projection.verifyRequestedService = async () => {
      verification += 1;
      return { spec: specification, workspaceId: 'workspace-1', view: { ...view, state: 'healthy', message: '健康检查通过' } };
    };
    const repair = vi.fn();
    projection.requestServiceRepair = repair;
    projection.recordServiceStarted = () => undefined;
    await projection.startRequestedPublishedService('task-1', { submit: async () => ({ decisions: [] }) });
    expect(repair).not.toHaveBeenCalled();
    expect(verification).toBe(1);
    expect(outputs.join('\n')).toContain('healthy');
  }, 15000);
});

describe('service repair source Attempt resolution', () => {
  it('hands the feedback to the newest certified Attempt, not the oldest', async () => {
    const receipts = [
      // listByTask is newest-first.
      {
        attemptId: 'attempt-repair',
        taskId: 'task-1',
        subtaskId: 'subtask-1',
        generationId: 'generation-1',
        terminalState: 'completed',
        authorizedBinding: binding,
        bindingFingerprint: fingerprint,
      },
      {
        attemptId: 'attempt-producer',
        taskId: 'task-1',
        subtaskId: 'subtask-1',
        generationId: 'generation-1',
        terminalState: 'completed',
        authorizedBinding: binding,
        bindingFingerprint: fingerprint,
      },
    ];
    const { runtime } = runtimeWith({ receipts });
    const projection = runtime as unknown as {
      serviceRepairTarget(taskId: string): { attemptId: string } | null;
    };
    expect(projection.serviceRepairTarget('task-1')).toMatchObject({ attemptId: 'attempt-repair' });
  });

  it('ignores receipts from another generation or an uncertified result', async () => {
    const receipts = [
      {
        attemptId: 'attempt-uncertified',
        taskId: 'task-1',
        subtaskId: 'subtask-1',
        generationId: 'generation-1',
        terminalState: 'uncertified_result',
        authorizedBinding: binding,
        bindingFingerprint: fingerprint,
      },
      {
        attemptId: 'attempt-old-generation',
        taskId: 'task-1',
        subtaskId: 'subtask-1',
        generationId: 'generation-old',
        terminalState: 'completed',
        authorizedBinding: binding,
        bindingFingerprint: fingerprint,
      },
    ];
    const { runtime } = runtimeWith({ receipts });
    const projection = runtime as unknown as {
      serviceRepairTarget(taskId: string): { attemptId: string } | null;
    };
    expect(projection.serviceRepairTarget('task-1')).toBeNull();
  });
});

describe('service repair authorization outcomes', () => {
  function projectionOf(runtime: KernelExecutionRuntime) {
    return runtime as unknown as {
      requestServiceRepair(input: Record<string, unknown>): Promise<boolean>;
    };
  }

  it('leaves the completed Subtask unchanged and reports the Kernel reason when the round is refused', async () => {
    const { runtime, operations, outputs, transitions } = runtimeWith({});
    const workflow = {
      submit: vi.fn(async (event: KernelEvent) => ({
        decisions: [{ eventId: event.id, action: { type: 'block_work', taskId: 'task-1', subtaskId: 'subtask-1' }, reason: 'service repair budget exhausted after 3 rounds' }],
      })),
    };
    const dispatched = await projectionOf(runtime).requestServiceRepair({
      taskId: 'task-1',
      spec: specification,
      workspaceId: 'workspace-1',
      view,
      workflow,
    });
    expect(dispatched).toBe(false);
    // Refused repair leaves the completed node untouched.
    expect(transitions).toEqual([]);
    const latest = operations.at(-1)!;
    expect(latest).toMatchObject({ outcome: 'definite_failure' });
    expect(String(latest.message)).toContain('服务进程已退出');
    expect(outputs.join('\n')).toContain('Kernel 未授权自动修复：service repair budget exhausted after 3 rounds');
  });

  it('leaves the completed Subtask unchanged when the submission itself throws', async () => {
    const { runtime, operations, outputs, transitions } = runtimeWith({});
    const workflow = { submit: vi.fn(async () => { throw new Error('workflow store unavailable'); }) };
    const dispatched = await projectionOf(runtime).requestServiceRepair({
      taskId: 'task-1',
      spec: specification,
      workspaceId: 'workspace-1',
      view,
      workflow,
    });
    expect(dispatched).toBe(false);
    expect(transitions).toEqual([]);
    expect(operations.at(-1)).toMatchObject({ outcome: 'definite_failure' });
    expect(outputs.join('\n')).toContain('workflow store unavailable');
  });

  it('does not reopen the Subtask when the submission is refused after dispatch authorization', async () => {
    const { runtime, transitions } = runtimeWith({});
    const workflow = {
      submit: vi.fn(async (event: KernelEvent) => ({
        decisions: [{
          eventId: event.id,
          action: { type: 'dispatch_batch', taskId: 'task-1', items: [{ subtaskId: 'other-subtask' }] },
        }],
      })),
    };
    const dispatched = await projectionOf(runtime).requestServiceRepair({
      taskId: 'task-1',
      spec: specification,
      workspaceId: 'workspace-1',
      view,
      workflow,
    });
    // A batch that does not contain this Subtask did not authorize this round.
    expect(dispatched).toBe(false);
    expect(transitions).toEqual([]);
  });
});

describe('service repair budget accounting', () => {
  function repairItem(status: string, index: number) {
    return {
      attemptId: `repair-${index}`,
      subtaskId: 'subtask-1',
      status,
      attemptPayload: { protocol: 'metawork:service-repair:v1', repairOrdinal: index },
    };
  }

  it('does not charge cancelled dispatches against the budget', async () => {
    const { runtime } = runtimeWith({
      dispatchItems: [repairItem('cancelled', 0), repairItem('cancelled', 1), repairItem('cancelled', 2)],
    });
    const projection = runtime as unknown as {
      serviceRepairAttempts(taskId: string, subtaskId: string): number;
    };
    expect(projection.serviceRepairAttempts('task-1', 'subtask-1')).toBe(0);
  });

  it('charges settled and in-flight rounds', async () => {
    const { runtime } = runtimeWith({
      dispatchItems: [repairItem('terminal', 0), repairItem('running', 1), repairItem('cancelled', 2)],
    });
    const projection = runtime as unknown as {
      serviceRepairAttempts(taskId: string, subtaskId: string): number;
    };
    expect(projection.serviceRepairAttempts('task-1', 'subtask-1')).toBe(2);
  });
});

describe('service repair target identity', () => {
  function targetOf(runtime: KernelExecutionRuntime) {
    return runtime as unknown as {
      serviceRepairTarget(taskId: string): { subtaskId: string; attemptId: string } | null;
    };
  }

  function receipt(attemptId: string, subtaskId: string) {
    return {
      attemptId,
      taskId: 'task-1',
      subtaskId,
      generationId: 'generation-1',
      terminalState: 'completed',
      authorizedBinding: binding,
      bindingFingerprint: fingerprint,
    };
  }

  it('prefers the Subtask that actually wrote the service manifest', () => {
    // Newest first: the unrelated UI Subtask finished last.
    const { runtime } = runtimeWith({
      receipts: [receipt('attempt-ui', 'subtask-ui'), receipt('attempt-api', 'subtask-api')],
    });
    const projection = runtime as unknown as {
      attemptProducedService(subtaskId: string): boolean;
    };
    projection.attemptProducedService = subtaskId => subtaskId === 'subtask-api';
    expect(targetOf(runtime).serviceRepairTarget('task-1')).toMatchObject({
      subtaskId: 'subtask-api',
      attemptId: 'attempt-api',
    });
  });

  it('refuses to guess when several Subtasks completed and none wrote the manifest', () => {
    const { runtime } = runtimeWith({
      receipts: [receipt('attempt-ui', 'subtask-ui'), receipt('attempt-api', 'subtask-api')],
    });
    const projection = runtime as unknown as {
      attemptProducedService(): boolean;
    };
    projection.attemptProducedService = () => false;
    // Feedback must not reach an unrelated Executor.
    expect(targetOf(runtime).serviceRepairTarget('task-1')).toBeNull();
  });

  it('accepts the only completed Subtask without manifest evidence', () => {
    const { runtime } = runtimeWith({ receipts: [receipt('attempt-only', 'subtask-only')] });
    const projection = runtime as unknown as {
      attemptProducedService(): boolean;
    };
    projection.attemptProducedService = () => false;
    expect(projection && targetOf(runtime).serviceRepairTarget('task-1')).toMatchObject({
      subtaskId: 'subtask-only',
    });
  });
});

describe('automatic remaining-work recovery', () => {
  function recoveryRuntime(input: {
    taskStatus?: string;
    retryOfTaskId?: string | null;
    successor?: boolean;
  }) {
    const outputs: string[] = [];
    const taskState = recordingTaskStateAuthority();
    const runtime = new KernelExecutionRuntime({
      callbacks: {
        appendOutput: (...parts: string[]) => { outputs.push(parts.join(' ')); },
        refreshRuntimeState: () => undefined,
        appendExecutionTrace: () => undefined,
      },
      taskStateAuthority: taskState.authority,
      taskOperationResults: { record: () => undefined, listByTask: () => [] },
      taskRuntimeService: {
        findTask: () => ({
          id: 'task-1',
          status: input.taskStatus ?? 'failed',
          stateVersion: 3,
          retryOfTaskId: input.retryOfTaskId ?? null,
        }),
        listTasks: () => input.successor
          ? [{ id: 'task-retry-1', retryOfTaskId: 'task-1', status: 'failed' }]
          : [],
      },
      maxConcurrentAttempts: 2,
    } as never);
    return { runtime, outputs };
  }

  it('retries the remaining delivery/service work automatically', async () => {
    const { runtime, outputs } = recoveryRuntime({});
    const projection = runtime as unknown as {
      retryRemainingWork(taskId: string): Promise<{ taskId: string }>;
      attemptAutomaticRemainingWork(taskId: string): Promise<boolean>;
    };
    projection.retryRemainingWork = async () => ({ taskId: 'task-retry-1' });
    await expect(projection.attemptAutomaticRemainingWork('task-1')).resolves.toBe(true);
    expect(outputs.join('\n')).toContain('系统已自动创建续做任务 #task-retry-1');
  });

  it('never chains a second automatic round', async () => {
    const { runtime } = recoveryRuntime({ retryOfTaskId: 'task-original' });
    const projection = runtime as unknown as {
      retryRemainingWork(taskId: string): Promise<{ taskId: string }>;
      attemptAutomaticRemainingWork(taskId: string): Promise<boolean>;
    };
    const retry = vi.fn();
    projection.retryRemainingWork = retry;
    await expect(projection.attemptAutomaticRemainingWork('task-1')).resolves.toBe(false);
    expect(retry).not.toHaveBeenCalled();
  });

  it('reuses an existing successor instead of duplicating it', async () => {
    const { runtime } = recoveryRuntime({ successor: true });
    const projection = runtime as unknown as {
      retryRemainingWork(taskId: string): Promise<{ taskId: string }>;
      attemptAutomaticRemainingWork(taskId: string): Promise<boolean>;
    };
    const retry = vi.fn();
    projection.retryRemainingWork = retry;
    await expect(projection.attemptAutomaticRemainingWork('task-1')).resolves.toBe(false);
    expect(retry).not.toHaveBeenCalled();
  });

  it('keeps the real failure when the Kernel refuses the remaining work', async () => {
    const { runtime, outputs } = recoveryRuntime({});
    const projection = runtime as unknown as {
      retryRemainingWork(taskId: string): Promise<{ taskId: string }>;
      attemptAutomaticRemainingWork(taskId: string): Promise<boolean>;
    };
    projection.retryRemainingWork = async () => { throw new Error('unsafe reuse'); };
    await expect(projection.attemptAutomaticRemainingWork('task-1')).resolves.toBe(false);
    expect(outputs).toEqual([]);
  });

  it('does nothing while the Task is not failed yet', async () => {
    const { runtime } = recoveryRuntime({ taskStatus: 'running' });
    const projection = runtime as unknown as {
      retryRemainingWork(taskId: string): Promise<{ taskId: string }>;
      attemptAutomaticRemainingWork(taskId: string): Promise<boolean>;
    };
    const retry = vi.fn();
    projection.retryRemainingWork = retry;
    await expect(projection.attemptAutomaticRemainingWork('task-1')).resolves.toBe(false);
    expect(retry).not.toHaveBeenCalled();
  });
});

describe('remaining work reads the latest service outcome', () => {
  it('does not request a service start after the latest round succeeded', async () => {
    const taskState = recordingTaskStateAuthority();
    const results: Array<Record<string, unknown>> = [
      { operationKey: 'service:start:backend:old:attempt-0:0', operationKind: 'service', outcome: 'definite_failure' },
      { operationKey: 'service:start:backend:new:attempt-1:1', operationKind: 'service', outcome: 'success' },
    ];
    const runtime = new KernelExecutionRuntime({
      callbacks: { appendOutput: () => undefined, refreshRuntimeState: () => undefined },
      taskStateAuthority: taskState.authority,
      taskOperationResults: {
        record: () => undefined,
        listByTask: () => results,
      },
      maxConcurrentAttempts: 2,
    } as never);
    const projection = runtime as unknown as {
      latestServiceOutcome(taskId: string): string | null;
    };
    expect(projection.latestServiceOutcome('task-1')).toBe('success');
    results.push({
      operationKey: 'service:start:backend:new:attempt-2:2',
      operationKind: 'service',
      outcome: 'repair_pending',
    });
    expect(projection.latestServiceOutcome('task-1')).toBe('repair_pending');
  });
});
