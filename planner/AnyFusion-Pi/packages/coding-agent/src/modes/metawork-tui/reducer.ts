/**
 * MetaWork 唯一 TUI 的确定性 reducer（统一 TUI 设计 §10.2）。
 *
 * live、历史分页、replay 和只读 Task 快照进入同一归一化管道。
 * 必须保持的不变量：
 * 1. stream 序号按实际流隔离；Workspace/connection 流不推进 Conversation cursor。
 * 2. 同一 eventId 幂等；eventKey 只用于同 Turn 内的领域进展去重。
 * 3. origin 过滤导致的序号间隔不表示丢包，绝不按 last + 1 触发重连。
 * 4. 旧 Task/历史 Turn 事件只更新对应记录，不重开已结束 Turn、不覆盖选中项。
 * 5. 终态单调：迟到的结果可以丰富内容，不能把终态改回 running。
 * 6. Task 快照水位之前的缓冲事件不重复应用，之后的合法事件继续应用。
 * 7. result 流按 resultId/offset 去重；hash/字节校验失败只表示传输问题。
 * 8. 关联只使用时间、requestId 和 canonical ID。
 */

import { createHash } from "node:crypto";
import type {
	GatewayCommandReceipt,
	GatewayEventEnvelope,
	GatewayReplay,
} from "../../anyfusion/gateway-protocol.ts";
import {
	METAWORK_CLIENT_LIMITS,
	emptyConversationProjection,
	type MetaWorkClientState,
	type MetaWorkCompletionState,
	type MetaWorkConversationProjection,
	type MetaWorkPendingSubmission,
	type MetaWorkPermissionProjection,
	type MetaWorkResultProjection,
	type MetaWorkTurnProjection,
	type MetaWorkTurnStage,
	type MetaWorkTurnStatus,
} from "./model.ts";
import {
	asNumber,
	asRecord,
	asString,
	asStringArray,
	normalizeCompletion,
	normalizeHistoryPage,
	normalizeResultMetadata,
	normalizeTaskView,
	normalizeTurnBillView,
	normalizeTaskUsageSummary,
	normalizeTraceEvents,
	sanitizeDisplayText,
	type NormalizedCompletion,
} from "./protocol-adapter.ts";

const TERMINAL_TURN_STATUSES: readonly MetaWorkTurnStatus[] = [
	"completed",
	"failed",
	"cancelled",
];

const KNOWN_EVENT_KINDS = new Set([
	"conversation_snapshot",
	"workspace_changed",
	"workspace_directory_snapshot",
	"workspace_conversation_upserted",
	"workspace_conversation_removed",
	"workspace_activity_changed",
	"workspace_availability_changed",
	"conversation_history_page",
	"turn_started",
	"trace_delta",
	"task_projection",
	"execution_delta",
	"permission_request",
	"artifact",
	"result_delivery_available",
	"result_chunk",
	"result_completed",
	"final_answer",
	"terminal_error",
	"delivery_status",
	"command_completion",
	"task_view_snapshot",
	"usage_billing_projection",
]);

const WORKSPACE_EVENT_KINDS = new Set([
	"workspace_changed",
	"workspace_directory_snapshot",
	"workspace_conversation_upserted",
	"workspace_conversation_removed",
	"workspace_activity_changed",
	"workspace_availability_changed",
]);

const CONNECTION_STREAM_EVENT_KINDS = new Set([
	"command_completion",
	"task_view_snapshot",
	"usage_billing_projection",
]);

// ---------------------------------------------------------------------------
// 入口：事件、回放、回执
// ---------------------------------------------------------------------------

export function reduceGatewayEvent(
	state: MetaWorkClientState,
	event: GatewayEventEnvelope,
): MetaWorkClientState {
	// 不变量 2：eventId 幂等。
	if (state.seenEventIds.includes(event.eventId)) return state;

	// 不变量 1/3：按流隔离水位；间隔不等于丢包，重复序号静默跳过。
	const streamSequence = state.streamSequences[event.conversationId] ?? 0;
	if (event.sequence <= streamSequence) return state;

	let next: MetaWorkClientState = {
		...state,
		streamSequences: {
			...state.streamSequences,
			[event.conversationId]: event.sequence,
		},
		seenEventIds: boundedAppend(state.seenEventIds, event.eventId, METAWORK_CLIENT_LIMITS.seenEventIds),
	};

	if (!KNOWN_EVENT_KINDS.has(event.kind)) {
		return addNotice(next, "unknown_event", `Unknown Gateway event: ${event.kind}`);
	}
	const payload = asRecord(event.payload);
	if (!payload) return next;

	if (CONNECTION_STREAM_EVENT_KINDS.has(event.kind)) {
		return reduceConnectionStreamEvent(next, event, payload);
	}
	if (WORKSPACE_EVENT_KINDS.has(event.kind)) {
		return reduceWorkspaceEvent(next, payload, event);
	}

	// 其余事件属于某个 Conversation 流。
	return reduceConversationEvent(next, event, payload);
}

/** replay：snapshot + deltas 走同一管道，然后以 lastSequence 固定水位。 */
export function applyGatewayReplay(
	state: MetaWorkClientState,
	conversationId: string,
	replay: GatewayReplay,
): MetaWorkClientState {
	let next = state;
	const ordered = [...replay.snapshot, ...replay.deltas]
		.sort((left, right) => left.sequence - right.sequence);
	for (const event of ordered) {
		next = reduceGatewayEvent(next, event);
	}
	const streamSequence = next.streamSequences[conversationId] ?? 0;
	if (replay.lastSequence > streamSequence) {
		next = {
			...next,
			streamSequences: {
				...next.streamSequences,
				[conversationId]: replay.lastSequence,
			},
		};
	}
	const conversation = next.conversations[conversationId];
	if (conversation && conversation.cursor < replay.lastSequence) {
		next = {
			...next,
			conversations: {
				...next.conversations,
				[conversationId]: { ...conversation, cursor: replay.lastSequence },
			},
		};
	}
	return next;
}

