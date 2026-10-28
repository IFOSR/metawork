/**
 * The only user-facing task status vocabulary.
 *
 * A Task has exactly one conclusion, so every surface that names a Task's
 * status reads these six labels from the same durable fact (the TaskView /
 * ExecutionTimeline `status`). Dispatch, Attempt, receipt, Subtask and stage
 * states are internal: they may choose progress text, but they must never be
 * rendered as a second task-status vocabulary
 * (2026-10-28 transparent execution §status and trajectory consistency).
 *
 * Mirrored from `src/task/task-state.ts` (`TASK_STATUS_LABELS`); a parity test
 * fails if the two drift.
 */
export type TaskStatus = 'queued' | 'running' | 'needs_action' | 'succeeded' | 'failed' | 'cancelled';

export const TASK_STATUSES: readonly TaskStatus[] = [
  'queued',
  'running',
  'needs_action',
  'succeeded',
  'failed',
  'cancelled',
];

export const TASK_STATUS_LABEL: Readonly<Record<TaskStatus, string>> = Object.freeze({
  queued: '排队',
  running: '执行中',
  needs_action: '待处理',
  succeeded: '成功',
  failed: '失败',
  cancelled: '取消',
});

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

/** The status label for a durable Task conclusion, or null for anything else. */
export function taskStatusLabel(value: unknown): string | null {
  return isTaskStatus(value) ? TASK_STATUS_LABEL[value] : null;
}
