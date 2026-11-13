import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/core/types.js';
import { evaluateTaskState, NO_TASK_CLEANUP } from '../../src/task/task-state.js';
import {
  readTaskEvaluationInput,
  type TaskStateRawFacts,
} from '../../src/task/task-state-facts.js';

function rawFacts(failureKind: string): TaskStateRawFacts {
  return {
    task: {
      id: 'task-recoverable',
      status: 'running',
      dependencies: [],
      createdAt: '2026-11-11T00:00:00.000Z',
      updatedAt: '2026-11-11T00:00:00.000Z',
    } as unknown as Task,
    activeGraph: { generationId: 'generation-1', revision: 1 },
    subtasks: [{
      id: 'subtask-search', title: 'Search', status: 'blocked', dependencySubtaskIds: [],
    }],
    dispatches: [],
    receipts: [{
      attemptId: 'attempt-1',
      subtaskId: 'subtask-search',
      terminalState: 'executor_failed',
      failureCode: failureKind === 'configuration' ? 'executor_configuration_failed' : 'executor_failed',
      failureKind,
      completedAt: '2026-11-11T00:01:00.000Z',
    }],
    publications: [],
    retryWakes: [],
    replans: [],
    pendingResult: null,
    pendingPermission: null,
    service: null,
    serviceRequired: false,
    slot: 'held',
    cleanup: NO_TASK_CLEANUP,
    completionRequirements: [{
      key: 'execution:subtask-search',
      kind: 'execution',
      label: 'Search',
      subtaskId: 'subtask-search',
      serviceId: null,
    }],
    capacityWaiting: false,
    externalOutcomeUnknown: false,
    operationResults: [],
    cancelFence: false,
    partialAcceptancePending: false,
  };
}

describe('recoverable blocked failures', () => {
  it.each(['configuration', 'adapter', 'permission', 'stale'])(
    'keeps a blocked Subtask resumable after a %s failure instead of failing the Task',
    failureKind => {
      const input = readTaskEvaluationInput(rawFacts(failureKind));

      expect(input.requiredWork[0]?.state).toBe('waiting_for_user');
      expect(input.failureReason).toBeNull();
      const evaluation = evaluateTaskState({
        taskId: 'task-recoverable',
        currentStatus: 'running',
        cancelFence: false,
        ...input,
      });
      expect(evaluation.status).toBe('needs_action');
    },
  );

  it('still concludes a blocked Subtask with a definite executor failure as failed', () => {
    const input = readTaskEvaluationInput({ ...rawFacts('execution'), receipts: [{
      attemptId: 'attempt-1',
      subtaskId: 'subtask-search',
      terminalState: 'executor_failed',
      failureCode: 'exit_code_1',
      failureKind: 'execution',
      completedAt: '2026-11-11T00:01:00.000Z',
    }] });

    const evaluation = evaluateTaskState({
      taskId: 'task-recoverable',
      currentStatus: 'running',
      cancelFence: false,
      ...input,
    });
    expect(evaluation.status).toBe('failed');
  });
});
