/** Mirror of the root Conversation observation DTOs. No runtime/storage dependency. */

export const CONVERSATION_BASELINE_BYTES = 256 * 1024;
export const CONVERSATION_PREVIEW_BYTES = 4 * 1024;

export interface ConversationContentReference {
	readonly hash: string;
	readonly byteLength: number;
}

/** Small entities only. Trace, artifacts, billing and full content are separate resources. */
export interface ConversationTurnView {
	readonly id: string;
	readonly conversationId: string;
	readonly requestId: string | null;
	readonly revision: number;
	readonly firstSequence: number;
	readonly lastSequence: number;
	readonly userInput: string;
	readonly userInputRef: ConversationContentReference | null;
	readonly answer: string;
	readonly answerRef: ConversationContentReference | null;
	readonly resultId: string | null;
	readonly certification: "certified" | "uncertified" | null;
	readonly completeness: "complete" | "partial" | "incomplete" | null;
	readonly resultOffset: number;
	readonly resultPreviewOmitted: boolean;
	readonly status: "running" | "completed" | "failed" | "blocked" | "cancelled";
	readonly deliveryStatus: "none" | "streaming" | "verifying" | "ready" | "failed";
	readonly taskId: string | null;
	readonly startedAt: string;
	readonly completedAt: string | null;
	readonly interactionKind: "system_command" | "ai_turn";
}

export interface ConversationViewCursor {
	readonly epoch: string;
	readonly revision: number;
}

export interface ConversationReadHead extends ConversationViewCursor {
	readonly journalSequence: number;
}

export interface ConversationTurnPage {
	readonly asOf?: ConversationViewCursor;
	readonly turns: readonly ConversationTurnView[];
	readonly nextCursor: string | null;
}

export interface ConversationReadBaseline extends ConversationTurnPage {
	readonly head: ConversationReadHead | null;
}

export interface ConversationViewChange extends ConversationViewCursor {
	readonly removed?: true;
	readonly prevRevision: number;
	readonly turn: ConversationTurnView;
}

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

export const OBSERVATION_CAPABILITY = "conversation_observation_v1";
export const MAX_CONNECTION_OBSERVATIONS = 8;
export const MAX_OBSERVATION_FRAME_BYTES = 64 * 1024;

export type ConversationObservationFrame = {
	readonly observationId: string;
	readonly conversationId: string;
} & (
	| {
			readonly kind: "baseline";
			readonly transferId: string;
			readonly index: number;
			readonly count: number;
			readonly byteLength: number;
			readonly hash: string;
			readonly data: string;
	  }
	| { readonly kind: "patch"; readonly change: ConversationViewChange }
	| { readonly kind: "activity"; readonly view: ConversationActivityView; readonly revision: string }
	| {
			readonly kind: "freshness";
			readonly sourceSequence: number | null;
			readonly projectedSequence: number;
			readonly preparing: boolean;
	  }
	| { readonly kind: "reset"; readonly reason: "cursor_expired" | "projection_changed" }
	| { readonly kind: "closed"; readonly reason: "authorization_revoked" | "slow_consumer" | "read_unavailable" }
);
