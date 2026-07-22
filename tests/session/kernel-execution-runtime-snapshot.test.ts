import { describe, expect, it, vi } from 'vitest';
import { KernelExecutionRuntime } from '../../src/session/session-execution-coordinator.js';
import type { KernelDecisionApplicationRecord, KernelWorkflowStore } from '../../src/kernel/kernel-workflow.js';
import { ControlKernel, type KernelEvent, type KernelSnapshot } from '../../src/kernel/control-kernel.js';

describe('KernelExecutionRuntime dispatch snapshots', () => {
  it('resolves loop-stable executor facts only once per execution', async () => {
    const task = { id: 'task_1', title: 'Task', goal: 'Goal', status: 'running' };
    const subtask = {
      id: 'subtask_1', taskId: task.id, title: 'Subtask', goal: 'Goal', status: 'ready',
      dependencies: [], preferredAgentClassList: ['codex-cli'],
    };
    const listStatuses = vi.fn().mockReturnValue([]);
    const recordExecutionOutcome = vi.fn();
    const listAgentClasses = vi.fn().mockReturnValue([{ name: 'codex-cli' }]);
    const supportsResponseOnly = vi.fn().mockReturnValue(true);
    const supportsContinuation = vi.fn().mockReturnValue(true);
    const decisions = [
      { schemaVersion: 1, id: 'decision_1', eventId: 'dispatch_event', reason: 'dispatch', action: {
        type: 'dispatch_attempt', taskId: task.id, subtaskId: subtask.id, agentClassName: 'codex-cli',
        attemptId: 'attempt_1', attemptKind: 'primary',
      } },
      { schemaVersion: 1, id: 'decision_2', eventId: 'capacity_event', reason: 'stop', action: { type: 'no_op' } },
    ];
    const kernelWorkflowStore = inMemoryWorkflowStore();
    const runtime = new KernelExecutionRuntime({
      sessionId: 'session_1',
      taskRuntimeService: {
        findTask: vi.fn().mockReturnValue(task), getCurrentRunningTask: vi.fn().mockReturnValue(task),
        attachResource: vi.fn(), transitionTask: vi.fn(),
      },
      workGraphRuntimeService: { apply: vi.fn().mockReturnValue({ outcome: 'recovered' }) },
      subtaskRepo: { listByTask: vi.fn().mockReturnValue([subtask]), findById: vi.fn().mockReturnValue(subtask) },
      subtaskHandoffRepo: { listByTask: vi.fn().mockReturnValue([]) },
      attemptReceiptRepo: { listByTask: vi.fn().mockReturnValue([]) },
      workGraphRevisionRepo: { findActive: vi.fn().mockReturnValue(null) },
      workUnitClaimService: { sweepExpired: vi.fn().mockReturnValue([]) },
      attemptRunner: {
        supportsResponseOnly, supportsContinuation,
        run: vi.fn().mockResolvedValue({ outcome: 'capacity_unavailable', agentClassName: 'codex-cli' }),
      },
      controlKernel: { decide: vi.fn().mockImplementation(() => decisions.shift()) },
      kernelWorkflowStore,
      executionProgressService: { createTracker: vi.fn().mockReturnValue({ onProgress: vi.fn() }) },
      kernelExecutorStatusProjector: { list: listStatuses, recordExecutionOutcome },
      agentClassService: { listAgentClasses },
      taskEventRepo: {},
      callbacks: {
        appendOutput: vi.fn(), refreshRuntimeState: vi.fn(), appendTaskQueueSnapshot: vi.fn(),
        setFocusContext: vi.fn(), setRunningExecutorName: vi.fn(), clearRunningExecutorName: vi.fn(),
        persistSessionState: vi.fn(), setLatestGuidance: vi.fn(), queueProposal: vi.fn(),
      },
      presentation: { formatExecutorDispatch: vi.fn().mockReturnValue([]) },
    } as never);

    await runtime.execute({
      taskId: task.id,
      request: { userPrompt: task.goal, contextTaskId: task.id, executionMode: 'new', origin: 'user' },
      approvedRecallSelection: null,
    });

    expect(listStatuses).toHaveBeenCalledTimes(1);
    expect(listAgentClasses).toHaveBeenCalledTimes(1);
    expect(supportsResponseOnly).toHaveBeenCalledTimes(1);
    expect(supportsContinuation).toHaveBeenCalledTimes(1);
    expect(recordExecutionOutcome).not.toHaveBeenCalled();
  });

  it('derives recovery safety from the failed Subtask instead of the ready frontier', () => {
    const task = { id: 'task_1', title: 'Task', goal: 'Goal', status: 'running' };
    const subtask = {
      id: 'subtask_external', taskId: task.id, title: 'External write', goal: 'Publish once',
      status: 'awaiting_decision',
      dependencies: [], preferredAgentClassList: ['codex-cli'], requiredCapabilities: ['unknown-capability'],
    };
    const runtime = new KernelExecutionRuntime({
      taskRuntimeService: {
        findTask: vi.fn().mockReturnValue(task), getCurrentRunningTask: vi.fn().mockReturnValue(task),
      },
      subtaskRepo: { listByTask: vi.fn().mockReturnValue([subtask]) },
      subtaskHandoffRepo: { listByTask: vi.fn().mockReturnValue([]) },
      attemptReceiptRepo: { listByTask: vi.fn().mockReturnValue([]) },
      workGraphRevisionRepo: { findActive: vi.fn().mockReturnValue(null) },
      taskEventRepo: {},
    } as never);
    const snapshot = (runtime as unknown as {
      buildDispatchSnapshot(
        taskId: string,
        attemptedAgentClasses: Set<string>,
        graphState: 'ready',
        stableFacts: {
          executorStatuses: []; correctionSupportedAgentClasses: []; nativeContinuationAgentClasses: [];
        },
        attempts: [],
        recoverySubtaskId: string,
      ): KernelSnapshot;
    }).buildDispatchSnapshot(
      task.id,
      new Set(),
      'ready',
      { executorStatuses: [], correctionSupportedAgentClasses: [], nativeContinuationAgentClasses: [] },
      [],
      subtask.id,
    );

    expect(snapshot).toMatchObject({
      type: 'dispatch',
      recoverySafety: 'external_non_idempotent',
      automaticRecoveryAllowed: false,
    });
    const decision = new ControlKernel().decide({
      schemaVersion: 2,
      type: 'execution_outcome',
      id: 'event_external_failure',
      correlationId: 'task_1',
      causationId: 'attempt_1',
      occurredAt: '2026-07-22T00:00:00.000Z',
      sessionId: 'session_1',
      taskId: task.id,
      subtaskId: subtask.id,
      attemptId: 'attempt_1',
      terminalKind: 'failed',
      agentClassName: 'codex-cli',
      attemptKind: 'primary',
      sourceAttemptId: null,
      failure: {
        kind: 'network', scope: 'agent_class', code: 'network_failure', summary: 'network unavailable',
      },
    }, snapshot);
    expect(decision.action).toEqual({
      type: 'block_work', taskId: task.id, subtaskId: subtask.id,
    });
  });
});

