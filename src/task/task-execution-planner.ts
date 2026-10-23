// Determines how a Task's current conclusion maps to continuing it or creating a
// related follow-up Task. It never writes a status: the Kernel authorizes and the
// Task Domain port applies the resulting state change.
import type { Task, TaskStatus } from '../core/types.js';

export type TaskExecutionPlan =
  | {
      mode: 'reuse-existing';
      executionTaskId: string;
      contextTaskId: string;
      /** The Task conclusion the follow-up continues from. */
      currentStatus: TaskStatus;
    }
  | {
      mode: 'fork-follow-up';
      contextTaskId: string;
      /** A failed Task is continued by a related Task; the original is unchanged. */
      retryOfTaskId: string | null;
      newTaskInput: {
        title: string;
        goal: string;
        resources: string[];
      };
    }
  | {
      mode: 'blocked';
      error: string;
    };

export function planTaskExecution(task: Task, userPrompt: string): TaskExecutionPlan {
  switch (task.status) {
    case 'queued':
    case 'running':
    case 'needs_action':
      // `needs_action` is resumable: the user addressed the item and the work can
      // continue, so the same Task re-enters the queue instead of forking.
      return {
        mode: 'reuse-existing',
        executionTaskId: task.id,
        contextTaskId: task.id,
        currentStatus: task.status,
      };
    case 'succeeded':
    case 'cancelled':
      return {
        mode: 'fork-follow-up',
        contextTaskId: task.id,
        retryOfTaskId: null,
        newTaskInput: {
          title: userPrompt.slice(0, 50),
          goal: userPrompt,
          resources: task.resources,
        },
      };
    case 'failed':
      return {
        mode: 'fork-follow-up',
        contextTaskId: task.id,
        retryOfTaskId: task.id,
        newTaskInput: {
          title: userPrompt.slice(0, 50),
          goal: userPrompt,
          resources: task.resources,
        },
      };
  }
}
