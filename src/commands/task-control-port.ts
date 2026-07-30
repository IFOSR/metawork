export interface TaskControlReceipt {
  taskId: string;
  affectedSubtaskIds: string[];
  cleanupAttemptIds: string[];
}

export interface TaskControlPort {
  cancelTask(taskId: string, reason?: string): Promise<TaskControlReceipt>;
  cancelSubtasks(
    taskId: string,
    targetSubtaskIds: string[],
    reason?: string,
  ): Promise<TaskControlReceipt>;
  acceptPartialResult(taskId: string): Promise<TaskControlReceipt>;
}
