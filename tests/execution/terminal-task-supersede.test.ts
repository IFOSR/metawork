import { describe, expect, it, vi } from 'vitest';
import { recordingTaskStateAuthority } from '../support/task-state-fixture.js';
import { KernelExecutionRuntime } from '../../src/execution/kernel-execution-runtime.js';

/**
 * 2026-10-27 realignment §5.3: a Task in a terminal state is historical. The
 * current explicit request supersedes it, so a new turn must never be held by a
 * failed Task's admission fact or by an internal retry command.
 */
describe('terminal Task supersede', () => {
  function runtimeWith(status: string) {
    const releaseAdmission = vi.fn().mockReturnValue({ released: true });
    const refreshRuntimeState = vi.fn();
    const runtime = new KernelExecutionRuntime({
      callbacks: { refreshRuntimeState, appendOutput: () => undefined },
      taskStateAuthority: recordingTaskStateAuthority().authority,
      taskRuntimeService: {
        findTask: () => ({ id: 'task-failed', status }),
      },
      conversationTaskSchedulerRepo: {
        getSlot: () => ({ state: 'occupied', activeTaskId: 'task-failed' }),
      },
      cancellationCoordinator: {
        releaseAdmission,
        recover: () => undefined,
        settlePartialCancellation: () => undefined,
        completionBlockedReasons: () => [],
      },
      dispatchItemRepo: {},
      kernelWorkflowStore: { listUncertainApplications: () => [] },
      maxConcurrentAttempts: 2,
    } as never);
    return { runtime, releaseAdmission, refreshRuntimeState };
  }

  it('releases the Conversation slot a failed Task still holds', () => {
    const { runtime, releaseAdmission } = runtimeWith('failed');
    const result = runtime.reconcileConversationAdmission('conversation-1');
    expect(result.releasedStaleSlot).toBe(true);
    expect(releaseAdmission).toHaveBeenCalledWith('task-failed', expect.any(String));
  });

  it('keeps the slot for a Task that is still running', () => {
    const { runtime, releaseAdmission } = runtimeWith('running');
    const result = runtime.reconcileConversationAdmission('conversation-1');
    expect(result.releasedStaleSlot).toBe(false);
    expect(releaseAdmission).not.toHaveBeenCalled();
  });

  it('leaves the historical Task itself untouched', () => {
    const updateStatus = vi.fn();
    const { runtime } = runtimeWith('failed');
    (runtime as unknown as { deps: Record<string, unknown> }).deps.taskRuntimeService = {
      findTask: () => ({ id: 'task-failed', status: 'failed' }),
      updateTask: updateStatus,
    };
    runtime.reconcileConversationAdmission('conversation-1');
    // Superseding a failure is admission work: the old Task keeps its conclusion.
    expect(updateStatus).not.toHaveBeenCalled();
  });
});
