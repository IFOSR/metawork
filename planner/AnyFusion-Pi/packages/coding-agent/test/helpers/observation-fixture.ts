import { createHash } from "node:crypto";
import type {
	ConversationObservationFrame,
	ConversationReadBaseline,
	ConversationTurnView,
} from "../../src/anyfusion/conversation-observation-protocol.ts";
import type { GatewayObservedConversation } from "../../src/anyfusion/gateway-observation-client.ts";
import type { GatewayEventEnvelope } from "../../src/anyfusion/gateway-protocol.ts";

export function turn(conversationId: string, id = "turn", sequence = 1): ConversationTurnView {
	return {
		conversationId,
		id,
		requestId: `request_${id}`,
		revision: sequence,
		firstSequence: sequence,
		lastSequence: sequence,
		userInput: id,
		userInputRef: null,
		answer: "answer",
		answerRef: null,
		resultId: null,
		certification: null,
		completeness: null,
		resultOffset: 0,
		resultPreviewOmitted: false,
		status: "running",
		deliveryStatus: "none",
		taskId: null,
		startedAt: "2026-10-03T00:00:00Z",
		completedAt: null,
		interactionKind: "ai_turn",
	};
}

/** Test scenario builder. Business scenarios reach the controller as read DTOs;
 * connection replies still reach its ordinary event listener. No production reducer is used. */
export class ObservationFixture {
	private readonly views = new Map<string, GatewayObservedConversation>();
	private readonly listeners = new Map<string, (view: GatewayObservedConversation) => void>();
	view(id: string): GatewayObservedConversation {
		return (
			this.views.get(id) ?? {
				conversationId: id,
				atLatest: true,
				preparing: false,
				turns: [],
				nextCursor: null,
				cursor: { epoch: "fixture", revision: 1 },
				activity: { tasks: [], pendingInteractions: [], nextCursor: null, pendingNextCursor: null },
				error: null,
			}
		);
	}
	set(id: string, patch: Partial<GatewayObservedConversation>): void {
		const value = { ...this.view(id), ...patch };
		this.views.set(id, value);
		this.listeners.get(id)?.(value);
	}
	follow(id: string, listener: (view: GatewayObservedConversation) => void): () => void {
		this.listeners.set(id, listener);
		listener(this.view(id));
		return () => {
			if (this.listeners.get(id) === listener) this.listeners.delete(id);
		};
	}
	scenario(event: GatewayEventEnvelope): boolean {
		if (!["turn_started", "trace_delta", "execution_delta", "final_answer", "terminal_error"].includes(event.kind))
			return false;
		if (!event.turnId) return true;
		const view = this.view(event.conversationId);
		const old = view.turns.find((item) => item.id === event.turnId) ?? {
			...turn(event.conversationId, event.turnId, event.sequence),
			answer: "",
		};
		const payload = event.payload as { taskId?: string; lines?: string[]; code?: string };
		const value: ConversationTurnView = {
			...old,
			revision: event.sequence,
			lastSequence: event.sequence,
			...(payload.taskId ? { taskId: payload.taskId } : {}),
			...(event.kind === "final_answer"
				? { status: "completed", answer: payload.lines?.join("\n") ?? "", deliveryStatus: "ready" }
				: {}),
			...(event.kind === "terminal_error" ? { status: payload.code === "cancelled" ? "cancelled" : "failed" } : {}),
		};
		this.set(event.conversationId, {
			turns: [...view.turns.filter((item) => item.id !== value.id), value].sort(
				(a, b) => a.firstSequence - b.firstSequence,
			),
		});
		return true;
	}
}
export function baselineFrame(
	conversationId: string,
	observationId: string,
	value?: ConversationReadBaseline,
): ConversationObservationFrame {
	const body = Buffer.from(
		JSON.stringify(
			value ?? {
				head: { epoch: "epoch", revision: 1, journalSequence: 1 },
				turns: [turn(conversationId)],
				nextCursor: "older",
			},
		),
	);
	return {
		kind: "baseline",
		conversationId,
		observationId,
		transferId: "transfer",
		index: 0,
		count: 1,
		byteLength: body.length,
		hash: createHash("sha256").update(body).digest("hex"),
		data: body.toString("base64"),
	};
}
