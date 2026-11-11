import { describe, expect, it } from 'vitest';
import {
  decideTaskControl,
  type TaskControlSnapshot,
  type TaskControlSubtaskFact,
} from '../../src/execution/task-control-policy.js';
import type { AuthorizedExecutorBinding } from '../../src/core/authorized-executor-binding.js';

const binding = {
  agentClassRef: 'agent',
  harnessRef: 'harness',
  providerRef: 'provider',
  modelRef: 'model',
  permissionProfileRef: 'profile',
  configurationRevision: 'revision',
} satisfies AuthorizedExecutorBinding;

function subtask(
  id: string,
  status: TaskControlSubtaskFact['status'],
  dependencySubtaskIds: string[] = [],
): TaskControlSubtaskFact {
  return { id, taskId: 'task_1', status, executorBindings: [binding], dependencySubtaskIds };
}

function snapshot(overrides: Partial<TaskControlSnapshot> = {}): TaskControlSnapshot {
  return {
    task: { id: 'task_1', status: 'running' },
    generationId: 'generation_task_1_1',
    graphRevision: 1,
    subtasks: [subtask('root', 'done')],
    completionBlockedReasons: [],
    partialCancellation: false,
    ...overrides,
  };
}

describe('Task control policy', () => {
  it('authorizes one atomic downstream cancellation closure and rejects a closure containing done work', () => {
    const control = snapshot({
      subtasks: [
        subtask('root', 'done'),
        subtask('left', 'running', ['root']),
        subtask('right', 'ready', ['root']),
        subtask('join', 'awaiting_decision', ['left', 'right']),
      ],
    });

    expect(decideTaskControl(control, {
      kind: 'cancel_subtasks', taskId: 'task_1', targetSubtaskIds: ['left'], reason: 'user command',
    })).toEqual({
      authorized: true,
      reason: 'atomic downstream Subtask cancellation closure authorized',
      action: {
        type: 'cancel_subtasks',
        taskId: 'task_1',
        generationId: 'generation_task_1_1',
        graphRevision: 1,
        subtaskIds: ['join', 'left'],
        expectedStatuses: [
          { subtaskId: 'join', status: 'awaiting_decision' },
          { subtaskId: 'left', status: 'running' },
        ],
      },
    });

    const rejected = decideTaskControl(control, {
      kind: 'cancel_subtasks', taskId: 'task_1', targetSubtaskIds: ['root'], reason: 'user command',
    });
    expect(rejected.authorized).toBe(false);
    expect(rejected.authorized ? '' : rejected.reason).toContain('already_done');
  });

  it('authorizes Task cancellation only while the Task is not terminal', () => {
    expect(decideTaskControl(snapshot(), {
      kind: 'cancel_task', taskId: 'task_1', reason: 'user command',
    })).toMatchObject({
      authorized: true,
      action: { type: 'cancel_task', taskId: 'task_1', generationId: 'generation_task_1_1' },
    });
    const terminal = decideTaskControl(snapshot({ task: { id: 'task_1', status: 'succeeded' } }), {
      kind: 'cancel_task', taskId: 'task_1', reason: 'user command',
    });
    expect(terminal).toEqual({ authorized: false, reason: 'Task is already succeeded' });
    expect(decideTaskControl(snapshot({ task: null }), {
      kind: 'cancel_task', taskId: 'task_1', reason: 'user command',
    })).toEqual({ authorized: false, reason: 'Task control target is missing or stale' });
  });

  it('accepts partial results only after cancellation has quiesced with at least one completed node', () => {
    const partial = snapshot({
      task: { id: 'task_1', status: 'needs_action' },
      subtasks: [subtask('published', 'done'), subtask('cancelled', 'cancelled')],
      partialCancellation: true,
    });
    expect(decideTaskControl(partial, { kind: 'accept_result', taskId: 'task_1' })).toMatchObject({
      authorized: true,
      action: {
        type: 'accept_partial_result',
        taskId: 'task_1',
        generationId: 'generation_task_1_1',
        graphRevision: 1,
        completedSubtaskIds: ['published'],
        cancelledSubtaskIds: ['cancelled'],
      },
    });
    expect(decideTaskControl({
      ...partial,
      subtasks: [subtask('pending', 'running')],
    }, { kind: 'accept_result', taskId: 'task_1' }).authorized).toBe(false);
  });

  it('fences result acceptance and retry against stale identities, and refuses uncertain external repetition', () => {
    const expected = {
      taskId: 'task_1',
      generationId: 'generation_task_1_1',
      graphRevision: 1,
      subtaskId: 'subtask_1',
      attemptId: 'attempt_safe',
      resultId: 'result_safe',
    };
    const control = snapshot({
      subtasks: [subtask('subtask_1', 'awaiting_decision')],
      uncertifiedResult: {
        subtaskId: expected.subtaskId,
        attemptId: expected.attemptId,
        resultId: expected.resultId,
      },
      resultRetrySafe: true,
    });

    for (const kind of ['accept_result', 'retry_result'] as const) {
      expect(decideTaskControl(control, { kind, taskId: 'task_1', expectedResult: expected }))
        .toMatchObject({
          authorized: true,
          action: {
            type: kind === 'accept_result' ? 'accept_uncertified_result' : 'retry_uncertified_result',
            ...expected,
          },
        });
      for (const key of Object.keys(expected)) {
        const stale = { ...expected, [key]: key === 'graphRevision' ? 2 : 'other' };
        expect(decideTaskControl(control, { kind, taskId: 'task_1', expectedResult: stale }))
          .toMatchObject({ authorized: false });
      }
      expect(decideTaskControl(
        { ...control, task: { id: 'task_1', status: 'cancelled' } },
        { kind, taskId: 'task_1', expectedResult: expected },
      )).toMatchObject({ authorized: false });
    }
    expect(decideTaskControl(
      { ...control, resultRetrySafe: false },
      { kind: 'retry_result', taskId: 'task_1', expectedResult: expected },
    )).toEqual({ authorized: false, reason: '无法安全重新执行：请先确认不确定的外部副作用。' });
  });

  it('replays a previously authorized result acceptance', () => {
    const expected = {
      taskId: 'task_1',
      generationId: 'generation_task_1_1',
      graphRevision: 1,
      subtaskId: 'subtask_1',
      attemptId: 'attempt_safe',
      resultId: 'result_safe',
    };
    const control = snapshot({
      task: { id: 'task_1', status: 'needs_action' },
      subtasks: [subtask('subtask_1', 'awaiting_decision')],
      uncertifiedResult: null,
      acceptedResult: expected,
    });
    expect(decideTaskControl(control, {
      kind: 'accept_result', taskId: 'task_1', expectedResult: expected,
    })).toMatchObject({
      authorized: true,
      reason: 'previously authorized result acceptance replay',
      action: { type: 'accept_uncertified_result', ...expected },
    });
  });

  it('authorizes isolated candidate delivery only for explicit acceptance without a pending result', () => {
    const control = snapshot({
      task: { id: 'task_1', status: 'needs_action' },
      subtasks: [subtask('subtask_1', 'done')],
      candidateDeliveries: [{ publicationId: 'publication_1', subtaskId: 'subtask_1' }],
    });
    expect(decideTaskControl(control, { kind: 'accept_result', taskId: 'task_1' })).toMatchObject({
      authorized: true,
      action: {
        type: 'authorize_workspace_delivery',
        publicationIds: ['publication_1'],
      },
    });
  });

  it('rejects control when no active graph generation exists', () => {
    expect(decideTaskControl(snapshot({ generationId: null, graphRevision: null }), {
      kind: 'accept_result', taskId: 'task_1',
    })).toEqual({ authorized: false, reason: 'active Work Graph generation is missing' });
  });
});
