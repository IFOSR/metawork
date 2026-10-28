import { describe, expect, it } from 'vitest';
import { TASK_STATUS_LABELS, TASK_STATUSES as SERVER_TASK_STATUSES } from '../../src/task/task-state.js';
import {
  TASK_STATUSES,
  TASK_STATUS_LABEL,
  isTaskStatus,
  taskStatusLabel,
} from '../../web/src/task-status';

describe('the single user-facing task status vocabulary', () => {
  it('mirrors the server six-state contract exactly', () => {
    expect([...TASK_STATUSES]).toEqual([...SERVER_TASK_STATUSES]);
    expect(TASK_STATUS_LABEL).toEqual(TASK_STATUS_LABELS);
  });

  it('labels only the six durable Task conclusions', () => {
    for (const status of TASK_STATUSES) {
      expect(taskStatusLabel(status)).toBe(TASK_STATUS_LABEL[status]);
    }
    // Internal lifecycle values are not task statuses and get no label.
    for (const internal of [
      'done', 'succeeded_pending', 'ready', 'pending_launch', 'launching', 'cancelling',
      'terminal', 'uncertain', 'awaiting_integration', 'awaiting_decision', 'blocked',
      'completed', 'executing', 'idle',
    ]) {
      expect(isTaskStatus(internal)).toBe(false);
      expect(taskStatusLabel(internal)).toBeNull();
    }
  });
});
