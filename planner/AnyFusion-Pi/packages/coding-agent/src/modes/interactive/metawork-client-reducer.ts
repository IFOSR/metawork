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
	type MetaWorkTurnView,
} from "./metawork-client-model.ts";

export type { ConversationViewModel } from "./metawork-client-model.ts";

const KNOWN_EVENT_KINDS = new Set([
	"conversation_snapshot",
	"workspace_changed",
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
	if (event.sequence <= state.lastSequence) {
		return { ...state, connection: "resync_required" };
	}
	const next = {
		...state,
		lastSequence: event.sequence,
		seenEventIds: [...state.seenEventIds, event.eventId],
	};
	if (!KNOWN_EVENT_KINDS.has(event.kind)) {
		return addNotice(next, "unknown_event", `Unknown Gateway event: ${event.kind}`);
	}
	const payload = record(event.payload);
	switch (event.kind) {
		case "conversation_snapshot":
			return reduceWorkspace(next, payload, false);
		case "workspace_changed":
			return reduceWorkspace(next, payload, true);
		case "turn_started":
			return {
				...next,
				currentTurn: newTurn(event),
				composer: { blockedReason: null },
			};
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

function reduceWorkspace(
	state: ConversationViewModel,
	payload: Record<string, unknown>,
	clearBlock: boolean,
): ConversationViewModel {
	const workspace = record(payload.workspace);
	if (typeof workspace.path !== "string") return state;
	return {
		...state,
		workspace: {
			path: workspace.path,
			selectedAt: string(workspace.selectedAt),
		},
		...(clearBlock ? { composer: { blockedReason: null } } : {}),
	};
}

function reduceTrace(
	state: ConversationViewModel,
	event: GatewayEventEnvelope,
	payload: Record<string, unknown>,
): ConversationViewModel {
	let next = state;
	for (const raw of Array.isArray(payload.events) ? payload.events : []) {
		const item = record(raw);
		const eventKey = typeof item.eventKey === "string" ? item.eventKey : null;
		if (eventKey && next.seenEventKeys.includes(eventKey)) continue;
		const stage = stageForPhase(string(item.phase));
		const title = string(item.title, string(item.message, "Progress"));
		const summary = string(item.summary);
		const turn = ensureTurn(next.currentTurn, event);
		const authorization = stage === "authorization" && title
			? unique([...turn.authorization, title])
			: turn.authorization;
		const permission = (
			turn.permission
			&& stage === "authorization"
			&& /批准|拒绝|resolved|approved|denied/iu.test(title)
		) ? { ...turn.permission, status: "resolved" as const } : turn.permission;
		next = {
			...next,
			seenEventKeys: eventKey ? [...next.seenEventKeys, eventKey] : next.seenEventKeys,
			currentTurn: {
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
			},
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
	const turn = ensureTurn(state.currentTurn, event);
	const result = turn.result;
	if (!result || result.resultId !== payload.resultId) return state;
	const offset = number(payload.offset);
	const chunk = string(payload.chunk);
	const bytes = Buffer.from(result.content, "utf8");
	const content = offset > bytes.byteLength
		? result.content
		: bytes.subarray(0, offset).toString("utf8") + chunk;
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
	const turn = ensureTurn(state.currentTurn, event);
	const resultId = string(payload.resultId);
	if (turn.result && resultId === turn.result.resultId) {
		return {
			...state,
			currentTurn: { ...turn, status: "completed", stage: "delivery" },
		};
	}
	const lines = Array.isArray(payload.lines)
		? payload.lines.filter((line): line is string => typeof line === "string")
		: [];
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
