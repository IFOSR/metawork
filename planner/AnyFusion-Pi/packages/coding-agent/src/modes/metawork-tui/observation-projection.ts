import type { GatewayObservedConversation } from "../../anyfusion/gateway-observation-client.ts";
import { emptyConversationProjection, type MetaWorkClientState, type MetaWorkTurnProjection } from "./model.ts";

/** Shared read DTOs map directly to the sole TUI presentation model. */
export function applyObservedConversation(
	state: MetaWorkClientState,
	view: GatewayObservedConversation,
): MetaWorkClientState {
	const previous = state.conversations[view.conversationId] ?? emptyConversationProjection(view.conversationId);
	const turns: Record<string, MetaWorkTurnProjection> = {};
	for (const turn of view.turns) {
		const old = previous.turns[turn.id];
		const task = view.activity.tasks.find((task) => task.taskId === turn.taskId);
		const pending = view.activity.pendingInteractions.find((request) => request.taskId === turn.taskId);
		turns[turn.id] = {
			...old,
			id: turn.id,
			requestId: turn.requestId,
			interactionKind: turn.interactionKind,
			userInput: turn.userInput,
			status: turn.status,
			stage: turn.deliveryStatus === "streaming" ? "delivery" : "execution",
			taskId: turn.taskId,
			progressSummary: task?.progressSummary ?? task?.explanation ?? null,
			taskTitle: task?.title ?? old?.taskTitle,
			taskPhase: task?.phase ?? old?.taskPhase,
			taskStartedAt: turn.startedAt,
			taskCompletedAt: turn.completedAt,
			lastEventAt: turn.completedAt ?? turn.startedAt,
			trace: old?.trace ?? [],
			subtasks: old?.subtasks ?? {},
			result: old?.result ?? null,
			permission: pending
				? {
						requestId: pending.requestId,
						status: "pending",
						summary: `${pending.operation}\n${pending.resource}\n${pending.reason}\n范围：${pending.scope}`,
						requestRevision: pending.requestRevision,
						generationId: pending.generationId,
						detailsRef: pending.detailsRef,
					}
				: null,
			artifacts: old?.artifacts ?? [],
			answer: turn.answer,
			answerRef: turn.answerRef,
			userInputRef: turn.userInputRef,
			answerSources: ["final_answer"],
			error: null,
			startedAtSequence: turn.firstSequence,
			lastTaskSequence: turn.lastSequence,
			startedAt: turn.startedAt,
		};
	}
	const ids = view.turns.map((turn) => turn.id);
	const conversations = {
		...state.conversations,
		[view.conversationId]: {
			...previous,
			turns,
			turnOrder: ids,
			historyTurnIds: ids,
			historyCursor: view.nextCursor,
			historyExhausted: view.nextCursor === null,
		},
	};
	while (Object.keys(conversations).length > 8) {
		const id = Object.keys(conversations).find(
			(id) => id !== view.conversationId && id !== state.selectedConversationId,
		);
		if (!id) break;
		delete conversations[id];
	}
	return { ...state, conversations };
}
