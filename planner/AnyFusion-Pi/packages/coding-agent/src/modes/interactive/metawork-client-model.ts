export type MetaWorkStage =
	| "understanding"
	| "planning"
	| "authorization"
	| "execution"
	| "verification"
	| "delivery";

export type MetaWorkInteractionKind = "system_command" | "ai_turn";

export interface MetaWorkTraceItem {
	readonly eventKey: string | null;
	readonly stage: MetaWorkStage;
	readonly actor: string;
	readonly title: string;
	readonly summary: string;
}

export interface MetaWorkSubtaskView {
	readonly id: string;
	readonly title: string;
	readonly status: string;
	readonly progress: string;
	readonly heartbeat: boolean;
}

export interface MetaWorkPermissionView {
	readonly requestId: string;
	readonly summary: string;
	readonly status: "pending" | "resolved";
}

export interface MetaWorkResultView {
	readonly resultId: string;
	readonly content: string;
	readonly contentHash: string;
	readonly byteLength: number;
	readonly certification: "certified" | "uncertified";
	readonly verification: "streaming" | "certified" | "uncertified" | "failed";
}

export interface MetaWorkTurnView {
	readonly interactionKind: "ai_turn";
	readonly id: string;
	readonly requestId: string | null;
	readonly status: "running" | "completed" | "failed" | "cancelled";
	readonly stage: MetaWorkStage;
	readonly trace: MetaWorkTraceItem[];
	readonly authorization: string[];
	readonly subtasks: Record<string, MetaWorkSubtaskView>;
	readonly permission: MetaWorkPermissionView | null;
	readonly result: MetaWorkResultView | null;
	readonly answer: string;
	readonly answerSources: Array<"result_stream" | "final_answer">;
	readonly error: string | null;
}

export interface MetaWorkSystemCommandView {
	readonly interactionKind: "system_command";
	readonly id: string;
	readonly requestId: string | null;
	readonly status: "running" | "completed" | "failed";
	readonly resultId: string | null;
	readonly contentHash: string;
	readonly byteLength: number;
	readonly output: string;
	readonly error: string | null;
}

export type MetaWorkConversationActivity =
	| "idle"
	| "planning"
	| "executing"
	| "waiting"
	| "blocked";

export interface MetaWorkWorkspaceView {
	readonly id: string;
	readonly displayName: string;
	readonly path: string;
	readonly availability: "available" | "unavailable";
}

export interface MetaWorkConversationSummary {
	readonly conversationId: string;
	readonly workspaceId: string;
	readonly title: string;
	readonly preview: string;
	readonly updatedAt: string;
	readonly activity: {
		readonly state: MetaWorkConversationActivity;
		readonly taskId: string | null;
		readonly updatedAt: string;
	};
}

export interface ConversationViewModel {
	readonly connection: "connected" | "resync_required";
	readonly lastSequence: number;
	readonly streamSequences: Record<string, number>;
	readonly seenEventIds: string[];
	readonly seenEventKeys: string[];
	readonly activeWorkspace: MetaWorkWorkspaceView | null;
	readonly conversationSummaries: MetaWorkConversationSummary[];
	readonly conversationDirectoryCursor: string | null;
	readonly activeConversationId: string | null;
	readonly currentCommand: MetaWorkSystemCommandView | null;
	readonly currentTurn: MetaWorkTurnView | null;
	readonly composer: {
		readonly blockedReason: string | null;
	};
	readonly notices: Array<{
		readonly kind: "info" | "error" | "unknown_event";
		readonly text: string;
	}>;
	readonly historyTaskNotice: string | null;
}

export function emptyConversationViewModel(): ConversationViewModel {
	return {
		connection: "connected",
		lastSequence: 0,
		streamSequences: {},
		seenEventIds: [],
		seenEventKeys: [],
		activeWorkspace: null,
		conversationSummaries: [],
		conversationDirectoryCursor: null,
		activeConversationId: null,
		currentCommand: null,
		currentTurn: null,
		composer: { blockedReason: null },
		notices: [],
		historyTaskNotice: null,
	};
}
