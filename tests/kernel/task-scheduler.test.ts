import { describe, expect, it } from 'vitest';
import {
  selectTaskDispatches,
  type TaskSchedulerSnapshot,
} from '../../src/kernel/task-scheduler.js';

function snapshot(overrides: Partial<TaskSchedulerSnapshot> = {}): TaskSchedulerSnapshot {
  return {
    account: {
      maxConcurrentTasks: 2,
      maxConcurrentAttempts: 4,
      maxConcurrentAttemptsPerTask: 2,
      activeTaskCount: 0,
      activeAttemptCount: 0,
    },
    conversations: [
      { conversationId: 'conversation-a', slotState: 'free', fairnessSequence: 0 },
      { conversationId: 'conversation-b', slotState: 'free', fairnessSequence: 0 },
    ],
    candidates: [],
    ...overrides,
  };
}

function candidate(
  taskId: string,
  conversationId: string,
  overrides: Partial<TaskSchedulerSnapshot['candidates'][number]> = {},
): TaskSchedulerSnapshot['candidates'][number] {
  return {
    taskId,
    conversationId,
    eligibleSince: '2026-08-29T00:00:00.000Z',
    priority: 'normal',
    aged: false,
    runnableAttemptCount: 1,
    activeAttemptCount: 0,
    resourceConflict: false,
    ...overrides,
  };
}

describe('task scheduler policy', () => {
  it('selects runnable Tasks from different Conversations in one round', () => {
    const result = selectTaskDispatches(snapshot({
      candidates: [candidate('task-a', 'conversation-a'), candidate('task-b', 'conversation-b')],
    }));

    expect(result.dispatches.map(item => item.taskId)).toEqual(['task-a', 'task-b']);
  });

  it('selects at most one Task from a Conversation even when two are eligible', () => {
    const result = selectTaskDispatches(snapshot({
      candidates: [
        candidate('task-old', 'conversation-a', { eligibleSince: '2026-08-28T00:00:00.000Z' }),
        candidate('task-new', 'conversation-a'),
        candidate('task-b', 'conversation-b'),
      ],
    }));

    expect(result.dispatches.map(item => item.taskId)).toEqual(['task-old', 'task-b']);
  });

  it('honors global and per-Task attempt capacity without preempting active work', () => {
    const result = selectTaskDispatches(snapshot({
      account: {
        maxConcurrentTasks: 2,
        maxConcurrentAttempts: 2,
        maxConcurrentAttemptsPerTask: 2,
        activeTaskCount: 1,
        activeAttemptCount: 1,
      },
      candidates: [
        candidate('task-a', 'conversation-a', { runnableAttemptCount: 3, activeAttemptCount: 2 }),
        candidate('task-b', 'conversation-b', { runnableAttemptCount: 2 }),
      ],
    }));

    expect(result.dispatches).toEqual([
      { taskId: 'task-b', attemptCount: 1 },
    ]);
    expect(result.preemptions).toEqual([]);
  });

  it('uses priority, aging and durable fairness sequence for stable ordering', () => {
    const result = selectTaskDispatches(snapshot({
      conversations: [
        { conversationId: 'conversation-a', slotState: 'free', fairnessSequence: 4 },
        { conversationId: 'conversation-b', slotState: 'free', fairnessSequence: 1 },
        { conversationId: 'conversation-c', slotState: 'free', fairnessSequence: 2 },
      ],
      candidates: [
        candidate('task-normal', 'conversation-a'),
        candidate('task-urgent', 'conversation-b', { priority: 'urgent' }),
        candidate('task-aged', 'conversation-c', { aged: true }),
      ],
    }));

    expect(result.dispatches.map(item => item.taskId)).toEqual([
      'task-urgent', 'task-aged',
    ]);
  });

  it('skips resource-conflicted candidates without blocking unrelated work', () => {
    const result = selectTaskDispatches(snapshot({
      candidates: [
        candidate('task-conflict', 'conversation-a', { resourceConflict: true }),
        candidate('task-free', 'conversation-b'),
      ],
    }));

    expect(result.dispatches).toEqual([{ taskId: 'task-free', attemptCount: 1 }]);
    expect(result.waiting).toEqual([
      { taskId: 'task-conflict', reason: 'resource_conflict' },
    ]);
  });
});
