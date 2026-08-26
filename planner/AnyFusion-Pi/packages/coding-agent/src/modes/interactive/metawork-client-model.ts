export type MetaWorkStage =
	| "understanding"
	| "planning"
	| "authorization"
	| "execution"
	| "verification"
	| "delivery";

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

export interface ConversationViewModel {
	readonly connection: "connected" | "resync_required";
	readonly lastSequence: number;
	readonly seenEventIds: string[];
	readonly seenEventKeys: string[];
	readonly workspace: {
		readonly path: string;
		readonly selectedAt: string;
	} | null;
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
		seenEventIds: [],
		seenEventKeys: [],
		workspace: null,
		currentTurn: null,
		composer: { blockedReason: null },
		notices: [],
		historyTaskNotice: null,
	};
}
