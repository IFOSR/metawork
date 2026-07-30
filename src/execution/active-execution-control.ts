export interface ActiveExecutionControl {
  abortAttempt(taskId: string, attemptId: string): boolean;
  abortTask(taskId: string): number;
}
