import type { TaskStatus } from '../core/types.js';

export type TaskClearScope = 'all' | 'parked' | 'blocked';
export type TaskStatusQueryScope = 'needs_action' | 'running' | 'dashboard';

/**
 * Statuses a Task can be cleared from. `needs_action` covers both former
 * `parked` and `blocked` scopes because they are one user-facing state now.
 */
export const MANAGEABLE_TASK_STATUSES: TaskStatus[] = ['queued', 'running', 'needs_action'];

/**
 * Durable `/task clear` outcome per Task (2026-09-06 plan §5.3.7): the report
 * must reflect the actual durable postconditions, never a blanket "cancelled".
 */
export type TaskClearOutcomeStatus =
  | 'cleared'
  | 'already_cleared'
  | 'recovery_in_progress'
  | 'clear_blocked';

export interface TaskClearOutcome {
  taskId: string;
  status: TaskClearOutcomeStatus;
  residue: string[];
  phase?: string;
}
