/**
 * MetaWork 唯一 TUI 的客户端展示模型（统一 TUI 设计 §10.1）。
 *
 * 这是客户端只读读模型，不是 Task 或 Conversation 的第二份持久真相：
 * - Turn 的 running/completed/failed/blocked/cancelled 必须来自 Server 事件；
 * - sending/reconnecting/cancelling-requested 等只是 UI 状态；
 * - 所有集合必须有界（有界去重窗口、有界历史缓存、有界 trace）。
 */

import type { ConversationContentReference } from "../../anyfusion/conversation-observation-protocol.ts";
import type { GatewayCommandEnvelope } from "../../anyfusion/gateway-protocol.ts";

export type MetaWorkConnectionState = "connecting" | "ready" | "reconnecting" | "incompatible" | "draining" | "closed";

export type MetaWorkTurnStatus = "running" | "completed" | "failed" | "blocked" | "cancelled";

export type MetaWorkTurnStage =
	| "understanding"
	| "planning"
	| "authorization"
	| "execution"
	| "verification"
	| "delivery";

export interface MetaWorkTraceItem {
	readonly eventKey: string | null;
	readonly stage: MetaWorkTurnStage;
	readonly actor: string;
	readonly title: string;
	readonly summary: string;
	readonly occurredAt: string | null;
}

export interface MetaWorkSubtaskProjection {
	readonly id: string;
	readonly title: string;
	readonly status: string;
	readonly progress: string;
	readonly executor: string | null;
	readonly heartbeatAt: string | null;
	readonly attempts?: readonly MetaWorkAttemptProjection[];
}

export interface MetaWorkAttemptProjection {
	readonly attemptId: string;
	readonly label: string;
	readonly status: string;
	readonly startedAt: string | null;
	readonly updatedAt: string | null;
	readonly result: string;
}

export interface MetaWorkRoutingProjection {
	readonly executor: string | null;
	readonly provider: string | null;
	readonly model: string | null;
	readonly harness: string | null;
}

export type MetaWorkPermissionStatus = "pending" | "resolved" | "expired";

export interface MetaWorkPermissionProjection {
	readonly requestRevision?: string;
	readonly generationId?: string;
	readonly detailsRef?: ConversationContentReference;
	readonly requestId: string;
	readonly summary: string;
	readonly status: MetaWorkPermissionStatus;
}

export interface MetaWorkResultProjection {
	readonly resultId: string;
	readonly content: string;
	readonly contentHash: string;
	readonly byteLength: number;
	readonly certification: "certified" | "uncertified";
	/** hash/字节校验失败只表示结果传输问题，不是 Kernel 认证失败。 */
	readonly verification: "available" | "streaming" | "certified" | "uncertified" | "failed";
}

export type MetaWorkBillUserStatus = "billed" | "unconfirmed" | "no_charge";

/** 阶段与模型用量行（服务端 stageBreakdown 的展示投影）。 */
export interface MetaWorkBillStageUsage {
	readonly stage: string | null;
	readonly agentClassRef: string | null;
	readonly providerRef: string | null;
	readonly modelId: string | null;
	readonly inputTokens: string;
	readonly outputTokens: string;
	readonly totalTokens: string;
	/** 各阶段金额：服务端格式化的十进制 MetaCoin 展示值；pending 时为 null。 */
	readonly assessedMetaCoin: string | null;
	readonly costStatus: "calculated" | "not_chargeable" | "pending";
}

/** 单 Turn 三态账单用户视图（服务端 TurnBillUserView）的 TUI 投影。 */
export interface MetaWorkTurnBillView {
	readonly userStatus: MetaWorkBillUserStatus;
	/** 服务端主文案，如 `本次费用：1.2 MetaCoin`；金额展示以服务端为准。 */
	readonly headline: string;
	/** 服务端格式化的十进制 MetaCoin 展示值（如 `1.416796`）；unconfirmed 时为 null，展示层不做计价。 */
	readonly amountMicroCoin: string | null;
	readonly amountIsFinal: boolean;
	readonly diagnosticMessage: string | null;
	readonly stageBreakdown: readonly MetaWorkBillStageUsage[];
	readonly billId: string | null;
	readonly finalizedAt: string | null;
}

