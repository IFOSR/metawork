import { createHash } from "node:crypto";
import type {
	GatewayEventEnvelope,
	GatewayReplay,
} from "../../anyfusion/gateway-protocol.ts";
import {
	emptyConversationViewModel,
	type ConversationViewModel,
	type MetaWorkResultView,
	type MetaWorkStage,
	type MetaWorkSystemCommandView,
	type MetaWorkTurnView,
} from "./metawork-client-model.ts";

export type { ConversationViewModel } from "./metawork-client-model.ts";

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
]);

export function rebuildFromReplay(replay: GatewayReplay): ConversationViewModel {
	return [...replay.snapshot, ...replay.deltas]
		.sort((left, right) => left.sequence - right.sequence)
		.reduce(reduceGatewayEvent, emptyConversationViewModel());
}

export function reduceGatewayEvent(
	state: ConversationViewModel,
	event: GatewayEventEnvelope,
): ConversationViewModel {
	if (state.seenEventIds.includes(event.eventId)) return state;
	const streamSequence = state.streamSequences[event.conversationId] ?? 0;
	if (event.sequence <= streamSequence) {
		return { ...state, connection: "resync_required" };
	}
	const next = {
		...state,
		lastSequence: Math.max(state.lastSequence, event.sequence),
		streamSequences: {
			...state.streamSequences,
			[event.conversationId]: event.sequence,
		},
		seenEventIds: [...state.seenEventIds, event.eventId],
	};
	if (!KNOWN_EVENT_KINDS.has(event.kind)) {
		return addNotice(next, "unknown_event", `Unknown Gateway event: ${event.kind}`);
	}
	const payload = record(event.payload);
	switch (event.kind) {
		case "conversation_snapshot":
			return reduceConversationSnapshot(next, event, payload);
		case "workspace_changed":
			return reduceAttachedWorkspace(next, payload);
		case "workspace_directory_snapshot":
			return reduceWorkspaceDirectory(next, payload);
		case "workspace_conversation_upserted":
			return reduceConversationUpsert(next, payload);
		case "workspace_conversation_removed":
			return reduceConversationRemoved(next, payload);
		case "workspace_activity_changed":
			return reduceConversationActivity(next, payload);
		case "workspace_availability_changed":
			return reduceWorkspaceAvailability(next, payload);
		case "turn_started":
			return reduceTurnStarted(next, event, payload);
		case "trace_delta":
			return reduceTrace(next, event, payload);
		case "execution_delta":
			return reduceExecution(next, event, payload);
		case "permission_request":
			return reducePermission(next, event, payload);
		case "result_delivery_available":
			return reduceResultAvailable(next, event, payload);
		case "result_chunk":
			return reduceResultChunk(next, event, payload);
		case "result_completed":
			return reduceResultCompleted(next, event, payload);
		case "final_answer":
			return reduceFinalAnswer(next, event, payload);
		case "terminal_error":
			return reduceTerminalError(next, event, payload);
		case "task_projection":
			return next;
		default:
			return next;
	}
}

function reduceTurnStarted(
	state: ConversationViewModel,
	event: GatewayEventEnvelope,
	payload: Record<string, unknown>,
): ConversationViewModel {
	if (payload.commandKind === "user_message") {
		return {
			...state,
			currentCommand: null,
			currentTurn: newTurn(event),
			composer: { blockedReason: null },
		};
	}
	return {
		...state,
		currentCommand: newCommand(event),
		currentTurn: null,
		composer: { blockedReason: null },
	};
}

function reduceConversationSnapshot(
	state: ConversationViewModel,
	event: GatewayEventEnvelope,
	payload: Record<string, unknown>,
): ConversationViewModel {
	const workspace = record(payload.workspace);
	return {
		...state,
		activeConversationId: event.conversationId,
		...(typeof workspace.path === "string"
			? {
				activeWorkspace: {
					id: string(workspace.id, state.activeWorkspace?.id ?? ""),
					displayName: string(
						workspace.displayName,
						basename(workspace.path),
					),
					path: workspace.path,
					availability: workspace.availability === "unavailable"
						? "unavailable" as const
						: "available" as const,
				},
			}
			: {}),
	};
}

