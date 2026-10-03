import type { TaskViewFacts } from './task-view.js';

/** Bounded witnesses for the canonical phase projection, never a replacement Task authority.
 * Detail-only collections (all Subtasks, settled Attempts, completion reasons) are omitted.
 */
export interface TaskActivityFactsReader {
  read(task: TaskViewFacts['task'], pendingPermission: TaskViewFacts['pendingPermission']): TaskViewFacts;
}