export interface MetaWorkTaskUsageSummary {
	readonly taskId: string;
	readonly finalizedMicroCoin: string;
	readonly pendingReconciliationMicroCoin: string;
	readonly inFlightMicroCoin: string;
	readonly queryCount: number;
	readonly confirmedDeductedMicroCoin: string;
}

export interface MetaWorkArtifactProjection {
	readonly artifactId: string;
	readonly displayName: string;
	readonly relativePath: string;
	readonly mediaType: string;
	readonly previewable: boolean;
	readonly byteLength: number;
	readonly publishedAt: string;
}

export interface MetaWorkTurnProjection {
	readonly answerRef?: ConversationContentReference | null;
	readonly userInputRef?: ConversationContentReference | null;
	readonly id: string;
	readonly requestId: string | null;
	readonly interactionKind: "ai_turn" | "system_command";
	readonly userInput: string;
	/** 权威状态只能来自 Server 事件流；传输问题不得改写业务状态。 */
	readonly status: MetaWorkTurnStatus;
	readonly stage: MetaWorkTurnStage;
	/** Task 与 Turn 的关联来自服务端 trace/task 投影，不按标题或顺序猜。 */
	readonly taskId: string | null;
	readonly progressSummary: string | null;
	readonly taskTitle?: string;
	readonly taskStatus?: string;
	/**
	 * 用户可见 Task 阶段；展示层必须优先消费它，taskStatus 只作历史回退。
	 * 来自 `task_view_snapshot.lifecycle.phase`（task lifecycle 收敛 §7）。
	 */
	readonly taskPhase?: string;
	readonly taskNextAction?: string;
	/** 服务端提供的最近调度原因；排队时解释为什么尚未启动。 */
	readonly schedulingReason?: string | null;
	readonly routing?: MetaWorkRoutingProjection | null;
	/** Latest applied Conversation fact for this Turn, not a connection stream sequence. */
	readonly lastTaskSequence?: number;
	/** 服务端 Task 开始/完成时间；活动 Attempt 时长由它们与本地展示时钟计算。 */
	readonly taskStartedAt: string | null;
	readonly taskCompletedAt: string | null;
	/** 最近一次收到该 Turn 事实的时间：只表示“多久没收到更新”。 */
	readonly lastEventAt: string | null;
	readonly trace: MetaWorkTraceItem[];
	readonly subtasks: Record<string, MetaWorkSubtaskProjection>;
	readonly permission: MetaWorkPermissionProjection | null;
	readonly result: MetaWorkResultProjection | null;
	readonly artifacts: MetaWorkArtifactProjection[];
	readonly answer: string;
	readonly answerSources: Array<"result_stream" | "final_answer">;
	readonly error: string | null;
	readonly turnBill?: MetaWorkTurnBillView | null;
	readonly taskUsageSummary?: MetaWorkTaskUsageSummary | null;
	readonly startedAtSequence: number;
	readonly startedAt?: string | null;
}

export interface MetaWorkHistoryPage {
	readonly turnsLoaded: number;
	readonly previousCursor: string | null;
	readonly nextCursor: string | null;
}

export interface MetaWorkConversationProjection {
	readonly conversationId: string;
	/** 只由该 Conversation 自身事件流推进；Workspace/connection 流不参与。 */
	readonly cursor: number;
	readonly turnOrder: string[];
	readonly turns: Record<string, MetaWorkTurnProjection>;
	/** 结果可能先于历史/终态事件回放；缓存但不把它展示成运行中的 Turn。 */
	readonly pendingResults: Record<string, MetaWorkResultProjection>;
	/** 历史分页游标（向更早翻页）；null 表示未加载或已到头。 */
	readonly historyCursor: string | null;
	readonly historyExhausted: boolean;
	readonly historyTurnIds: string[];
	readonly historyTransfer?: {
		readonly id: string;
		readonly count: number;
		readonly byteLength: number;
		readonly hash: string;
		readonly parts: string[];
	} | null;
	/** task_view_snapshot 的水位（asOfSequence），按 turnId 记录。 */
	readonly taskViewWatermarks: Record<string, number>;
	/** task_projection 投影的当前 Task（Conversation 级摘要）。 */
	readonly currentTaskId: string | null;
}

export interface MetaWorkWorkspaceProjection {
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
		readonly state: "idle" | "planning" | "queued" | "executing" | "waiting" | "blocked";
		readonly taskId: string | null;
		readonly updatedAt: string;
	};
}