/** 命令回执只更新受理状态，不推断 Task 已运行。 */
export function reduceReceipt(
	state: MetaWorkClientState,
	receipt: GatewayCommandReceipt,
): MetaWorkClientState {
	const pending = state.pendingSubmissions[receipt.requestId];
	if (!pending) return state;
	const stateByStatus: Record<GatewayCommandReceipt["status"], MetaWorkPendingSubmission["state"]> = {
		accepted: "accepted",
		duplicate: "duplicate",
		rejected: "rejected",
	};
	return {
		...state,
		pendingSubmissions: {
			...state.pendingSubmissions,
			[receipt.requestId]: {
				...pending,
				state: stateByStatus[receipt.status],
				reason: receipt.reason ?? null,
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Controller 动作（显式用户操作）
// ---------------------------------------------------------------------------

export function queueSubmission(
	state: MetaWorkClientState,
	envelope: MetaWorkPendingSubmission["envelope"],
	queuedAt: number,
): MetaWorkClientState {
	const submissions = { ...state.pendingSubmissions };
	submissions[envelope.requestId] = {
		requestId: envelope.requestId,
		envelope,
		state: "awaiting_receipt",
		reason: null,
		queuedAt,
	};
	const entries = Object.values(submissions).sort((left, right) => left.queuedAt - right.queuedAt);
	while (entries.length > METAWORK_CLIENT_LIMITS.pendingSubmissions) {
		const terminal = entries.find(entry =>
			entry.state === "accepted" || entry.state === "duplicate" || entry.state === "rejected"
		);
		const victim = terminal ?? entries[0]!;
		delete submissions[victim.requestId];
		entries.splice(entries.indexOf(victim), 1);
	}
	return { ...state, pendingSubmissions: submissions };
}

/** 断线且没有 receipt：标为“受理状态待确认”，只能重放同一 envelope。 */
export function markPendingSubmissionsUncertain(state: MetaWorkClientState): MetaWorkClientState {
	const entries = Object.entries(state.pendingSubmissions);
	if (!entries.some(([, submission]) => submission.state === "awaiting_receipt")) return state;
	const submissions = { ...state.pendingSubmissions };
	for (const [requestId, submission] of entries) {
		if (submission.state === "awaiting_receipt") {
			submissions[requestId] = { ...submission, state: "uncertain" };
		}
	}
	return { ...state, pendingSubmissions: submissions };
}

export function setConnectionState(
	state: MetaWorkClientState,
	connection: MetaWorkClientState["connection"],
): MetaWorkClientState {
	return state.connection === connection ? state : { ...state, connection };
}

/** 客户端 UI 提示（传输/导航错误），不是业务事实。 */
export function pushClientNotice(
	state: MetaWorkClientState,
	kind: "info" | "error" | "unknown_event",
	text: string,
): MetaWorkClientState {
	return addNotice(state, kind, text);
}

export function selectConversation(
	state: MetaWorkClientState,
	conversationId: string | null,
): MetaWorkClientState {
	if (state.selectedConversationId === conversationId) return state;
	let conversations = state.conversations;
	if (conversationId && !conversations[conversationId]) {
		conversations = ensureConversation(conversations, conversationId, conversationId);
	}
	return {
		...state,
		selectedConversationId: conversationId,
		navigationGeneration: state.navigationGeneration + 1,
		conversations,
	};
}

/** Reset only the disposable read model; drafts and admission receipts survive. */
export function resetConversationProjection(
	state: MetaWorkClientState,
	conversationId: string,
): MetaWorkClientState {
	if (!state.conversations[conversationId]) return state;
	const selectedTurnIds = { ...state.ui.selectedTurnIds };
	const completions = { ...state.completions };
	const completionRequests = { ...state.completionRequests };
	delete selectedTurnIds[conversationId];
	delete completions[conversationId];
	delete completionRequests[conversationId];
	return {
		...state,
		// Snapshot events can reuse older IDs/sequences. Other streams retain their
		// watermarks, so clearing this bounded ID window cannot replay their facts.
		seenEventIds: [],
		streamSequences: { ...state.streamSequences, [conversationId]: 0 },
		conversations: {
			...state.conversations,
			[conversationId]: emptyConversationProjection(conversationId),
		},
		completions,
		completionRequests,
		ui: { ...state.ui, selectedTurnIds },
	};
}

export function setDraft(
	state: MetaWorkClientState,
	conversationId: string,
	text: string,
): MetaWorkClientState {
	return {
		...state,
		ui: { ...state.ui, drafts: { ...state.ui.drafts, [conversationId]: text } },
	};
}

/** 显式选择历史 Turn；到达新进展不得隐式改变它。 */
export function selectTurn(
	state: MetaWorkClientState,
	conversationId: string,
	turnId: string,
): MetaWorkClientState {
	return {
		...state,
		ui: {
			...state.ui,
			selectedTurnIds: { ...state.ui.selectedTurnIds, [conversationId]: turnId },
		},
	};
}

export function requestCompletion(
	state: MetaWorkClientState,
	scopeKey: string,
	requestId: string,
	inputVersion: number,
): MetaWorkClientState {
	return {
		...state,
		completionRequests: {
			...state.completionRequests,
			[scopeKey]: { requestId, inputVersion },
		},
	};
}

/**
 * 权限决议回执：把请求标为已处理或已过期（历史回放/跨端处理/scope 不符）。
 * 展示快照中的历史请求不能自动恢复为有效授权请求。
 */
export function resolvePermissionRequest(
	state: MetaWorkClientState,
	conversationId: string,
	requestId: string,
	status: Extract<MetaWorkPermissionProjection["status"], "resolved" | "expired">,
): MetaWorkClientState {
	const conversation = state.conversations[conversationId];
	if (!conversation) return state;
	let changed = false;
	const turns = { ...conversation.turns };
	for (const [turnId, turn] of Object.entries(turns)) {
		if (turn.permission?.requestId !== requestId) continue;
		turns[turnId] = { ...turn, permission: { ...turn.permission, status } };
		changed = true;
	}
	if (!changed) return state;
	return {
		...state,
		conversations: {
			...state.conversations,
			[conversationId]: { ...conversation, turns },
		},
	};
}

// ---------------------------------------------------------------------------
// connection 流事件（只读查询响应）
// ---------------------------------------------------------------------------

function reduceConnectionStreamEvent(
	state: MetaWorkClientState,
	event: GatewayEventEnvelope,
	payload: Record<string, unknown>,
): MetaWorkClientState {
	if (event.kind === "command_completion") {
		const completion = normalizeCompletion(payload);
		return completion ? applyCompletionResponse(state, completion) : state;
	}
	if (event.kind === "usage_billing_projection") {
		const bill = normalizeTurnBillView(payload);
		const summary = normalizeTaskUsageSummary(payload);
		if (!bill && !summary) return state;
		const turns = { ...state.conversations };
		for (const [conversationId, conversation] of Object.entries(state.conversations)) {
			let changed = false;
			const nextTurns = { ...conversation.turns };
			for (const [turnId, turn] of Object.entries(nextTurns)) {
				if (bill) {
					// Turn 视图必须显式携带目标 Turn；不按 queryId 猜测归属。
					const targetTurnId = asString(payload.turnId);
					if (!targetTurnId || turnId !== targetTurnId) continue;
					nextTurns[turnId] = { ...turn, turnBill: bill };
					changed = true;
				}
				if (summary && turn.taskId === summary.taskId) {
					nextTurns[turnId] = { ...nextTurns[turnId], taskUsageSummary: summary };
					changed = true;
				}
			}
			if (changed) turns[conversationId] = { ...conversation, turns: nextTurns };
		}
		return { ...state, conversations: turns };
	}
	// task_view_snapshot
	const view = normalizeTaskView(payload);
	if (!view) return state;
	const conversations = ensureConversation(state.conversations, view.targetConversationId, state.selectedConversationId);
	const conversation = conversations[view.targetConversationId]!;
	let turn = conversation.turns[view.turnId] ?? newTurn(view.turnId, null, "ai_turn", 0);
	if (turn.taskId && turn.taskId !== view.taskId) return state;
	const appliedSequence = Math.max(
		turn.lastTaskSequence ?? turn.startedAtSequence,
		conversation.taskViewWatermarks[view.turnId] ?? 0,
	);
	if (view.asOfSequence < appliedSequence) return state;
	// 快照只丰富对应 Turn 的 Task 投影；终态单调，不用 Task 状态改写 Turn 状态。
	const subtasks = { ...turn.subtasks };
	for (const subtask of view.subtasks) {
		subtasks[subtask.id] = {
			id: subtask.id,
			title: subtask.title,
			status: subtask.status,
			executor: subtask.executor,
			progress: subtasks[subtask.id]?.progress ?? "",
			heartbeatAt: subtasks[subtask.id]?.heartbeatAt ?? null,
			attempts: view.attempts[subtask.id] ?? [],
		};
	}
	const result: MetaWorkResultProjection | null = turn.result
		?? (view.result
			? {
				resultId: view.result.resultId,
				content: "",
				contentHash: "",
				byteLength: 0,
					certification: view.result.certification,
					verification: "available",
			}
			: null);
	turn = {
		...turn,
		taskId: view.taskId,
		taskTitle: view.title,
		taskStatus: view.status,
		// 展示层消费统一投影的 phase；旧 Server 无 lifecycle 时回退到原始状态。
		taskPhase: view.lifecycle?.phase ?? turn.taskPhase ?? view.status,
		taskNextAction: view.lifecycle?.nextAuthorizedAction ?? turn.taskNextAction,
		routing: view.routing,
		progressSummary: view.progressSummary ?? turn.progressSummary,
		schedulingReason: view.schedulingReason,
		taskStartedAt: view.startedAt ?? turn.taskStartedAt,
		taskCompletedAt: view.completedAt ?? turn.taskCompletedAt,
		lastEventAt: event.occurredAt ?? turn.lastEventAt,
		subtasks,
		permission: view.pendingPermission
			? {
				requestId: view.pendingPermission.requestId,
				summary: view.pendingPermission.summary ?? "",
				status: view.pendingPermission.status,
			}
			: null,
		artifacts: mergeArtifacts(turn.artifacts, view.artifacts),
		result,
	};
	const updatedConversation: MetaWorkConversationProjection = {
		...conversation,
		turns: { ...conversation.turns, [view.turnId]: turn },
		turnOrder: conversation.turnOrder.includes(view.turnId)
			? conversation.turnOrder
			: [...conversation.turnOrder, view.turnId],
		taskViewWatermarks: {
			...conversation.taskViewWatermarks,
			[view.turnId]: Math.max(
				conversation.taskViewWatermarks[view.turnId] ?? 0,
				view.asOfSequence,
			),
		},
	};
	return {
		...state,
		conversations: {
			...conversations,
			[view.targetConversationId]: updatedConversation,
		},
	};
}

/** A buffered query response is matched after receipt, not replayed as a wire event. */
export function applyCompletionResponse(
	state: MetaWorkClientState,
	completion: NormalizedCompletion,
): MetaWorkClientState {
	const scopeKey = completion.targetConversationId ?? "workspace";
	const pending = state.completionRequests[scopeKey];
	if (!pending || pending.requestId !== completion.requestId) return state;
	const applied: MetaWorkCompletionState = { ...completion, inputVersion: pending.inputVersion };
	return { ...state, completions: { ...state.completions, [scopeKey]: applied } };
}

// ---------------------------------------------------------------------------
// Workspace 流事件
// ---------------------------------------------------------------------------

function reduceWorkspaceEvent(
	state: MetaWorkClientState,
	payload: Record<string, unknown>,
	event: GatewayEventEnvelope,
): MetaWorkClientState {
	switch (event.kind) {
		case "workspace_changed":
			return reduceAttachedWorkspace(state, payload);
		case "workspace_directory_snapshot":
			return reduceWorkspaceDirectory(state, payload);
		case "workspace_conversation_upserted":
			return reduceConversationUpsert(state, payload);
		case "workspace_conversation_removed":
			return reduceConversationRemoved(state, payload);
		case "workspace_activity_changed":
			return reduceConversationActivity(state, payload);
		case "workspace_availability_changed":
			return reduceWorkspaceAvailability(state, payload);
		default:
			return state;
	}
}

function reduceAttachedWorkspace(
	state: MetaWorkClientState,
	payload: Record<string, unknown>,
): MetaWorkClientState {
	const workspace = asRecord(payload.workspace);
	// WorkspaceRecord 使用 canonicalPath；Conversation workspace 投影使用 path。
	const workspacePath = workspace
		? asString(workspace.canonicalPath) ?? asString(workspace.path)
		: null;
	if (workspace && workspacePath) {
		const path = workspacePath;
		return {
			...state,
			activeWorkspace: {
				id: asString(workspace.id) ?? state.activeWorkspace?.id ?? "",
				displayName: asString(workspace.displayName) ?? basename(path),
				path,
				availability: workspace.availability === "unavailable" ? "unavailable" : "available",
			},
		};
	}
	return state;
}

function reduceWorkspaceDirectory(
	state: MetaWorkClientState,
	payload: Record<string, unknown>,
): MetaWorkClientState {
	const workspace = asRecord(payload.workspace);
	const path = workspace
		? asString(workspace.canonicalPath) ?? asString(workspace.path)
		: null;
	const id = asString(payload.workspaceId) ?? (workspace ? asString(workspace.id) : null);
	const requestedCursor = asString(payload.requestedCursor);
	const query = asString(payload.query) ?? "";
	if ("requestedCursor" in payload) {
		if ((state.activeWorkspace && id !== state.activeWorkspace.id)
			|| query !== (state.conversationDirectoryQuery ?? "")) return state;
		if (requestedCursor && requestedCursor !== state.conversationDirectoryCursor) return state;
	}
	const activeWorkspace = path
		? {
			id: id ?? state.activeWorkspace?.id ?? "",
			displayName: asString(workspace?.displayName) ?? basename(path),
			path,
			availability: workspace?.availability === "unavailable" ? "unavailable" as const : "available" as const,
		}
		: state.activeWorkspace;
	const page = asRecord(payload.page);
	const items = page && Array.isArray(page.items)
		? page.items
			.map(normalizeConversationSummary)
			.filter((item): item is NonNullable<typeof item> => item !== null)
		: [];
	return {
		...state,
		activeWorkspace,
		conversationSummaries: sortConversationSummaries(requestedCursor
			? [...new Map([...state.conversationSummaries, ...items].map(item => [item.conversationId, item])).values()]
			: items),
		conversationDirectoryCursor: page ? asString(page.nextCursor) : null,
		conversationDirectoryQuery: query,
	};
}

function reduceConversationUpsert(
	state: MetaWorkClientState,
	payload: Record<string, unknown>,
): MetaWorkClientState {
	const summary = normalizeConversationSummary(payload.conversation);
	if (!summary) return state;
	return {
		...state,
		conversationSummaries: sortConversationSummaries([
			...state.conversationSummaries.filter(item => item.conversationId !== summary.conversationId),
			summary,
		]),
	};
}

function reduceConversationRemoved(
	state: MetaWorkClientState,
	payload: Record<string, unknown>,
): MetaWorkClientState {
	const conversationId = asString(payload.conversationId);
	if (!conversationId) return state;
	return {
		...state,
		conversationSummaries: state.conversationSummaries
			.filter(item => item.conversationId !== conversationId),
	};
}

function reduceConversationActivity(
	state: MetaWorkClientState,
	payload: Record<string, unknown>,
): MetaWorkClientState {
	const conversationId = asString(payload.conversationId);
	const activity = normalizeActivity(payload.activity);
	if (!conversationId || !activity) return state;
	return {
		...state,
		conversationSummaries: sortConversationSummaries(
			state.conversationSummaries.map(item => (
				item.conversationId === conversationId ? { ...item, activity } : item
			)),
		),
	};
}

function reduceWorkspaceAvailability(
	state: MetaWorkClientState,
	payload: Record<string, unknown>,
): MetaWorkClientState {
	if (!state.activeWorkspace || asString(payload.workspaceId) !== state.activeWorkspace.id) {
		return state;
	}
	return {
		...state,
		activeWorkspace: {
			...state.activeWorkspace,
			availability: payload.availability === "unavailable" ? "unavailable" : "available",
		},
	};
}

function normalizeConversationSummary(value: unknown): MetaWorkClientState["conversationSummaries"][number] | null {
	const item = asRecord(value);
	if (!item) return null;
	const conversationId = asString(item.conversationId) ?? asString(item.id);
	const workspaceId = asString(item.workspaceId);
	if (!conversationId || !workspaceId) return null;
	return {
		conversationId,
		workspaceId,
		title: asString(item.title) ?? "New conversation",
		preview: asString(item.preview) ?? "",
		updatedAt: asString(item.updatedAt) ?? "",
		activity: normalizeActivity(item.activity) ?? {
			state: "idle",
			taskId: null,
			updatedAt: asString(item.updatedAt) ?? "",
		},
	};
}

function normalizeActivity(
	value: unknown,
): MetaWorkClientState["conversationSummaries"][number]["activity"] | null {
	const activity = asRecord(value);
	const state = activity ? asString(activity.state) : null;
	if (
		state !== "idle" && state !== "planning" && state !== "executing"
		&& state !== "waiting" && state !== "blocked" && state !== "queued"
	) return null;
	return {
		state,
		taskId: asString(activity?.taskId),
		updatedAt: asString(activity?.updatedAt) ?? "",
	};
}

function sortConversationSummaries<T extends {
	activity: { state: string };
	updatedAt: string;
	conversationId: string;
}>(items: T[]): T[] {
	const priority: Record<string, number> = {
		blocked: 5,
		executing: 4,
		waiting: 3,
		queued: 3,
		planning: 2,
		idle: 1,
	};
	return [...items].sort((left, right) => (
		(priority[right.activity.state] ?? 0) - (priority[left.activity.state] ?? 0)
		|| right.updatedAt.localeCompare(left.updatedAt)
		|| left.conversationId.localeCompare(right.conversationId)
	));
}

// ---------------------------------------------------------------------------
// Conversation 流事件
// ---------------------------------------------------------------------------

function reduceConversationEvent(
	state: MetaWorkClientState,
	event: GatewayEventEnvelope,
	payload: Record<string, unknown>,
): MetaWorkClientState {
	const conversationId = event.conversationId;
	const conversations = ensureConversation(state.conversations, conversationId, state.selectedConversationId);
	let conversation = conversations[conversationId]!;
	if (conversation.cursor < event.sequence) {
		conversation = { ...conversation, cursor: event.sequence };
	}

	// 不变量 6：Task 快照水位之前的缓冲事件不重复应用。
	const watermark = event.turnId ? conversation.taskViewWatermarks[event.turnId] : undefined;
	const snapshotCovered = watermark !== undefined
		&& event.sequence <= watermark
		&& (event.kind === "task_projection"
			|| event.kind === "execution_delta"
			|| event.kind === "permission_request");

	let next: MetaWorkClientState = {
		...state,
		conversations: { ...conversations, [conversationId]: conversation },
	};
	if (snapshotCovered) return next;

	switch (event.kind) {
		case "conversation_snapshot":
			return reduceConversationSnapshot(next, conversation, payload);
		case "conversation_history_page":
			return reduceHistoryPage(next, conversation, payload);
		case "turn_started":
			return reduceTurnStarted(next, conversation, event, payload);
		case "trace_delta":
			return reduceTraceDelta(next, conversation, event, payload);
		case "task_projection":
			return reduceTaskProjection(next, conversation, payload);
		case "execution_delta":
			return reduceExecutionDelta(next, conversation, event, payload);
		case "permission_request":
			return reducePermissionRequest(next, conversation, event, payload);
		case "artifact":
			return reduceArtifact(next, conversation, event, payload);
		case "result_delivery_available":
			return reduceResultAvailable(next, conversation, event, payload);
		case "result_chunk":
			return reduceResultChunk(next, conversation, event, payload);
		case "result_completed":
			return reduceResultCompleted(next, conversation, event, payload);
		case "final_answer":
			return reduceFinalAnswer(next, conversation, event, payload);
		case "terminal_error":
			return reduceTerminalError(next, conversation, event, payload);
		default:
			return next;
	}
}

function reduceConversationSnapshot(
	state: MetaWorkClientState,
	conversation: MetaWorkConversationProjection,
	payload: Record<string, unknown>,
): MetaWorkClientState {
	// conversation_snapshot 的 output lines 是简版渲染载体；多 Turn 模型以
	// get_conversation_history 的 Turn 记录为历史来源，此处只消费 workspace
	// 与 currentTaskId 关联事实。
	const currentTaskId = asString(payload.currentTaskId);
	return updateConversation(state, conversation.conversationId, {
		...conversation,
		currentTaskId: currentTaskId ?? conversation.currentTaskId,
	});
}

function reduceHistoryPage(
	state: MetaWorkClientState,
	conversation: MetaWorkConversationProjection,
	payload: Record<string, unknown>,
): MetaWorkClientState {
	if ("transfer" in payload) return reduceHistoryTransfer(state, conversation, payload);
	const page = normalizeHistoryPage(payload);
	if (!page) return state;
	const turns = { ...conversation.turns };
	const order = [...conversation.turnOrder];
	const historyTurnIds = new Set(conversation.historyTurnIds);
	// readHistory 返回新到旧；展示顺序保持时间递增，历史 Turn 排在最前。
	// 空输入的历史记录仍可能携带已保存的结果，不能因为输入缺失而丢掉结果。
	const chronological = [...page.turns].reverse();
	for (const record of chronological) {
		historyTurnIds.add(record.id);
		if (turns[record.id]) {
			// 不变量 4：历史记录只补全缺失字段，不覆盖 live 已确认的事实。
			const existing = turns[record.id]!;
			turns[record.id] = {
				...existing,
				userInput: existing.userInput || record.userInput,
				answer: existing.answer || record.finalAnswer || "",
				taskId: existing.taskId ?? record.taskId,
				startedAt: existing.startedAt ?? record.startedAt,
				status: existing.taskId && record.taskId && existing.taskId !== record.taskId
					? existing.status
					: monotonicStatus(existing.status, record.status),
			};
			continue;
		}
		turns[record.id] = {
			id: record.id,
			requestId: null,
			interactionKind: "ai_turn",
			userInput: record.userInput,
			status: record.status,
			stage: record.status === "completed" ? "delivery" : "understanding",
			taskId: record.taskId,
			progressSummary: null,
			taskStartedAt: null,
			taskCompletedAt: null,
			lastEventAt: null,
			trace: [],
			subtasks: {},
			permission: null,
			result: null,
			artifacts: [],
			answer: record.finalAnswer ?? "",
			answerSources: record.finalAnswer ? ["final_answer"] : [],
			error: null,
			startedAtSequence: 0,
			startedAt: record.startedAt,
			turnBill: null,
			taskUsageSummary: null,
		};
		historyTurnIds.add(record.id);
	}
	// Merge page order around shared IDs. A refreshed newest page may append
	// Turns, whereas a previous page prepends them; neither reverses cached facts.
	const pageOrder = chronological.map(record => record.id);
	for (const [index, id] of pageOrder.entries()) {
		if (order.includes(id)) continue;
		const next = pageOrder.slice(index + 1).find(candidate => order.includes(candidate));
		const previous = pageOrder.slice(0, index).reverse().find(candidate => order.includes(candidate));
		const startedAt = Date.parse(turns[id]?.startedAt ?? "");
		const newer = order.findIndex(candidate => Date.parse(turns[candidate]?.startedAt ?? "") > startedAt);
		const position = next ? order.indexOf(next)
			: previous ? order.indexOf(previous) + 1
				: page.previousCursor !== null ? 0
					: newer >= 0 ? newer : order.length;
		order.splice(position, 0, id);
	}
	return updateConversation(state, conversation.conversationId, sortTurnOrder({
		...conversation,
		historyTransfer: null,
		turns,
		turnOrder: order,
		historyTurnIds: [...historyTurnIds],
		historyCursor: page.nextCursor,
		historyExhausted: page.nextCursor === null,
	}));
}

function reduceHistoryTransfer(
	state: MetaWorkClientState,
	conversation: MetaWorkConversationProjection,
	payload: Record<string, unknown>,
): MetaWorkClientState {
	const transfer = asRecord(payload.transfer);
	const fail = () => addNotice(updateConversation(state, conversation.conversationId, {
		...conversation, historyTransfer: null,
	}), "error", "History transfer incomplete or invalid; reload this page.");
	if (!transfer) return fail();
	const { id, index, count, byteLength, hash, data } = transfer;
	if (typeof id !== "string" || id.length > 160
		|| typeof index !== "number" || !Number.isSafeInteger(index)
		|| typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > 128
		|| index < 0 || index >= count
		|| typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > 4 * 1024 * 1024
		|| typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)
		|| typeof data !== "string" || data.length > 48 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return fail();
	const pending = index === 0 ? { id, count, byteLength, hash, parts: [] as string[] } : conversation.historyTransfer;
	if (!pending || pending.id !== id || pending.count !== count || pending.byteLength !== byteLength
		|| pending.hash !== hash || pending.parts.length !== index) return fail();
	const parts = [...pending.parts, data];
	if (parts.length < count) {
		return updateConversation(state, conversation.conversationId, {
			...conversation, historyTransfer: { ...pending, parts },
		});
	}
	const body = Buffer.from(parts.join(""), "base64");
	if (body.length !== byteLength || createHash("sha256").update(body).digest("hex") !== hash) return fail();
	try {
		const page = asRecord(JSON.parse(body.toString("utf8")));
		if (!page || "transfer" in page || !normalizeHistoryPage(page)) return fail();
		return reduceHistoryPage(state, { ...conversation, historyTransfer: null }, page);
	} catch {
		return fail();
	}
}

function reduceTurnStarted(
	state: MetaWorkClientState,
	conversation: MetaWorkConversationProjection,
	event: GatewayEventEnvelope,
	payload: Record<string, unknown>,
): MetaWorkClientState {
	const turnId = event.turnId;
	if (!turnId) return state;
	const existing = conversation.turns[turnId];
	// 不变量 4：不重开已结束 Turn。
	if (existing && TERMINAL_TURN_STATUSES.includes(existing.status)) return state;
	const kind = payload.commandKind === "user_message" ? "ai_turn" as const : "system_command" as const;
	const turn: MetaWorkTurnProjection = existing ?? {
		...newTurn(turnId, event.requestId, kind, event.sequence),
		startedAt: event.occurredAt,
	};
	const submission = event.requestId ? state.pendingSubmissions[event.requestId]?.envelope : undefined;
	const command = submission?.command;
	const matchingScope = submission?.scope.kind === "conversation"
		&& (submission.scope.selection.mode === "new"
			|| (submission.scope.selection.mode === "attach"
				&& submission.scope.selection.conversationId === conversation.conversationId));
	const userInput = matchingScope && (command?.kind === "user_message" || command?.kind === "slash_command")
		? sanitizeDisplayText(command.text)
		: turn.userInput;
	return updateConversation(state, conversation.conversationId, {
		...conversation,
		turns: { ...conversation.turns, [turnId]: { ...turn, userInput: turn.userInput || userInput } },
		turnOrder: conversation.turnOrder.includes(turnId)
			? conversation.turnOrder
			: [...conversation.turnOrder, turnId],
	});
}

function reduceTraceDelta(
	state: MetaWorkClientState,
	conversation: MetaWorkConversationProjection,
	event: GatewayEventEnvelope,
	payload: Record<string, unknown>,
): MetaWorkClientState {
	const turnId = asString(payload.turnId) ?? event.turnId;
	if (!turnId) return state;
	const existing = conversation.turns[turnId];
	if (existing && TERMINAL_TURN_STATUSES.includes(existing.status) && !traceAllowsEnrichment(payload)) {
		return state;
	}
	// A trace fragment without a real intake cannot identify a user Turn. It is
	// presentation residue after origin filtering or journal retention.
	if (!existing) return state;
	let turn = existing;
	const taskId = asString(payload.taskId);
	if (turn.taskId && taskId && turn.taskId !== taskId) return state;
	if (taskId) turn = { ...turn, taskId };
	const traceStatus = asString(payload.status);
	if (traceStatus) {
		turn = { ...turn, status: monotonicStatus(turn.status, traceStatus) };
	}
	const traceCompletedAt = asString(payload.completedAt);
	if (traceCompletedAt) turn = { ...turn, taskCompletedAt: traceCompletedAt };
	turn = { ...turn, lastEventAt: event.occurredAt ?? turn.lastEventAt };
	const trace = [...turn.trace];
	for (const item of normalizeTraceEvents(payload)) {
		// 不变量 2：eventKey 只用于同 Turn 内的领域进展去重。
		if (item.eventKey && trace.some(existingItem => existingItem.eventKey === item.eventKey)) {
			continue;
		}
		trace.push({
			eventKey: item.eventKey,
			stage: stageForPhase(item.phase),
			actor: item.actor,
			title: item.title,
			summary: item.summary,
			occurredAt: item.occurredAt,
		});
	}
	turn = {
		...turn,
		stage: trace.at(-1)?.stage ?? turn.stage,
		trace: trace.slice(-METAWORK_CLIENT_LIMITS.traceItemsPerTurn),
	};
	return updateTurn(state, conversation, turn);
}

function reduceTaskProjection(
	state: MetaWorkClientState,
	conversation: MetaWorkConversationProjection,
	payload: Record<string, unknown>,
): MetaWorkClientState {
	const currentTaskId = asString(payload.currentTaskId);
	if (!currentTaskId || currentTaskId === conversation.currentTaskId) return state;
	return updateConversation(state, conversation.conversationId, {
		...conversation,
		currentTaskId,
	});
}

function reduceExecutionDelta(
	state: MetaWorkClientState,
	conversation: MetaWorkConversationProjection,
	event: GatewayEventEnvelope,
	payload: Record<string, unknown>,
): MetaWorkClientState {
	const turnId = event.turnId;
	const subtaskId = asString(payload.subtaskId);
	if (!turnId || !subtaskId) return state;
	// 不变量 4/5：终态 Turn 的后台执行进展仍更新对应 Task 投影（命令返回
	// 不等于任务结束），但绝不把 Turn 状态改回 running。
	const existing = conversation.turns[turnId];
	const turn = existing ?? newTurn(turnId, event.requestId, "ai_turn", event.sequence);
	const current = turn.subtasks[subtaskId];
	const taskId = asString(payload.taskId);
	if (turn.taskId && taskId && turn.taskId !== taskId) return state;
	return updateTurn(state, conversation, {
		...turn,
		taskId: turn.taskId ?? taskId,
		stage: TERMINAL_TURN_STATUSES.includes(turn.status) ? turn.stage : "execution",
		lastEventAt: event.occurredAt ?? turn.lastEventAt,
		subtasks: {
			...turn.subtasks,
			[subtaskId]: {
				...current,
				id: subtaskId,
				title: asString(payload.title) ?? current?.title ?? "Subtask",
				status: asString(payload.status) ?? current?.status ?? "running",
				progress: asString(payload.progress) ?? current?.progress ?? "",
				executor: asString(payload.executor) ?? current?.executor ?? null,
				heartbeatAt: payload.heartbeat === true ? event.occurredAt : current?.heartbeatAt ?? null,
			},
		},
	});
}

function reducePermissionRequest(
	state: MetaWorkClientState,
	conversation: MetaWorkConversationProjection,
	event: GatewayEventEnvelope,
	payload: Record<string, unknown>,
): MetaWorkClientState {
	const turnId = event.turnId;
	if (!turnId) return state;
	// 权限有自己的 pending/resolved/expired 生命周期：后台 Task 的权限请求可能
	// 晚于命令 Turn 的 final_answer 到达。重放后 Controller 必须经 get_task_view
	// 刷新事实再启用操作（§8.5）；reducer 不负责判定授权有效性。
	const existing = conversation.turns[turnId];
	const turn = existing ?? newTurn(turnId, event.requestId, "ai_turn", event.sequence);
	const permission: MetaWorkPermissionProjection = {
		requestId: asString(payload.requestId) ?? "",
		summary: asString(payload.summary) ?? "需要用户授权",
		status: "pending",
	};
	return updateTurn(state, conversation, {
		...turn,
		stage: "authorization",
		permission,
		lastEventAt: event.occurredAt ?? turn.lastEventAt,
	});
}

function reduceArtifact(
	state: MetaWorkClientState,
	conversation: MetaWorkConversationProjection,
	event: GatewayEventEnvelope,
	payload: Record<string, unknown>,
): MetaWorkClientState {
	const turnId = event.turnId;
	if (!turnId) return state;
	const artifactRecord = asRecord(payload.artifact) ?? payload;
	const artifactId = asString(artifactRecord.artifactId);
	if (!artifactId) return state;
	const turn = conversation.turns[turnId] ?? newTurn(turnId, event.requestId, "ai_turn", event.sequence);
	return updateTurn(state, conversation, {
		...turn,
		artifacts: mergeArtifacts(turn.artifacts, [{
			artifactId,
			displayName: asString(artifactRecord.displayName) ?? "",
			relativePath: asString(artifactRecord.relativePath) ?? "",
			mediaType: asString(artifactRecord.mediaType) ?? "",
			previewable: artifactRecord.previewable === true,
			byteLength: asNumber(artifactRecord.byteLength) ?? 0,
			publishedAt: asString(artifactRecord.publishedAt) ?? "",
		}]),
	});
}

function reduceResultAvailable(
	state: MetaWorkClientState,
	conversation: MetaWorkConversationProjection,
	event: GatewayEventEnvelope,
	payload: Record<string, unknown>,
): MetaWorkClientState {
	const turnId = event.turnId;
	if (!turnId) return state;
	const metadata = normalizeResultMetadata(payload);
	if (!metadata) return state;
	const turn = conversation.turns[turnId];
	const current = turn?.result ?? conversation.pendingResults[turnId];
	const result: MetaWorkResultProjection = current?.resultId === metadata.resultId
		&& current.verification !== "available" ? current : {
			resultId: metadata.resultId,
			content: "",
			contentHash: metadata.contentHash,
			byteLength: metadata.byteLength,
			certification: metadata.certification,
			verification: "streaming",
		};
	return storeResult(state, conversation, turnId, result);
}

function reduceResultChunk(
	state: MetaWorkClientState,
	conversation: MetaWorkConversationProjection,
	event: GatewayEventEnvelope,
	payload: Record<string, unknown>,
): MetaWorkClientState {
	const turnId = event.turnId;
	if (!turnId) return state;
	const turn = conversation.turns[turnId];
	const result = turn?.result ?? conversation.pendingResults[turnId];
	if (!result || result.resultId !== asString(payload.resultId)) return state;
	const offset = asNumber(payload.offset) ?? 0;
	const chunk = asString(payload.chunk) ?? "";
	// 不变量 7：按 resultId + offset 幂等拼接；重复分块产生相同字符串。
	const bytes = Buffer.from(result.content, "utf8");
	if (offset > bytes.byteLength) return state;
	const content = bytes.subarray(0, offset).toString("utf8") + chunk;
	return storeResult(state, conversation, turnId, { ...result, content });
}

function reduceResultCompleted(
	state: MetaWorkClientState,
	conversation: MetaWorkConversationProjection,
	event: GatewayEventEnvelope,
	payload: Record<string, unknown>,
): MetaWorkClientState {
	const turnId = event.turnId;
	if (!turnId) return state;
	const turn = conversation.turns[turnId];
	const result = turn?.result ?? conversation.pendingResults[turnId];
	if (!result || result.resultId !== asString(payload.resultId)) return state;
	const metadata = normalizeResultMetadata(payload);
	if (!metadata) return state;
	const contentHash = metadata.contentHash || result.contentHash;
	const byteLength = metadata.byteLength || result.byteLength;
	const verified = verifyResultContent(result.content, contentHash, byteLength);
	const completed: MetaWorkResultProjection = {
		...result,
		contentHash,
		byteLength,
		certification: metadata.certification,
		verification: verified
			? metadata.certification
			: "failed",
	};
	return storeResult(state, conversation, turnId, completed);
}

function reduceFinalAnswer(
	state: MetaWorkClientState,
	conversation: MetaWorkConversationProjection,
	event: GatewayEventEnvelope,
	payload: Record<string, unknown>,
): MetaWorkClientState {
	const turnId = event.turnId;
	if (!turnId) return state;
	const pending = conversation.pendingResults[turnId];
	const base = conversation.turns[turnId] ?? newTurn(turnId, event.requestId, "ai_turn", event.sequence);
	const turn = pending ? mergePendingResult(base, pending) : base;
	const resultId = asString(payload.resultId);
	const lines = asStringArray(payload.lines);
	const status = payload.backgroundWorkPending === true
		? turn.status
		: monotonicStatus(turn.status, "completed");
	if (turn.result && resultId === turn.result.resultId) {
		// 结果流已交付：final_answer 只固定终态，不重复追加正文。
		return updateTurn(state, conversation, {
			...turn,
			status,
			stage: "delivery",
		});
	}
	const answer = lines.join("\n");
	return updateTurn(state, conversation, {
		...turn,
		status,
		stage: "delivery",
		answer: turn.answer || answer,
		answerSources: turn.answer
			? turn.answerSources
			: [...turn.answerSources, "final_answer"],
	});
}

function reduceTerminalError(
	state: MetaWorkClientState,
	conversation: MetaWorkConversationProjection,
	event: GatewayEventEnvelope,
	payload: Record<string, unknown>,
): MetaWorkClientState {
	const turnId = event.turnId;
	if (!turnId) return state;
	const turn = conversation.turns[turnId] ?? newTurn(turnId, event.requestId, "ai_turn", event.sequence);
	const code = asString(payload.code);
	const message = asString(payload.message) ?? "Gateway execution failed";
	return updateTurn(state, conversation, {
		...turn,
		status: monotonicStatus(turn.status, code === "cancelled" ? "cancelled" : "failed"),
		error: message,
		lastEventAt: event.occurredAt ?? turn.lastEventAt,
	});
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function newTurn(
	turnId: string,
	requestId: string | null,
	interactionKind: MetaWorkTurnProjection["interactionKind"],
	sequence: number,
): MetaWorkTurnProjection {
	return {
		id: turnId,
		requestId,
		interactionKind,
		userInput: "",
		status: "running",
		stage: "understanding",
		taskId: null,
		progressSummary: null,
		taskStartedAt: null,
		taskCompletedAt: null,
		lastEventAt: null,
		trace: [],
		subtasks: {},
		permission: null,
		result: null,
		artifacts: [],
		answer: "",
		answerSources: [],
		error: null,
		startedAtSequence: sequence,
		turnBill: null,
		taskUsageSummary: null,
	};
}

/** 不变量 5：终态单调；blocked 可进入终态，但任何终态不得回到 running。 */
function monotonicStatus(current: MetaWorkTurnStatus, next: string): MetaWorkTurnStatus {
	if (TERMINAL_TURN_STATUSES.includes(current)) return current;
	if (
		next !== "running" && next !== "completed" && next !== "failed"
		&& next !== "blocked" && next !== "cancelled"
	) return current;
	if (current === "blocked" && next === "running") return current;
	return next;
}

/** 终态 Turn 上的迟到 trace 只允许内容丰富，不允许状态回退。 */
function traceAllowsEnrichment(payload: Record<string, unknown>): boolean {
	return Array.isArray(payload.events) && payload.events.length > 0;
}

function stageForPhase(phase: string): MetaWorkTurnStage {
	switch (phase) {
		case "planning":
			return "planning";
		case "authorization":
		case "routing":
			return "authorization";
		case "execution":
			return "execution";
		case "verification":
			return "verification";
		case "delivery":
			return "delivery";
		default:
			return "understanding";
	}
}

function verifyResultContent(content: string, contentHash: string, byteLength: number): boolean {
	if (!contentHash) return false;
	const bytes = Buffer.from(content, "utf8");
	const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
	return bytes.byteLength === byteLength && hash === contentHash;
}

function ensureConversation(
	conversations: Record<string, MetaWorkConversationProjection>,
	conversationId: string,
	selectedConversationId: string | null,
): Record<string, MetaWorkConversationProjection> {
	if (conversations[conversationId]) return conversations;
	const next = { ...conversations, [conversationId]: emptyConversationProjection(conversationId) };
	// 有界缓存：淘汰非选中 Conversation（插入序最旧者）。
	const keys = Object.keys(next);
	while (keys.length > METAWORK_CLIENT_LIMITS.conversationCache) {
		const victim = keys.find(key => key !== selectedConversationId && key !== conversationId);
		if (!victim) break;
		delete next[victim];
		keys.splice(keys.indexOf(victim), 1);
	}
	return next;
}

function updateConversation(
	state: MetaWorkClientState,
	conversationId: string,
	conversation: MetaWorkConversationProjection,
): MetaWorkClientState {
	const ready = Object.entries(conversation.pendingResults)
		.filter(([turnId]) => conversation.turns[turnId]);
	if (ready.length) {
		const turns = { ...conversation.turns };
		const pendingResults = { ...conversation.pendingResults };
		for (const [turnId, result] of ready) {
			if (!turns[turnId]!.result) turns[turnId] = mergePendingResult(turns[turnId]!, result);
			delete pendingResults[turnId];
		}
		conversation = { ...conversation, turns, pendingResults };
	}
	if (!state.conversations[conversationId]) {
		return {
			...state,
			conversations: ensureConversation(
				{ ...state.conversations, [conversationId]: conversation },
				conversationId,
				state.selectedConversationId,
			),
		};
	}
	return {
		...state,
		conversations: { ...state.conversations, [conversationId]: conversation },
	};
}

function mergePendingResult(
	turn: MetaWorkTurnProjection,
	result: MetaWorkResultProjection,
): MetaWorkTurnProjection {
	return {
		...turn,
		stage: TERMINAL_TURN_STATUSES.includes(turn.status) ? turn.stage : "delivery",
		answer: turn.answer || result.content,
		answerSources: result.content
			? [...new Set([...turn.answerSources, "result_stream" as const])]
			: turn.answerSources,
		result,
	};
}

function trimPendingResults(
	pending: Record<string, MetaWorkResultProjection>,
): Record<string, MetaWorkResultProjection> {
	const entries = Object.entries(pending);
	if (entries.length <= METAWORK_CLIENT_LIMITS.turnsPerConversation) return pending;
	return Object.fromEntries(entries.slice(-METAWORK_CLIENT_LIMITS.turnsPerConversation));
}

/** Transport evidence never establishes a Turn or its execution status. */
function storeResult(
	state: MetaWorkClientState,
	conversation: MetaWorkConversationProjection,
	turnId: string,
	result: MetaWorkResultProjection,
): MetaWorkClientState {
	const turn = conversation.turns[turnId];
	if (turn) return updateTurn(state, conversation, {
		...mergePendingResult(turn, result),
		answer: result.content || turn.answer,
	});
	return updateConversation(state, conversation.conversationId, {
		...conversation,
		pendingResults: trimPendingResults({ ...conversation.pendingResults, [turnId]: result }),
	});
}

function updateTurn(
	state: MetaWorkClientState,
	conversation: MetaWorkConversationProjection,
	turn: MetaWorkTurnProjection,
): MetaWorkClientState {
	const order = conversation.turnOrder.includes(turn.id)
		? conversation.turnOrder
		: [...conversation.turnOrder, turn.id];
	return updateConversation(state, conversation.conversationId, sortTurnOrder({
		...conversation,
		turns: { ...conversation.turns, [turn.id]: { ...turn, lastTaskSequence: conversation.cursor } },
		turnOrder: order,
	}));
}

/** Turn 有界缓存：淘汰最旧的非选中终态 Turn（可经历史分页重新加载）。 */
function sortTurnOrder(
	conversation: MetaWorkConversationProjection,
): MetaWorkConversationProjection {
	if (conversation.turnOrder.length <= METAWORK_CLIENT_LIMITS.turnsPerConversation) {
		return conversation;
	}
	const evictable = conversation.turnOrder.find(turnId => {
		const turn = conversation.turns[turnId];
		return turn && TERMINAL_TURN_STATUSES.includes(turn.status);
	});
	if (!evictable) return conversation;
	const turns = { ...conversation.turns };
	delete turns[evictable];
	return {
		...conversation,
		turns,
		turnOrder: conversation.turnOrder.filter(turnId => turnId !== evictable),
	};
}

function mergeArtifacts(
	existing: MetaWorkTurnProjection["artifacts"],
	incoming: MetaWorkTurnProjection["artifacts"],
): MetaWorkTurnProjection["artifacts"] {
	const merged = new Map(existing.map(artifact => [artifact.artifactId, artifact]));
	for (const artifact of incoming) merged.set(artifact.artifactId, artifact);
	return [...merged.values()];
}

function boundedAppend(values: readonly string[], value: string, limit: number): string[] {
	const next = [...values, value];
	return next.length > limit ? next.slice(next.length - limit) : next;
}

function addNotice(
	state: MetaWorkClientState,
	kind: "info" | "error" | "unknown_event",
	text: string,
): MetaWorkClientState {
	return {
		...state,
		notices: [...state.notices, { kind, text: sanitizeDisplayText(text) }]
			.slice(-METAWORK_CLIENT_LIMITS.notices),
	};
}

function basename(path: string): string {
	const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "");
	return normalized.slice(normalized.lastIndexOf("/") + 1) || "/";
}
