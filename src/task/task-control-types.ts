import type { TaskStatus } from '../core/types.js';

export type TaskClearScope = 'all' | 'parked' | 'blocked';
export type TaskStatusQueryScope = 'blocked' | 'running' | 'dashboard';
export const MANAGEABLE_TASK_STATUSES: TaskStatus[] = ['created', 'ready', 'running', 'parked', 'blocked'];
