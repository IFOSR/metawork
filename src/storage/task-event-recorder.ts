import type { TaskEventRepo } from './task-event-repo.js';
import { generateInteractionId } from '../utils/id.js';

/**
 * Single writer for task/subtask lifecycle events. Owns the task_events row
 * envelope (id prefix, timestamp) so callers only supply semantic fields and
 * the shape stays consistent across the runtime and execution coordinator.
 */
export class TaskEventRecorder {
  constructor(private readonly taskEventRepo: TaskEventRepo) {}

  record(
    taskId: string,
    subtaskId: string | null,
    eventType: string,
    message: string,
    payload: Record<string, unknown>,
  ): void {
    this.taskEventRepo.insert({
      id: `te_${generateInteractionId()}`,
      taskId,
      subtaskId,
      eventType,
      message,
      payload,
      createdAt: new Date().toISOString(),
    });
  }
}
