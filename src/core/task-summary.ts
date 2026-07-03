import type { Task } from './types.js';
import type { TaskSummary } from './llm-bridge.js';

/**
 * Project tasks into the compact summary shape consumed by planning context
 * and resume-intent observation. Single source of truth so the projection
 * cannot drift between the planner path and the runtime path.
 */
export function buildRecentTaskSummaries(tasks: Task[]): TaskSummary[] {
  return tasks.map(task => ({
    id: task.id,
    title: task.title,
    goal: task.goal,
    summary: task.summary,
    status: task.status,
  }));
}
