/**
 * MetaWork 唯一 TUI reducer 的不变量测试（统一 TUI 设计 §15.2）。
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
	GatewayEventEnvelope,
	GatewayReplay,
} from "../src/anyfusion/gateway-protocol.ts";
import {
	emptyMetaWorkClientState,
	type MetaWorkClientState,
} from "../src/modes/metawork-tui/model.ts";
import {
	applyGatewayReplay,
	markPendingSubmissionsUncertain,
	queueSubmission,
	reduceGatewayEvent,
	reduceReceipt,
	requestCompletion,
	selectConversation,
	selectTurn,
	setDraft,
} from "../src/modes/metawork-tui/reducer.ts";
import { sanitizeDisplayText } from "../src/modes/metawork-tui/protocol-adapter.ts";

let eventCounter = 0;

function event(
	conversationId: string,
	sequence: number,
	kind: string,
	payload: unknown,
	extras: Partial<GatewayEventEnvelope> = {},
): GatewayEventEnvelope {
	eventCounter += 1;
	return {
		protocolVersion: 2,
		eventId: `evt_${eventCounter}`,
		sequence,
		accountId: "local-default",
		conversationId,
		requestId: extras.requestId ?? null,
		turnId: extras.turnId ?? null,
		kind: kind as GatewayEventEnvelope["kind"],
		payload,
		occurredAt: "2026-09-19T00:00:00.000Z",
	};
}

function resultPayload(content: string) {
	const bytes = Buffer.from(content, "utf8");
	return {
		resultId: "result_1",
		contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
		byteLength: bytes.byteLength,
	};
}

describe("metawork-tui reducer", () => {
	it("appends a matching directory page without accepting a stale page or changing selection", () => {
		const row = (id: string) => ({ conversationId: id, workspaceId: "ws_1", title: id, preview: "", updatedAt: "now" });
		let state = reduceGatewayEvent(emptyMetaWorkClientState(), event("directory", 1, "workspace_directory_snapshot", {
			workspaceId: "ws_1", workspace: { id: "ws_1", path: "/repo" }, query: "", requestedCursor: null,
			page: { items: [row("one")], nextCursor: "page_two" },
		}));
		state = selectConversation(state, "one");
		state = reduceGatewayEvent(state, event("directory", 2, "workspace_directory_snapshot", {
			workspaceId: "ws_1", query: "", requestedCursor: "page_two",
			page: { items: [row("two")], nextCursor: null },
		}));
		expect(state.conversationSummaries.map(item => item.conversationId).sort()).toEqual(["one", "two"]);
		expect(state.selectedConversationId).toBe("one");
		state = reduceGatewayEvent(state, event("directory", 3, "workspace_directory_snapshot", {
			workspaceId: "ws_1", query: "", requestedCursor: "page_two",
			page: { items: [row("stale")], nextCursor: "wrong" },
		}));
		expect(state.conversationSummaries.map(item => item.conversationId)).not.toContain("stale");
		expect(state.conversationDirectoryCursor).toBeNull();
	});

	it("assembles fragmented Unicode history atomically and preserves the older cursor", () => {
		const answer = "完整报告结论".repeat(12_000);
		const body = Buffer.from(JSON.stringify({
			turns: [{ id: "long_turn", status: "completed", userInput: "question", finalAnswer: answer }],
			nextCursor: "older", previousCursor: null,
		}));
		const data = body.toString("base64");
		const size = 48 * 1024;
		const count = Math.ceil(data.length / size);
		let state = emptyMetaWorkClientState();
		for (let index = 0; index < count; index += 1) {
			state = reduceGatewayEvent(state, event("conv_1", index + 1, "conversation_history_page", {
				transfer: { id: "page_one", index, count, byteLength: body.length,
					hash: createHash("sha256").update(body).digest("hex"), data: data.slice(index * size, (index + 1) * size) },
			}));
			if (index < count - 1) {
				expect(state.conversations.conv_1?.turns.long_turn).toBeUndefined();
				expect(state.conversations.conv_1?.historyExhausted).toBe(false);
			}
		}
		expect(state.conversations.conv_1?.turns.long_turn?.answer).toBe(answer);
		expect(state.conversations.conv_1?.historyCursor).toBe("older");
	});

	it("rejects damaged history transfer without advancing the history cursor", () => {
		const body = Buffer.from(JSON.stringify({ turns: [], nextCursor: null }));
		const state = reduceGatewayEvent(emptyMetaWorkClientState(), event("conv_1", 1, "conversation_history_page", {
			transfer: { id: "damaged", index: 0, count: 1, byteLength: body.length,
				hash: "0".repeat(64), data: body.toString("base64") },
		}));
		expect(state.conversations.conv_1?.historyExhausted).toBe(false);
		expect(state.notices.some(notice => notice.kind === "error")).toBe(true);
	});

	it("keeps completed historical results even when their user input is missing", () => {
		const state = reduceGatewayEvent(emptyMetaWorkClientState(), event("conv_1", 1,
			"conversation_history_page", {
				turns: [
					{ id: "empty_history", status: "completed", userInput: "", finalAnswer: "old result" },
					{ id: "real_history", status: "completed", userInput: "real request", finalAnswer: "answer" },
				],
				nextCursor: null,
			}));
		expect(state.conversations.conv_1?.turns.empty_history).toMatchObject({
			userInput: "",
			status: "completed",
			answer: "old result",
		});
		expect(state.conversations.conv_1?.turns.real_history?.userInput).toBe("real request");
		expect(state.conversations.conv_1?.historyTurnIds).toContain("empty_history");
	});

	it("applies an authoritative terminal history status even without input or answer", () => {
		let state = reduceGatewayEvent(emptyMetaWorkClientState(), event("conv_1", 1,
			"turn_started", { commandKind: "user_message" }, { turnId: "turn_1" }));
		state = reduceGatewayEvent(state, event("conv_1", 2, "conversation_history_page", {
			turns: [{ id: "turn_1", status: "cancelled", userInput: "", finalAnswer: null }],
			nextCursor: null,
		}));
		expect(state.conversations.conv_1?.turns.turn_1?.status).toBe("cancelled");
	});

	it("does not create a visible Turn from an orphan trace without intake or history", () => {
		const state = reduceGatewayEvent(emptyMetaWorkClientState(), event("conv_1", 1, "trace_delta", {
			turnId: "orphan_trace", taskId: "task_orphan", status: "running",
			events: [{ phase: "execution", actor: "executor", title: "Progress", summary: "Running" }],
		}, { turnId: "orphan_trace" }));
		expect(state.conversations.conv_1?.turns.orphan_trace).toBeUndefined();
		expect(state.conversations.conv_1?.turnOrder).toEqual([]);
	});

	it("buffers orphan result metadata without showing it as a running Turn", () => {
		const metadata = resultPayload("retained result");
		let state = emptyMetaWorkClientState();
		state = reduceGatewayEvent(state, event("conv_1", 1, "result_delivery_available", metadata, {
			turnId: "orphan_result",
		}));
		state = reduceGatewayEvent(state, event("conv_1", 2, "result_completed", metadata, {
			turnId: "orphan_result",
		}));
		expect(state.conversations.conv_1?.turns.orphan_result).toBeUndefined();
		expect(state.conversations.conv_1?.turnOrder).toEqual([]);
		expect(state.conversations.conv_1?.pendingResults.orphan_result).toBeDefined();
	});

	it("replays a retained result into a completed Turn when its terminal event arrives", () => {
		const content = "retained result";
		const metadata = resultPayload(content);
		let state = emptyMetaWorkClientState();
		state = reduceGatewayEvent(state, event("conv_1", 1, "result_delivery_available", metadata, { turnId: "retained" }));
		state = reduceGatewayEvent(state, event("conv_1", 2, "result_chunk", {
			resultId: metadata.resultId, offset: 0, chunk: content,
		}, { turnId: "retained" }));
		state = reduceGatewayEvent(state, event("conv_1", 3, "result_completed", metadata, { turnId: "retained" }));
		state = reduceGatewayEvent(state, event("conv_1", 4, "final_answer", {
			lines: [], resultId: metadata.resultId,
		}, { turnId: "retained" }));
		expect(state.conversations.conv_1?.turns.retained).toMatchObject({
			status: "completed",
			userInput: "",
			answer: content,
			result: { verification: "certified" },
		});
		expect(state.conversations.conv_1?.pendingResults.retained).toBeUndefined();
	});

	it.each(["turn_started", "conversation_history_page"])("hydrates buffered content on %s without inferring completion", kind => {
		const content = "buffered answer";
		const metadata = resultPayload(content);
		let state = emptyMetaWorkClientState();
		state = reduceGatewayEvent(state, event("conv_1", 1, "result_delivery_available", metadata, { turnId: "retained" }));
		state = reduceGatewayEvent(state, event("conv_1", 2, "result_chunk", {
			resultId: metadata.resultId, offset: 0, chunk: content,
		}, { turnId: "retained" }));
		state = reduceGatewayEvent(state, event("conv_1", 3, "result_completed", metadata, { turnId: "retained" }));
		expect(state.conversations.conv_1?.turnOrder).toEqual([]);
		state = reduceGatewayEvent(state, event("conv_1", 4, kind, kind === "turn_started"
			? { commandKind: "user_message" }
			: { turns: [{ id: "retained", userInput: "real request", status: "running" }], nextCursor: null },
		{ turnId: "retained" }));
		expect(state.conversations.conv_1?.turns.retained).toMatchObject({
			status: "running", answer: content, result: { verification: "certified" },
		});
		expect(state.conversations.conv_1?.pendingResults.retained).toBeUndefined();
	});

	it("does not drop a final answer that has no result stream", () => {
		const state = reduceGatewayEvent(emptyMetaWorkClientState(), event("conv_1", 1,
			"final_answer", { lines: ["saved final answer"] }, { turnId: "retained" }));
		expect(state.conversations.conv_1?.turns.retained).toMatchObject({
			status: "completed", answer: "saved final answer",
		});
	});

	it("keeps a buffered queued acknowledgement running until its actual final answer", () => {
		const content = "waiting for execution";
		const metadata = resultPayload(content);
		let state = reduceGatewayEvent(emptyMetaWorkClientState(), event("conv_1", 1,
			"result_delivery_available", metadata, { turnId: "queued" }));
		state = reduceGatewayEvent(state, event("conv_1", 2, "result_chunk", {
			resultId: metadata.resultId, offset: 0, chunk: content,
		}, { turnId: "queued" }));
		state = reduceGatewayEvent(state, event("conv_1", 3, "final_answer", {
			resultId: metadata.resultId, lines: [], backgroundWorkPending: true,
		}, { turnId: "queued" }));
		expect(state.conversations.conv_1?.turns.queued).toMatchObject({ status: "running", answer: content });
	});

	it("bounds orphan result buffering without creating visible Turns", () => {
		let state = emptyMetaWorkClientState();
		for (let i = 0; i < 205; i += 1) {
			state = reduceGatewayEvent(state, event("conv_1", i + 1, "result_delivery_available",
				resultPayload("result"), { turnId: `orphan_${i}` }));
		}
		expect(state.conversations.conv_1?.turnOrder).toEqual([]);
		expect(Object.keys(state.conversations.conv_1?.pendingResults ?? {})).toHaveLength(200);
	});

	it("keeps a queued Turn running and replaces its acknowledgement with the later result", () => {
		let state = emptyMetaWorkClientState();
		const emit = (sequence: number, kind: string, payload: unknown) => {
			state = reduceGatewayEvent(state, event("conv_1", sequence, kind, payload, { turnId: "turn_1" }));
		};
		const queued = resultPayload("等待资源");
		emit(1, "turn_started", { commandKind: "user_message" });
		emit(2, "result_delivery_available", queued);
		emit(3, "result_chunk", { resultId: queued.resultId, offset: 0, chunk: "等待资源" });
		emit(4, "result_completed", queued);
		emit(5, "final_answer", { resultId: queued.resultId, lines: [], backgroundWorkPending: true });
		expect(state.conversations.conv_1!.turns.turn_1!.status).toBe("running");
		const actual = { ...resultPayload("完整结果"), resultId: "result_actual" };
		emit(6, "result_delivery_available", actual);
		emit(7, "result_chunk", { resultId: actual.resultId, offset: 0, chunk: "完整结果" });
		emit(8, "result_completed", actual);
		emit(9, "final_answer", { resultId: actual.resultId, lines: [] });
		expect(state.conversations.conv_1!.turns.turn_1!).toMatchObject({
			status: "completed", answer: "完整结果", result: { resultId: "result_actual", verification: "certified" },
		});
	});

	const taskView = (asOfSequence: number, overrides: Record<string, unknown> = {}) => ({
		queryVersion: "task_view_v1", requestId: "view", targetConversationId: "conv_1",
		turnId: "turn_1", taskId: "task_1", asOfSequence,
		subtasks: [{ id: "sub_1", title: "sub", status: "running", executor: "codex-cli" }],
		pendingPermission: null, ...overrides,
	});

	it("does not roll back live subtasks when an older snapshot arrives", () => {
		let state = reduceGatewayEvent(emptyMetaWorkClientState(), event("conv_1", 4,
			"execution_delta", { subtaskId: "sub_1", status: "done" }, { turnId: "turn_1" }));
		state = reduceGatewayEvent(state, event("connection", 1, "task_view_snapshot", taskView(2)));
		expect(state.conversations.conv_1!.turns.turn_1!.subtasks.sub_1!.status).toBe("done");
	});

	it("clears a pending permission absent from a newer authoritative snapshot", () => {
		let state = reduceGatewayEvent(emptyMetaWorkClientState(), event("conv_1", 1,
			"permission_request", { requestId: "p", summary: "read" }, { turnId: "turn_1" }));
		state = reduceGatewayEvent(state, event("connection", 1, "task_view_snapshot", taskView(2)));
		expect(state.conversations.conv_1!.turns.turn_1!.permission).toBeNull();
	});

	it("hydrates running history and keeps pages chronologically ordered", () => {
		let state = reduceGatewayEvent(emptyMetaWorkClientState(), event("conv_1", 1,
			"turn_started", { commandKind: "user_message" }, { turnId: "live" }));
		state = reduceGatewayEvent(state, event("conv_1", 2, "conversation_history_page", {
			turns: [
				{ id: "live", status: "running", userInput: "current question" },
				{ id: "new", status: "completed", userInput: "new question" },
				{ id: "old", status: "completed", userInput: "old question" },
			], nextCursor: "older",
		}));
		expect(state.conversations.conv_1!.turns.live!.userInput).toBe("current question");
		expect(state.conversations.conv_1!.turnOrder).toEqual(["old", "new", "live"]);
		expect(state.conversations.conv_1!.historyTurnIds).toContain("live");
	});

	it("merges a refreshed latest page after cached older Turns and advances history status", () => {
		let state = reduceGatewayEvent(emptyMetaWorkClientState(), event("conv_1", 1,
			"conversation_history_page", { turns: [{ id: "old", status: "running", taskId: "task_old" }], nextCursor: null }));
		state = reduceGatewayEvent(state, event("conv_1", 2, "conversation_history_page", {
			turns: [
				{ id: "new", status: "completed", finalAnswer: "new answer" },
				{ id: "old", status: "completed", taskId: "task_old", finalAnswer: "old answer" },
			], previousCursor: null, nextCursor: null,
		}));
		expect(state.conversations.conv_1!.turnOrder).toEqual(["old", "new"]);
		expect(state.conversations.conv_1!.turns.old!.status).toBe("completed");
	});

	it("does not invent an active result transfer from historical Task metadata", () => {
		let state = reduceGatewayEvent(emptyMetaWorkClientState(), event("conv_1", 1,
			"conversation_history_page", { turns: [
				{ id: "turn_1", status: "completed", taskId: "task_1", finalAnswer: "saved answer" },
			], nextCursor: null }));
		state = reduceGatewayEvent(state, event("connection", 1, "task_view_snapshot", taskView(2, {
			result: { resultId: "r", completeness: "complete", certification: "certified" },
		})));
		expect(state.conversations.conv_1!.turns.turn_1!.answer).toBe("saved answer");
		expect(state.conversations.conv_1!.turns.turn_1!.result?.verification).not.toBe("streaming");
	});

	it("orders disjoint newest pages by server time rather than whether an old Turn was live", () => {
		let state = reduceGatewayEvent(emptyMetaWorkClientState(), event("conv_1", 1,
			"turn_started", { commandKind: "user_message" }, { turnId: "old" }));
		state = reduceGatewayEvent(state, event("conv_1", 2, "conversation_history_page", {
			turns: [{ id: "new", status: "completed", userInput: "new request", startedAt: "2026-09-20T00:00:00Z" }],
			previousCursor: null, nextCursor: "older",
		}));
		expect(state.conversations.conv_1!.turnOrder).toEqual(["old", "new"]);
		// A live Turn genuinely newer than the fetched page stays at the end.
		state = reduceGatewayEvent(state, event("conv_1", 3, "conversation_history_page", {
			turns: [{ id: "earlier", status: "completed", userInput: "earlier request", startedAt: "2026-09-18T00:00:00Z" }],
			previousCursor: null, nextCursor: "older",
		}));
		expect(state.conversations.conv_1!.turnOrder).toEqual(["earlier", "old", "new"]);
	});

	it("correlates admitted user input by request identity before history arrives", () => {
		let state = queueSubmission(emptyMetaWorkClientState(), {
			protocolVersion: 2, connectionId: "tui", requestId: "request", idempotencyKey: "id",
			scope: { kind: "conversation", selection: { mode: "attach", conversationId: "conv_1" } },
			command: { kind: "user_message", text: "current question", attachments: [] }, clientCapabilities: [],
		}, 1);
		state = reduceGatewayEvent(state, event("conv_1", 1, "turn_started",
			{ commandKind: "user_message" }, { turnId: "turn_1", requestId: "request" }));
		expect(state.conversations.conv_1!.turns.turn_1!.userInput).toBe("current question");
	});

	it("projects safe routing and Attempt details from the existing timeline", () => {
		const state = reduceGatewayEvent(emptyMetaWorkClientState(), event("connection", 1,
			"task_view_snapshot", taskView(2, {
				title: "Task title", status: "running",
				routing: { executor: "codex-cli", provider: "provider", model: "model", harness: null },
				timeline: { taskId: "task_1", stages: [{ phase: "execution", subtasks: [{
					id: "sub_1", attempts: [{ attemptId: "attempt_1", attemptOrdinal: 1,
						attemptKind: "initial", attemptLabel: "First", displayStatus: "执行中", result: "",
						startedAt: "2026-09-20T00:00:00Z" }],
				}] }] },
			})));
		const turn = state.conversations.conv_1!.turns.turn_1!;
		expect(turn.taskTitle).toBe("Task title");
		expect(turn.routing?.provider).toBe("provider");
		expect(turn.subtasks.sub_1!.attempts?.[0]?.attemptId).toBe("attempt_1");
	});

	it("keeps live, replay and history facts consistent without duplication", () => {
		// live 流：turn 开始 -> trace -> 结果 -> final。
		let state = emptyMetaWorkClientState();
		state = selectConversation(state, "conv_1");
		state = reduceGatewayEvent(state, event("conv_1", 1, "turn_started", { commandKind: "user_message" }, { turnId: "turn_1", requestId: "req_1" }));
		state = reduceGatewayEvent(state, event("conv_1", 2, "trace_delta", {
			turnId: "turn_1",
			taskId: "task_1",
			status: "running",
			events: [{ eventKey: "k1", phase: "planning", actor: "planner", title: "规划", summary: "生成计划" }],
		}, { turnId: "turn_1" }));
		const content = "最终结果";
		const meta = resultPayload(content);
		state = reduceGatewayEvent(state, event("conv_1", 3, "result_delivery_available", meta, { turnId: "turn_1" }));
		state = reduceGatewayEvent(state, event("conv_1", 4, "result_chunk", { resultId: "result_1", offset: 0, chunk: content }, { turnId: "turn_1" }));
		state = reduceGatewayEvent(state, event("conv_1", 5, "result_completed", meta, { turnId: "turn_1" }));
		state = reduceGatewayEvent(state, event("conv_1", 6, "final_answer", { lines: [], ...meta }, { turnId: "turn_1" }));

		const liveTurn = state.conversations.conv_1!.turns.turn_1!;
		expect(liveTurn.status).toBe("completed");
		expect(liveTurn.taskId).toBe("task_1");
		expect(liveTurn.answer).toBe(content);
		expect(liveTurn.result?.verification).toBe("certified");
		expect(liveTurn.trace).toHaveLength(1);

		// 重放同样的事件流（同一 eventId 集合）：展示事实完全一致。
		const replayEvents = [
			event("conv_1", 1, "turn_started", { commandKind: "user_message" }, { turnId: "turn_1", requestId: "req_1" }),
			event("conv_1", 2, "trace_delta", {
				turnId: "turn_1",
				taskId: "task_1",
				status: "running",
				events: [{ eventKey: "k1", phase: "planning", actor: "planner", title: "规划", summary: "生成计划" }],
			}, { turnId: "turn_1" }),
			event("conv_1", 3, "result_delivery_available", meta, { turnId: "turn_1" }),
			event("conv_1", 4, "result_chunk", { resultId: "result_1", offset: 0, chunk: content }, { turnId: "turn_1" }),
			event("conv_1", 5, "result_completed", meta, { turnId: "turn_1" }),
			event("conv_1", 6, "final_answer", { lines: [], ...meta }, { turnId: "turn_1" }),
		];
		const replayed = applyGatewayReplay(emptyMetaWorkClientState(), "conv_1", {
			lastSequence: 6,
			snapshot: [],
			deltas: replayEvents,
		});
		const replayTurn = replayed.conversations.conv_1!.turns.turn_1!;
		expect(replayTurn.status).toBe("completed");
		expect(replayTurn.answer).toBe(content);
		expect(replayTurn.trace).toHaveLength(1);

		// live 之后重放：序号水位使重复事件静默跳过，不重复追加。
		const afterReplay = applyGatewayReplay(state, "conv_1", {
			lastSequence: 6,
			snapshot: [],
			deltas: replayEvents,
		});
		expect(afterReplay.conversations.conv_1!.turns.turn_1!.trace).toHaveLength(1);
		expect(afterReplay.conversations.conv_1!.turns.turn_1!.answer).toBe(content);
	});

	it("treats origin-filtered sequence gaps as normal and never requests resync", () => {
		let state = emptyMetaWorkClientState();
		state = selectConversation(state, "conv_1");
		// 序号 1..9 被 origin 过滤掉（其他端的详细事件），直接收到 10。
		state = reduceGatewayEvent(state, event("conv_1", 10, "turn_started", { commandKind: "user_message" }, { turnId: "turn_1" }));
		expect(state.conversations.conv_1!.turns.turn_1!.status).toBe("running");
		expect(state.notices.filter(notice => notice.kind === "error")).toHaveLength(0);
		expect(state.streamSequences.conv_1).toBe(10);
	});

	it("keeps Workspace and connection stream sequences off the Conversation cursor", () => {
		let state = emptyMetaWorkClientState();
		state = selectConversation(state, "conv_1");
		state = reduceGatewayEvent(state, event("conv_1", 5, "turn_started", { commandKind: "user_message" }, { turnId: "turn_1" }));
		// Workspace 流与 connection 流的更大序号不得推进 Conversation cursor。
		state = reduceGatewayEvent(state, event("workspace_stream", 99, "workspace_activity_changed", { conversationId: "conv_1" }));
		state = reduceGatewayEvent(state, event("client_connection_x", 120, "command_completion", {
			queryVersion: "command_completion_v1",
			requestId: "req_c1",
			targetConversationId: null,
			state: "incomplete",
			suggestions: [],
			hint: null,
			error: null,
		}));
		expect(state.conversations.conv_1!.cursor).toBe(5);
		expect(state.streamSequences.workspace_stream).toBe(99);
		expect(state.streamSequences.client_connection_x).toBe(120);
	});

	it("applies task view snapshots with watermark-aware buffering", () => {
		let state = emptyMetaWorkClientState();
		state = selectConversation(state, "conv_1");
		state = reduceGatewayEvent(state, event("conv_1", 1, "turn_started", { commandKind: "user_message" }, { turnId: "turn_1" }));
		// 快照水位 asOfSequence = 3。
		state = reduceGatewayEvent(state, event("client_connection_x", 1, "task_view_snapshot", {
			queryVersion: "task_view_v1",
			requestId: "req_view",
			targetConversationId: "conv_1",
			turnId: "turn_1",
			taskId: "task_1",
			title: "任务",
			status: "running",
			progressSummary: "执行中",
			subtasks: [{ id: "sub_1", title: "子任务", status: "running", executor: "codex-cli" }],
			pendingPermission: null,
			artifacts: [],
			result: null,
			asOfSequence: 3,
		}));
		let turn = state.conversations.conv_1!.turns.turn_1!;
		expect(turn.taskId).toBe("task_1");
		expect(turn.subtasks.sub_1?.executor).toBe("codex-cli");

		// 水位之前的缓冲事件不重复应用（sequence 2 <= 3）。
		state = reduceGatewayEvent(state, event("conv_1", 2, "execution_delta", {
			subtaskId: "sub_1",
			status: "completed",
			progress: "过期进展",
		}, { turnId: "turn_1" }));
		expect(state.conversations.conv_1!.turns.turn_1!.subtasks.sub_1?.status).toBe("running");

		// 水位之后的合法事件继续应用（sequence 4 > 3）。
		state = reduceGatewayEvent(state, event("conv_1", 4, "execution_delta", {
			subtaskId: "sub_1",
			status: "completed",
			progress: "新进展",
		}, { turnId: "turn_1" }));
		turn = state.conversations.conv_1!.turns.turn_1!;
		expect(turn.subtasks.sub_1?.status).toBe("completed");
		expect(turn.subtasks.sub_1?.progress).toBe("新进展");
	});

	it("attributes parallel subtasks to their own turns and preserves history selection", () => {
		let state = emptyMetaWorkClientState();
		state = selectConversation(state, "conv_1");
		state = reduceGatewayEvent(state, event("conv_1", 1, "turn_started", { commandKind: "user_message" }, { turnId: "turn_1" }));
		state = reduceGatewayEvent(state, event("conv_1", 2, "turn_started", { commandKind: "user_message" }, { turnId: "turn_2" }));
		state = reduceGatewayEvent(state, event("conv_1", 3, "execution_delta", { subtaskId: "sub_a", status: "running" }, { turnId: "turn_1" }));
		state = reduceGatewayEvent(state, event("conv_1", 4, "execution_delta", { subtaskId: "sub_b", status: "running" }, { turnId: "turn_1" }));
		state = reduceGatewayEvent(state, event("conv_1", 5, "execution_delta", { subtaskId: "sub_c", status: "running" }, { turnId: "turn_2" }));

		expect(Object.keys(state.conversations.conv_1!.turns.turn_1!.subtasks)).toEqual(["sub_a", "sub_b"]);
		expect(Object.keys(state.conversations.conv_1!.turns.turn_2!.subtasks)).toEqual(["sub_c"]);

		// 用户正在看历史 Turn：新进展不得抢占选中项。
		state = selectTurn(state, "conv_1", "turn_1");
		state = reduceGatewayEvent(state, event("conv_1", 6, "execution_delta", { subtaskId: "sub_c", status: "completed" }, { turnId: "turn_2" }));
		expect(state.ui.selectedTurnIds.conv_1).toBe("turn_1");
	});

	it("separates system command completion from background task completion", () => {
		let state = emptyMetaWorkClientState();
		state = selectConversation(state, "conv_1");
		state = reduceGatewayEvent(state, event("conv_1", 1, "turn_started", { commandKind: "slash_command" }, { turnId: "turn_cmd" }));
		state = reduceGatewayEvent(state, event("conv_1", 2, "final_answer", { lines: ["任务已启动"] }, { turnId: "turn_cmd" }));
		expect(state.conversations.conv_1!.turns.turn_cmd!.interactionKind).toBe("system_command");
		expect(state.conversations.conv_1!.turns.turn_cmd!.status).toBe("completed");

		// 命令返回后后台 Task 继续：进展仍归属该 Turn 的 Task 投影，但 Turn 终态不回退。
		state = reduceGatewayEvent(state, event("conv_1", 3, "execution_delta", { subtaskId: "sub_1", status: "running", progress: "执行中" }, { turnId: "turn_cmd" }));
		const turn = state.conversations.conv_1!.turns.turn_cmd!;
		expect(turn.status).toBe("completed");
		expect(turn.subtasks.sub_1?.status).toBe("running");
	});

	it("keeps terminal turns closed against late events", () => {
		let state = emptyMetaWorkClientState();
		state = selectConversation(state, "conv_1");
		state = reduceGatewayEvent(state, event("conv_1", 1, "turn_started", { commandKind: "user_message" }, { turnId: "turn_1" }));
		state = reduceGatewayEvent(state, event("conv_1", 2, "terminal_error", { code: "cancelled", message: "已取消" }, { turnId: "turn_1" }));
		expect(state.conversations.conv_1!.turns.turn_1!.status).toBe("cancelled");

		// 迟到的 running trace 不重开 Turn；内容可以丰富。
		state = reduceGatewayEvent(state, event("conv_1", 3, "trace_delta", {
			turnId: "turn_1",
			status: "running",
			events: [{ eventKey: "late", phase: "execution", actor: "executor", title: "迟到", summary: "" }],
		}, { turnId: "turn_1" }));
		const turn = state.conversations.conv_1!.turns.turn_1!;
		expect(turn.status).toBe("cancelled");
		expect(turn.trace.map(item => item.eventKey)).toEqual(["late"]);

		// 重复的 turn_started 不重开。
		state = reduceGatewayEvent(state, event("conv_1", 4, "turn_started", { commandKind: "user_message" }, { turnId: "turn_1" }));
		expect(state.conversations.conv_1!.turns.turn_1!.status).toBe("cancelled");
	});

	it("dedupes result chunks, rejects gaps via hash verification and keeps content unique", () => {
		const content = "abcdef";
		const meta = resultPayload(content);
		let state = emptyMetaWorkClientState();
		state = selectConversation(state, "conv_1");
		state = reduceGatewayEvent(state, event("conv_1", 1, "turn_started", { commandKind: "user_message" }, { turnId: "turn_1" }));
		state = reduceGatewayEvent(state, event("conv_1", 2, "result_delivery_available", meta, { turnId: "turn_1" }));
		state = reduceGatewayEvent(state, event("conv_1", 3, "result_chunk", { resultId: "result_1", offset: 0, chunk: "abc" }, { turnId: "turn_1" }));
		// 重复分块：相同 offset + 内容，幂等。
		state = reduceGatewayEvent(state, event("conv_1", 4, "result_chunk", { resultId: "result_1", offset: 0, chunk: "abc" }, { turnId: "turn_1" }));
		state = reduceGatewayEvent(state, event("conv_1", 5, "result_chunk", { resultId: "result_1", offset: 3, chunk: "def" }, { turnId: "turn_1" }));
		state = reduceGatewayEvent(state, event("conv_1", 6, "result_completed", meta, { turnId: "turn_1" }));
		let turn = state.conversations.conv_1!.turns.turn_1!;
		expect(turn.answer).toBe("abcdef");
		expect(turn.result?.verification).toBe("certified");

		// 缺块：hash 不符 -> 传输问题，不伪造完整结果。
		let broken = emptyMetaWorkClientState();
		broken = selectConversation(broken, "conv_1");
		broken = reduceGatewayEvent(broken, event("conv_1", 1, "turn_started", { commandKind: "user_message" }, { turnId: "turn_1" }));
		broken = reduceGatewayEvent(broken, event("conv_1", 2, "result_delivery_available", meta, { turnId: "turn_1" }));
		broken = reduceGatewayEvent(broken, event("conv_1", 3, "result_chunk", { resultId: "result_1", offset: 0, chunk: "abc" }, { turnId: "turn_1" }));
		broken = reduceGatewayEvent(broken, event("conv_1", 4, "result_completed", meta, { turnId: "turn_1" }));
		turn = broken.conversations.conv_1!.turns.turn_1!;
		expect(turn.result?.verification).toBe("failed");
		expect(turn.status).toBe("running");
	});

	it("drops stale completions so old responses never overwrite new drafts", () => {
		let state = emptyMetaWorkClientState();
		state = selectConversation(state, "conv_1");
		state = setDraft(state, "conv_1", "/task");
		state = requestCompletion(state, "conv_1", "req_new", 2);
		// 旧请求版本的响应被丢弃。
		state = reduceGatewayEvent(state, event("client_connection_x", 1, "command_completion", {
			queryVersion: "command_completion_v1",
			requestId: "req_old",
			targetConversationId: "conv_1",
			state: "incomplete",
			suggestions: [{ value: "/task old", label: "/task old", description: "", replacement: { start: 0, end: 5, text: "/task old" } }],
			hint: null,
			error: null,
		}));
		expect(state.completions.conv_1).toBeUndefined();

		state = reduceGatewayEvent(state, event("client_connection_x", 2, "command_completion", {
			queryVersion: "command_completion_v1",
			requestId: "req_new",
			targetConversationId: "conv_1",
			state: "incomplete",
			suggestions: [{ value: "/task list", label: "/task list", description: "", replacement: { start: 0, end: 5, text: "/task list" } }],
			hint: null,
			error: null,
		}));
		expect(state.completions.conv_1?.inputVersion).toBe(2);
		expect(state.completions.conv_1?.suggestions[0]?.value).toBe("/task list");
		// 草稿不被跨 Conversation 污染。
		expect(state.ui.drafts.conv_1).toBe("/task");
	});

	it("tracks submission receipts and uncertain reconnect replay", () => {
		let state = emptyMetaWorkClientState();
		const envelope = {
			protocolVersion: 2 as const,
			requestId: "req_1",
			idempotencyKey: "idem_1",
			connectionId: "tui_1",
			scope: {
				kind: "conversation" as const,
				selection: { mode: "attach" as const, conversationId: "conv_1" },
			},
			command: { kind: "user_message" as const, text: "hello", attachments: [] },
			clientCapabilities: ["trace_v1"],
		};
		state = queueSubmission(state, envelope, 1);
		// 发送后断线，没有 receipt：受理状态待确认。
		state = markPendingSubmissionsUncertain(state);
		expect(state.pendingSubmissions.req_1?.state).toBe("uncertain");
		// 恢复后重放同一 envelope，服务端回执归属原 requestId。
		state = reduceReceipt(state, {
			requestId: "req_1",
			status: "duplicate",
			turnId: null,
		});
		expect(state.pendingSubmissions.req_1?.state).toBe("duplicate");
		// 未知 requestId 的回执被忽略。
		const unchanged = reduceReceipt(state, { requestId: "req_unknown", status: "accepted", turnId: null });
		expect(unchanged.pendingSubmissions.req_unknown).toBeUndefined();
	});

	it("loads history pages into the shared turn pipeline without overriding live facts", () => {
		let state = emptyMetaWorkClientState();
		state = selectConversation(state, "conv_1");
		state = reduceGatewayEvent(state, event("conv_1", 10, "turn_started", { commandKind: "user_message" }, { turnId: "turn_live" }));
		state = reduceGatewayEvent(state, event("conv_1", 11, "trace_delta", { turnId: "turn_live", taskId: "task_live", status: "running", events: [] }, { turnId: "turn_live" }));
		// 历史页（新到旧），含一个与 live 同名的 Turn（只补全不覆盖）。
		state = reduceGatewayEvent(state, event("conv_1", 12, "conversation_history_page", {
			turns: [
				{ id: "turn_live", userInput: "live 输入", finalAnswer: null, status: "completed", taskId: "task_wrong" },
				{ id: "turn_old", userInput: "旧输入", finalAnswer: "旧答案", status: "completed", taskId: "task_old" },
			],
			previousCursor: null,
			nextCursor: "cursor_older",
		}));
		const conversation = state.conversations.conv_1!;
		const liveTurn = conversation.turns.turn_live!;
		expect(liveTurn.status).toBe("running");
		expect(liveTurn.taskId).toBe("task_live");
		expect(liveTurn.userInput).toBe("live 输入");
		expect(conversation.turns.turn_old?.answer).toBe("旧答案");
		// 历史 Turn 排在最前，live Turn 保持在后。
		expect(conversation.turnOrder).toEqual(["turn_old", "turn_live"]);
		expect(conversation.historyCursor).toBe("cursor_older");
		expect(conversation.historyExhausted).toBe(false);
	});

	it("rejects unknown event kinds and malformed payloads without printing raw data", () => {
		let state = emptyMetaWorkClientState();
		state = reduceGatewayEvent(state, event("conv_1", 1, "unknown_kind", { secret: "raw" }));
		expect(state.notices).toHaveLength(1);
		expect(state.notices[0]!.kind).toBe("unknown_event");
		expect(state.notices[0]!.text).not.toContain("raw");
		state = reduceGatewayEvent(state, event("conv_1", 2, "trace_delta", "not-a-record"));
		expect(state.conversations.conv_1).toBeUndefined();
	});

	it("applies billing projections from the connection stream to the matching Turn", () => {
		let state = emptyMetaWorkClientState();
		state = selectConversation(state, "conv_1");
		state = reduceGatewayEvent(state, event("conv_1", 1, "turn_started", {
			commandKind: "user_message",
		}, { turnId: "turn_1" }));
		state = reduceGatewayEvent(state, event("conv_1", 2, "trace_delta", {
			turnId: "turn_1",
			taskId: "task_1",
			status: "running",
			events: [],
		}, { turnId: "turn_1" }));
		state = reduceGatewayEvent(state, event("client_connection_1", 1, "usage_billing_projection", {
			turnId: "turn_1",
			turnBill: {
				userStatus: "billed",
				headline: "本次费用：1.4 MetaCoin",
				amountMicroCoin: "1.4",
				amountIsFinal: true,
				diagnosticMessage: null,
				stageBreakdown: [
					{
						stage: "planning",
						agentClassRef: "planner",
						providerRef: "deepseek",
						modelId: "deepseek-flash",
						inputTokens: "50814",
						outputTokens: "2279",
						totalTokens: "53093",
						assessedMetaCoin: "0.083902",
						costStatus: "calculated",
					},
					{
						stage: "execution",
						agentClassRef: "pi-research",
						providerRef: "deepseek",
						modelId: "deepseek-flash",
						inputTokens: "851879",
						outputTokens: "25047",
						totalTokens: "876926",
						assessedMetaCoin: "1.332894",
						costStatus: "calculated",
					},
				],
				billId: "bill_1",
				finalizedAt: "2026-09-19T00:00:00.000Z",
			},
		}));
		state = reduceGatewayEvent(state, event("client_connection_1", 2, "usage_billing_projection", {
			taskId: "task_1",
			finalizedMicroCoin: "1400000",
			pendingReconciliationMicroCoin: "0",
			inFlightMicroCoin: "0",
			queryCount: 1,
			confirmedDeductedMicroCoin: "0",
		}));
		const turn = state.conversations.conv_1!.turns.turn_1!;
		expect(turn.turnBill?.amountMicroCoin).toBe("1.4");
		expect(turn.turnBill?.stageBreakdown.map(entry => entry.stage)).toEqual(["planning", "execution"]);
		expect(turn.taskUsageSummary?.finalizedMicroCoin).toBe("1400000");
	});

	it("strips terminal control characters from untrusted display text", () => {
		expect(sanitizeDisplayText("ok\u001b[2J\u0008el")).toBe("okel");
		expect(sanitizeDisplayText("a\nb\tc")).toBe("a\nb\tc");
		expect(sanitizeDisplayText("title\roverride")).toBe("titleoverride");
		let state = emptyMetaWorkClientState();
		state = selectConversation(state, "conv_1");
		state = reduceGatewayEvent(state, event("conv_1", 1, "turn_started",
			{ commandKind: "user_message" }, { turnId: "turn_1" }));
		state = reduceGatewayEvent(state, event("conv_1", 2, "trace_delta", {
			turnId: "turn_1",
			status: "running",
			events: [{ phase: "execution", actor: "executor", title: "进展\u001b[1;1H", summary: "bad\u0007bell" }],
		}, { turnId: "turn_1" }));
		const item = state.conversations.conv_1!.turns.turn_1!.trace[0]!;
		expect(item.title).toBe("进展");
		expect(item.summary).toBe("badbell");
	});

});
