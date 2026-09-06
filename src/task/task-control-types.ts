import type { TaskStatus } from '../core/types.js';

export type TaskClearScope = 'all' | 'parked' | 'blocked';
export type TaskStatusQueryScope = 'blocked' | 'running' | 'dashboard';
export const MANAGEABLE_TASK_STATUSES: TaskStatus[] = ['created', 'ready', 'running', 'parked', 'blocked'];

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
