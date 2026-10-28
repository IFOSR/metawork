import type { LocalServiceOperation, LocalServiceView } from '../task/local-service.js';
import type { PendingResultIdentity } from '../task/safe-result-identity.js';
export interface TaskControlReceipt {
  taskId: string;
  affectedSubtaskIds: string[];
  cleanupAttemptIds: string[];
}

export interface TaskControlPort {
  taskView?(taskId: string): import('../task/task-view.js').TaskView | null;
  publicTaskDelivery?(taskId: string): Promise<import('../delivery/public-delivery-view.js').PublicDeliveryView | null>;
  pendingTaskResult?(taskId: string): PendingResultIdentity | null;
  localServiceTaskId?(serviceId: string, conversationId?: string): Promise<string | null>;
  readLocalService?(serviceId: string, logs?: boolean, taskId?: string): Promise<LocalServiceView | string>;
  manageLocalService?(taskId: string, operation: LocalServiceOperation, serviceId?: string, turnId?: string | null): Promise<LocalServiceView>;
  cancelTask(taskId: string, reason?: string): Promise<TaskControlReceipt>;
  /**
   * Marks the Task as needing user action. It records the durable blocker and
   * lets the Task state authority conclude; the command never writes a status.
   */
  blockTask?(taskId: string, reason: string): Promise<void>;
  cancelSubtasks(
    taskId: string,
    targetSubtaskIds: string[],
    reason?: string,
  ): Promise<TaskControlReceipt>;
  retryRemainingWork?(taskId: string): Promise<TaskControlReceipt>;
  retryTaskResult?(taskId: string, expectedResult: PendingResultIdentity): Promise<TaskControlReceipt>;
  acceptPartialResult(taskId: string, expectedResult?: PendingResultIdentity): Promise<TaskControlReceipt>;
}