export type MetaWorkSubmissionState =
	| "awaiting_receipt"
	| "accepted"
	| "duplicate"
	| "rejected"
	/** 发送后断线且没有 receipt：受理状态待确认，只可重放同一 envelope。 */
	| "uncertain";

export interface MetaWorkPendingSubmission {
	readonly requestId: string;
	/** 提交瞬间固定的不可变 envelope；断线重放必须复用它，不生成新 ID。 */
	readonly envelope: GatewayCommandEnvelope;
	readonly state: MetaWorkSubmissionState;
	readonly reason: string | null;
	readonly queuedAt: number;
}

export interface MetaWorkCompletionState {
	readonly requestId: string;
	readonly targetConversationId: string | null;
	readonly state: "inactive" | "incomplete" | "executable" | "invalid";
	readonly suggestions: Array<{
		readonly value: string;
		readonly label: string;
		readonly description: string;
		readonly replacement: { readonly start: number; readonly end: number; readonly text: string };
	}>;
	readonly hint: string | null;
	readonly error: string | null;
	/** 客户端编辑器输入版本；旧响应不得覆盖新草稿。 */
	readonly inputVersion: number;
}

export interface MetaWorkUiState {
	/** 每个 Conversation 的进程内草稿；绝不跨 Conversation 发送。 */
	readonly drafts: Record<string, string>;
	/** 每个 Conversation 当前选中的 Turn；到达新进展时不被抢占。 */
	readonly selectedTurnIds: Record<string, string>;
	readonly focus: "editor" | "history" | "task_panel" | "permission" | "menu";
	readonly expandedPanels: Record<string, boolean>;
	readonly theme: string;
}

export interface MetaWorkClientState {
	readonly connection: MetaWorkConnectionState;
	/** 按实际流隔离的水位；不同流的序号互不比较。 */
	readonly streamSequences: Record<string, number>;
	/** 有界 eventId 去重窗口（FIFO）。 */
	readonly seenEventIds: readonly string[];
	readonly activeWorkspace: MetaWorkWorkspaceProjection | null;
	readonly conversationSummaries: MetaWorkConversationSummary[];
	readonly conversationDirectoryCursor: string | null;
	readonly conversationDirectoryQuery?: string;
	readonly selectedConversationId: string | null;
	/** 客户端递增导航代际；过时响应不得覆盖新选择。 */
	readonly navigationGeneration: number;
	readonly conversations: Record<string, MetaWorkConversationProjection>;
	readonly pendingSubmissions: Record<string, MetaWorkPendingSubmission>;
	/** 按 scope key（"workspace" 或 conversationId）保存最新补全响应。 */
	readonly completions: Record<string, MetaWorkCompletionState>;
	/** 每个 scope 最近一次补全请求；旧响应不得覆盖新草稿。 */
	readonly completionRequests: Record<
		string,
		{
			readonly requestId: string;
			readonly inputVersion: number;
		}
	>;
	readonly ui: MetaWorkUiState;
	readonly notices: Array<{
		readonly kind: "info" | "error" | "unknown_event";
		readonly text: string;
	}>;
}

/** 有界集合上限（§10.3：不能随着整天运行无限增长）。 */
export const METAWORK_CLIENT_LIMITS = {
	seenEventIds: 2_000,
	conversationCache: 8,
	turnsPerConversation: 200,
	traceItemsPerTurn: 80,
	notices: 20,
	pendingSubmissions: 100,
} as const;

export function emptyMetaWorkClientState(): MetaWorkClientState {
	return {
		connection: "connecting",
		streamSequences: {},
		seenEventIds: [],
		activeWorkspace: null,
		conversationSummaries: [],
		conversationDirectoryCursor: null,
		selectedConversationId: null,
		navigationGeneration: 0,
		conversations: {},
		pendingSubmissions: {},
		completions: {},
		completionRequests: {},
		ui: {
			drafts: {},
			selectedTurnIds: {},
			focus: "editor",
			expandedPanels: {},
			theme: "default",
		},
		notices: [],
	};
}

export function emptyConversationProjection(conversationId: string): MetaWorkConversationProjection {
	return {
		conversationId,
		cursor: 0,
		turnOrder: [],
		turns: {},
		pendingResults: {},
		historyCursor: null,
		historyExhausted: false,
		historyTurnIds: [],
		taskViewWatermarks: {},
		currentTaskId: null,
	};
}
