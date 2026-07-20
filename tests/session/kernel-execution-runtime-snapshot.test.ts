import { describe, expect, it, vi } from 'vitest';
import { KernelExecutionRuntime } from '../../src/session/session-execution-coordinator.js';

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
    const decisions = [
      { schemaVersion: 1, id: 'decision_1', eventId: 'dispatch_event', reason: 'dispatch', action: {
        type: 'dispatch_attempt', taskId: task.id, subtaskId: subtask.id, agentClassName: 'codex-cli',
        attemptId: 'attempt_1', attemptKind: 'primary',
      } },
      { schemaVersion: 1, id: 'decision_2', eventId: 'capacity_event', reason: 'stop', action: { type: 'no_op' } },
    ];
    const runtime = new KernelExecutionRuntime({
      sessionId: 'session_1',
      taskRuntimeService: {
        findTask: vi.fn().mockReturnValue(task), getCurrentRunningTask: vi.fn().mockReturnValue(task),
        attachResource: vi.fn(), transitionTask: vi.fn(),
      },
      workGraphRuntimeService: { apply: vi.fn().mockReturnValue({ outcome: 'recovered' }) },
      subtaskRepo: { listByTask: vi.fn().mockReturnValue([subtask]), findById: vi.fn().mockReturnValue(subtask) },
      subtaskHandoffRepo: { listByTask: vi.fn().mockReturnValue([]) },
      workUnitClaimService: { sweepExpired: vi.fn().mockReturnValue([]) },
      attemptRunner: {
        supportsResponseOnly,
        run: vi.fn().mockResolvedValue({ outcome: 'capacity_unavailable', agentClassName: 'codex-cli' }),
      },
      controlKernel: { decide: vi.fn().mockImplementation(() => decisions.shift()) },
      kernelDecisionRepo: { issue: vi.fn().mockReturnValue(true) },
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
    expect(recordExecutionOutcome).not.toHaveBeenCalled();
  });
});