function reduceAttachedWorkspace(
	state: ConversationViewModel,
	payload: Record<string, unknown>,
): ConversationViewModel {
	const workspace = record(payload.workspace);
	if (typeof workspace.path !== "string") return state;
	return {
		...state,
		activeWorkspace: {
			id: string(workspace.id, state.activeWorkspace?.id ?? ""),
			displayName: string(workspace.displayName, basename(workspace.path)),
			path: workspace.path,
			availability: workspace.availability === "unavailable" ? "unavailable" : "available",
		},
		composer: { blockedReason: null },
	};
}

function reduceWorkspaceDirectory(
	state: ConversationViewModel,
	payload: Record<string, unknown>,
): ConversationViewModel {
	const workspace = workspaceView(payload.workspace, string(payload.workspaceId));
	const page = record(payload.page);
	const items = Array.isArray(page.items)
		? page.items.map(conversationSummary).filter((item): item is NonNullable<typeof item> => item !== null)
		: [];
	return {
		...state,
		activeWorkspace: workspace ?? state.activeWorkspace,
		conversationSummaries: items,
		conversationDirectoryCursor: typeof page.nextCursor === "string" ? page.nextCursor : null,
	};
}

function reduceConversationUpsert(
	state: ConversationViewModel,
	payload: Record<string, unknown>,
): ConversationViewModel {
	const summary = conversationSummary(payload.conversation);
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
	state: ConversationViewModel,
	payload: Record<string, unknown>,
): ConversationViewModel {
	const conversationId = string(payload.conversationId);
	return conversationId
		? {
				...state,
				conversationSummaries: state.conversationSummaries
					.filter(item => item.conversationId !== conversationId),
			}
		: state;
}