function inMemoryWorkflowStore(): KernelWorkflowStore {
  let event: KernelEvent | null = null;
  let application: KernelDecisionApplicationRecord | null = null;
  return {
    enqueue(next) { event ??= next; return true; },
    claimNext() { const next = event; event = null; return next; },
    issue(_eventId, record) {
      application = {
        id: `application_${record.id}`, decisionId: record.id, eventId: record.eventId,
        idempotencyKey: `decision:${record.id}`, status: 'pending', applyAttempts: 0,
        observationEvent: null, errorSummary: null, createdAt: record.createdAt,
        updatedAt: record.createdAt, decision: record.decision,
      };
      return application;
    },
    listRecoverableApplications() {
      return application && (application.status === 'pending' || application.status === 'applying')
        ? [application]
        : [];
    },
    markApplying() {
      if (!application) throw new Error('missing application');
      application = { ...application, status: 'applying', applyAttempts: application.applyAttempts + 1 };
      return application;
    },
    markApplied(_decisionId, observation) {
      if (!application) throw new Error('missing application');
      application = { ...application, status: 'applied', observationEvent: observation };
      if (observation) event = observation;
    },
    markApplicationFailed() {},
    reconcileProcessing() { return 0; },
    countByApplicationStatus() {
      const counts = { pending: 0, applying: 0, applied: 0, uncertain: 0, failed: 0 };
      if (application) counts[application.status] += 1;
      return counts;
    },
  };
}
