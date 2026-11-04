import { describe, expect, it } from 'vitest';
import type { ConversationTaskSummary } from '../../src/session/conversation-activity-types';
import { selectStopTargets } from '../../web/src/observation/task-activity.js';

function task(overrides: Partial<ConversationTaskSummary> & { taskId: string }): ConversationTaskSummary {
  return {
    status: 'running',
    statusLabel: '执行中',
    canCancel: true,
    pendingActions: [],
    executionGeneration: 'generation-1',
    title: overrides.taskId,
    ...overrides,
  } as ConversationTaskSummary;
}

describe('selectStopTargets', () => {
  it('cancels the Task the stopped Turn produced even when it is no longer running', () => {
    const blocked = task({ taskId: 'task-blocked', status: 'needs_action' });
    const running = task({ taskId: 'task-running' });

    // A blocked Task is still live work: Stop must fence it, otherwise the
    // Task keeps its Conversation slot while the Planner trace is cancelled.
    expect(selectStopTargets([blocked, running], 'task-blocked').map(item => item.taskId))
      .toEqual(['task-blocked']);
  });

  it('prefers the attached Task over other running Tasks', () => {
    const attached = task({ taskId: 'task-attached' });
    const other = task({ taskId: 'task-other' });

    expect(selectStopTargets([other, attached], 'task-attached').map(item => item.taskId))
      .toEqual(['task-attached']);
  });

  it('falls back to the running Tasks when the Turn has no cancellable Task', () => {
    const running = task({ taskId: 'task-running' });
    const terminal = task({ taskId: 'task-done', status: 'succeeded', canCancel: false });

    expect(selectStopTargets([running, terminal], null).map(item => item.taskId))
      .toEqual(['task-running']);
  });

  it('never cancels a terminal Task', () => {
    const done = task({ taskId: 'task-done', status: 'succeeded', canCancel: false });

    expect(selectStopTargets([done], 'task-done')).toEqual([]);
  });
});
