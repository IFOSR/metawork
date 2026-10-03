/** Small shared descriptors; Task Domain remains the lifecycle/phase authority. */
export interface ConversationTaskSummary {
  readonly taskId: string;
  readonly title: string;
  readonly executionGeneration: string;
  readonly phase: string;
  readonly explanation: string;
  readonly progressSummary?: string;
  readonly canCancel: boolean;
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