function reduceConversationActivity(
	state: ConversationViewModel,
	payload: Record<string, unknown>,
): ConversationViewModel {
	const conversationId = string(payload.conversationId);
	const activity = activityView(payload.activity);
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
	state: ConversationViewModel,
	payload: Record<string, unknown>,
): ConversationViewModel {
	if (!state.activeWorkspace || string(payload.workspaceId) !== state.activeWorkspace.id) {
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

function reduceTrace(
	state: ConversationViewModel,
	event: GatewayEventEnvelope,
	payload: Record<string, unknown>,
): ConversationViewModel {
	const command = commandForEvent(state.currentCommand, event);
	if (command) {
		let execution = command.execution;
		for (const raw of Array.isArray(payload.events) ? payload.events : []) {
			const item = record(raw);
			const eventKey = typeof item.eventKey === "string" ? item.eventKey : null;
			if (eventKey && state.seenEventKeys.includes(eventKey)) continue;
			const stage = stageForPhase(string(item.phase));
			const title = string(item.title, string(item.message, "Progress"));
			const summary = string(item.summary);
			const turn = ensureTurn(execution, event);
			execution = appendTraceToTurn(
				turn,
				item,
				eventKey,
				stage,
				title,
				summary,
			);
			state = {
				...state,
				seenEventKeys: eventKey
					? [...state.seenEventKeys, eventKey]
					: state.seenEventKeys,
			};
		}
		return {
			...state,
			currentCommand: { ...command, execution },
		};
	}
	if (hasDifferentTurn(state.currentTurn, event)) return state;
	let next = state;
	for (const raw of Array.isArray(payload.events) ? payload.events : []) {
		const item = record(raw);
		const eventKey = typeof item.eventKey === "string" ? item.eventKey : null;
		if (eventKey && next.seenEventKeys.includes(eventKey)) continue;
		const stage = stageForPhase(string(item.phase));
		const title = string(item.title, string(item.message, "Progress"));
		const summary = string(item.summary);
		const turn = ensureTurn(next.currentTurn, event);
		next = {
			...next,
			seenEventKeys: eventKey ? [...next.seenEventKeys, eventKey] : next.seenEventKeys,
			currentTurn: appendTraceToTurn(turn, item, eventKey, stage, title, summary),
		};
	}
	return next;
}

function reduceExecution(
	state: ConversationViewModel,
	event: GatewayEventEnvelope,
	payload: Record<string, unknown>,
): ConversationViewModel {
	const subtaskId = string(payload.subtaskId);
	if (!subtaskId) return state;
	const command = commandForEvent(state.currentCommand, event);
	if (command) {
		const turn = ensureTurn(command.execution, event);
		return {
			...state,
			currentCommand: {
				...command,
				execution: {
					...turn,
					stage: "execution",
					subtasks: {
						...turn.subtasks,
						[subtaskId]: {
							id: subtaskId,
							title: string(payload.title, turn.subtasks[subtaskId]?.title ?? "Subtask"),
							status: string(payload.status, turn.subtasks[subtaskId]?.status ?? "running"),
							progress: string(payload.progress, turn.subtasks[subtaskId]?.progress ?? ""),
							heartbeat: payload.heartbeat === true,
						},
					},
				},
			},
		};
	}
	if (hasDifferentTurn(state.currentTurn, event)) return state;
	const turn = ensureTurn(state.currentTurn, event);
	return {
		...state,
		currentTurn: {
			...turn,
			stage: "execution",
			subtasks: {
				...turn.subtasks,
				[subtaskId]: {
					id: subtaskId,
					title: string(payload.title, turn.subtasks[subtaskId]?.title ?? "Subtask"),
					status: string(payload.status, turn.subtasks[subtaskId]?.status ?? "running"),
					progress: string(payload.progress, turn.subtasks[subtaskId]?.progress ?? ""),
					heartbeat: payload.heartbeat === true,
				},
			},
		},
	};
}

function reducePermission(
	state: ConversationViewModel,
	event: GatewayEventEnvelope,
	payload: Record<string, unknown>,
): ConversationViewModel {
	if (matchesCommand(state.currentCommand, event)) return state;
	if (hasDifferentTurn(state.currentTurn, event)) return state;
	const turn = ensureTurn(state.currentTurn, event);
	return {
		...state,
		currentTurn: {
			...turn,
			stage: "authorization",
			permission: {
				requestId: string(payload.requestId),
				summary: string(payload.summary, "需要用户授权"),
				status: "pending",
			},
		},
	};
}

function reduceResultAvailable(
	state: ConversationViewModel,
	event: GatewayEventEnvelope,
	payload: Record<string, unknown>,
): ConversationViewModel {
	const resultId = string(payload.resultId);
	if (!resultId) return state;
	const command = commandForEvent(state.currentCommand, event);
	if (command) {
		return {
			...state,
			currentCommand: {
				...command,
				resultId,
				contentHash: string(payload.contentHash),
				byteLength: number(payload.byteLength),
				output: "",
			},
		};
	}
	if (hasDifferentTurn(state.currentTurn, event)) return state;
	const turn = ensureTurn(state.currentTurn, event);
	return {
		...state,
		currentTurn: {
			...turn,
			stage: "delivery",
			result: {
				resultId,
				content: "",
				contentHash: string(payload.contentHash),
				byteLength: number(payload.byteLength),
				certification: certification(payload.certification),
				verification: "streaming",
			},
		},
	};
}

function reduceResultChunk(
	state: ConversationViewModel,
	event: GatewayEventEnvelope,
	payload: Record<string, unknown>,
): ConversationViewModel {
	const command = commandForEvent(state.currentCommand, event);
	if (command && command.resultId === payload.resultId) {
		const output = appendChunk(command.output, payload);
		return {
			...state,
			currentCommand: { ...command, output },
		};
	}
	if (hasDifferentTurn(state.currentTurn, event)) return state;
	const turn = ensureTurn(state.currentTurn, event);
	const result = turn.result;
	if (!result || result.resultId !== payload.resultId) return state;
	const content = appendChunk(result.content, payload);
	return {
		...state,
		currentTurn: {
			...turn,
			answer: content,
			answerSources: ["result_stream"],
			result: { ...result, content },
		},
	};
}

function reduceResultCompleted(
	state: ConversationViewModel,
	event: GatewayEventEnvelope,
	payload: Record<string, unknown>,
): ConversationViewModel {
	const command = commandForEvent(state.currentCommand, event);
	if (command && command.resultId === payload.resultId) {
		const verified = verifyResult(command.output, payload);
		return {
			...state,
			currentCommand: {
				...command,
				status: verified ? "completed" : "failed",
				contentHash: string(payload.contentHash, command.contentHash),
				byteLength: number(payload.byteLength, command.byteLength),
				error: verified ? null : "命令结果校验失败",
			},
		};
	}
	if (hasDifferentTurn(state.currentTurn, event)) return state;
	const turn = ensureTurn(state.currentTurn, event);
	const result = turn.result;
	if (!result || result.resultId !== payload.resultId) return state;
	const completed: MetaWorkResultView = {
		...result,
		contentHash: string(payload.contentHash, result.contentHash),
		byteLength: number(payload.byteLength, result.byteLength),
		certification: certification(payload.certification),
		verification: verifyResult(result.content, payload)
			? certification(payload.certification)
			: "failed",
	};
	return {
		...state,
		currentTurn: {
			...turn,
			status: completed.verification === "failed" ? "failed" : "completed",
			stage: "delivery",
			answer: completed.content,
			answerSources: ["result_stream"],
			result: completed,
		},
	};
}

function reduceFinalAnswer(
	state: ConversationViewModel,
	event: GatewayEventEnvelope,
	payload: Record<string, unknown>,
): ConversationViewModel {
	const command = commandForEvent(state.currentCommand, event);
	if (command) {
		const lines = answerLines(payload);
		return {
			...state,
			currentCommand: {
				...command,
				status: "completed",
				output: command.output || lines.join("\n"),
				error: null,
			},
		};
	}
	if (hasDifferentTurn(state.currentTurn, event)) return state;
	const turn = ensureTurn(state.currentTurn, event);
	const resultId = string(payload.resultId);
	if (turn.result && resultId === turn.result.resultId) {
		return {
			...state,
			currentTurn: { ...turn, status: "completed", stage: "delivery" },
		};
	}
	const lines = answerLines(payload);
	return {
		...state,
		currentTurn: {
			...turn,
			status: "completed",
			stage: "delivery",
			answer: lines.join("\n"),
			answerSources: ["final_answer"],
		},
	};
}

function reduceTerminalError(
	state: ConversationViewModel,
	event: GatewayEventEnvelope,
	payload: Record<string, unknown>,
): ConversationViewModel {
	const code = string(payload.code);
	const message = string(payload.message, "Gateway execution failed");
	const command = commandForEvent(state.currentCommand, event);
	if (command) {
		return {
			...state,
			currentCommand: {
				...command,
				status: "failed",
				error: message,
			},
		};
	}
	if (hasDifferentTurn(state.currentTurn, event)) return state;
	const turn = ensureTurn(state.currentTurn, event);
	let next: ConversationViewModel = {
		...state,
		currentTurn: {
			...turn,
			status: code === "cancelled" ? "cancelled" : "failed",
			error: message,
		},
	};
	if (code === "workspace_required") {
		next = {
			...next,
			composer: { blockedReason: "workspace_required" },
		};
		next = addNotice(next, "error", `${message} 使用 /workspace /absolute/path`);
	}
	return next;
}

function ensureTurn(
	turn: MetaWorkTurnView | null,
	event: GatewayEventEnvelope,
): MetaWorkTurnView {
	return turn ?? newTurn(event);
}

function newTurn(event: GatewayEventEnvelope): MetaWorkTurnView {
	return {
		interactionKind: "ai_turn",
		id: event.turnId ?? `turn_at_${event.sequence}`,
		requestId: event.requestId,
		status: "running",
		stage: "understanding",
		trace: [],
		authorization: [],
		subtasks: {},
		permission: null,
		result: null,
		answer: "",
		answerSources: [],
		error: null,
	};
}

function newCommand(event: GatewayEventEnvelope): MetaWorkSystemCommandView {
	return {
		interactionKind: "system_command",
		id: event.turnId ?? `turn_at_${event.sequence}`,
		requestId: event.requestId,
		status: "running",
		resultId: null,
		contentHash: "",
		byteLength: 0,
		output: "",
		error: null,
		execution: null,
	};
}

function matchesCommand(
	command: MetaWorkSystemCommandView | null,
	event: GatewayEventEnvelope,
): boolean {
	return commandForEvent(command, event) !== null;
}

function commandForEvent(
	command: MetaWorkSystemCommandView | null,
	event: GatewayEventEnvelope,
): MetaWorkSystemCommandView | null {
	return command?.id === event.turnId ? command : null;
}

function hasDifferentTurn(
	turn: MetaWorkTurnView | null,
	event: GatewayEventEnvelope,
): boolean {
	return turn !== null && turn.id !== event.turnId;
}

function appendTraceToTurn(
	turn: MetaWorkTurnView,
	item: Record<string, unknown>,
	eventKey: string | null,
	stage: MetaWorkStage,
	title: string,
	summary: string,
): MetaWorkTurnView {
	const authorization = stage === "authorization" && title
		? unique([...turn.authorization, title])
		: turn.authorization;
	const permission = (
		turn.permission
		&& stage === "authorization"
		&& /批准|拒绝|resolved|approved|denied/iu.test(title)
	) ? { ...turn.permission, status: "resolved" as const } : turn.permission;
	return {
		...turn,
		stage,
		authorization,
		permission,
		trace: [...turn.trace, {
			eventKey,
			stage,
			actor: string(item.actor, "runtime"),
			title,
			summary,
		}].slice(-80),
	};
}

function answerLines(payload: Record<string, unknown>): string[] {
	return Array.isArray(payload.lines)
		? payload.lines.filter((line): line is string => typeof line === "string")
		: [];
}

function appendChunk(content: string, payload: Record<string, unknown>): string {
	const offset = number(payload.offset);
	const chunk = string(payload.chunk);
	const bytes = Buffer.from(content, "utf8");
	return offset > bytes.byteLength
		? content
		: bytes.subarray(0, offset).toString("utf8") + chunk;
}

function stageForPhase(phase: string): MetaWorkStage {
	switch (phase) {
		case "planning":
		case "understanding":
			return "understanding";
		case "plan":
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

function verifyResult(content: string, payload: Record<string, unknown>): boolean {
	const bytes = Buffer.from(content, "utf8");
	const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
	return bytes.byteLength === number(payload.byteLength) && hash === string(payload.contentHash);
}

function certification(value: unknown): "certified" | "uncertified" {
	return value === "uncertified" ? "uncertified" : "certified";
}

function addNotice(
	state: ConversationViewModel,
	kind: "info" | "error" | "unknown_event",
	text: string,
): ConversationViewModel {
	return {
		...state,
		notices: [...state.notices, { kind, text }].slice(-20),
	};
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function string(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function number(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function workspaceView(value: unknown, fallbackId: string) {
	const workspace = record(value);
	const id = string(workspace.id, fallbackId);
	const path = string(workspace.canonicalPath, string(workspace.path));
	if (!id || !path) return null;
	return {
		id,
		displayName: string(workspace.displayName, basename(path)),
		path,
		availability: workspace.availability === "unavailable"
			? "unavailable" as const
			: "available" as const,
	};
}

function conversationSummary(value: unknown) {
	const item = record(value);
	const conversationId = string(item.conversationId, string(item.id));
	const workspaceId = string(item.workspaceId);
	if (!conversationId || !workspaceId) return null;
	return {
		conversationId,
		workspaceId,
		title: string(item.title, "New conversation"),
		preview: string(item.preview),
		updatedAt: string(item.updatedAt),
		activity: activityView(item.activity) ?? {
			state: "idle" as const,
			taskId: null,
			updatedAt: string(item.updatedAt),
		},
	};
}

function activityView(value: unknown) {
	const activity = record(value);
	const state = string(activity.state);
	if (!["idle", "planning", "executing", "waiting", "blocked"].includes(state)) {
		return null;
	}
	return {
		state: state as "idle" | "planning" | "executing" | "waiting" | "blocked",
		taskId: typeof activity.taskId === "string" ? activity.taskId : null,
		updatedAt: string(activity.updatedAt),
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
		planning: 2,
		idle: 1,
	};
	return [...items].sort((left, right) => (
		(priority[right.activity.state] ?? 0) - (priority[left.activity.state] ?? 0)
		|| right.updatedAt.localeCompare(left.updatedAt)
		|| left.conversationId.localeCompare(right.conversationId)
	));
}

function basename(path: string): string {
	const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "");
	return normalized.slice(normalized.lastIndexOf("/") + 1) || "/";
}
