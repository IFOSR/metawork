import type {
  TaskOperationPhase,
  TaskPendingAction,
  TaskReason,
  TaskStatus,
} from '../task/task-state.js';
/**
 * Small shared descriptor for the Conversation activity card. It carries the
 * same committed Task state version every other surface reads; it never
 * re-derives a Task conclusion.
 */
export interface ConversationTaskSummary {
  readonly taskId: string;
  readonly title: string;
  readonly executionGeneration: string;
  readonly graphRevision?: number;
  readonly status: TaskStatus;
  readonly statusLabel: string;
  readonly stateVersion: number;
  readonly reason: TaskReason;
  readonly phase: TaskOperationPhase | null;
  readonly pendingActions: readonly TaskPendingAction[];
  readonly explanation: string;
  readonly progressSummary?: string;
  readonly canCancel: boolean;
  /** An attempt is settling; cancellation has not yet released execution. */
  readonly executionSettling?: boolean;
}

export interface PendingInteractionSummary {
  readonly requestId: string;
  readonly requestRevision: string;
  readonly taskId: string;
  readonly generationId: string;
  readonly subtaskId: string;
  readonly attemptId: string;
  readonly resource: string;
  readonly operation: string;
  readonly reason: string;
  readonly capability: string;
  readonly scope: string;
  readonly expiresAt: string;
  readonly detailsRef?: { readonly hash: string; readonly byteLength: number };
}

export interface ConversationActivityView {
  readonly tasks: readonly ConversationTaskSummary[];
  readonly nextCursor: string | null;
  readonly pendingNextCursor?: string | null;
  readonly pendingInteractions: readonly PendingInteractionSummary[];
}
