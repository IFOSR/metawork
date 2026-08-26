import { describe, expect, it } from "vitest";
import {
	rebuildFromReplay,
	reduceGatewayEvent,
	type ConversationViewModel,
} from "../src/modes/interactive/metawork-client-reducer.ts";
import type { GatewayEventEnvelope, GatewayReplay } from "../src/anyfusion/gateway-protocol.ts";

function event(
	kind: GatewayEventEnvelope["kind"],
	payload: unknown,
	sequence: number,
	overrides: Partial<GatewayEventEnvelope> = {},
): GatewayEventEnvelope {
	return {
		protocolVersion: 1,
		eventId: overrides.eventId ?? `event_${sequence}`,
		sequence,
		accountId: "local-default",
		conversationId: "conv_1",
		requestId: overrides.requestId ?? "req_1",
		turnId: overrides.turnId ?? "turn_1",
		kind,
		payload,
		occurredAt: "2026-08-26T00:00:00.000Z",
	};
}

function baseState(): ConversationViewModel {
	return rebuildFromReplay({ lastSequence: 0, snapshot: [], deltas: [] });
}

describe("MetaWork client reducer", () => {
	it("rebuilds replay and live delivery to the same presentation state", () => {
		const events = [
			event("turn_started", { commandKind: "user_message" }, 1),
			event("trace_delta", {
				events: [{ phase: "planning", actor: "planner", title: "理解请求", summary: "已接收" }],
			}, 2),
			event("final_answer", { lines: ["完成"] }, 3),
		];
		const replay: GatewayReplay = { lastSequence: 3, snapshot: events.slice(0, 1), deltas: events.slice(1) };
		expect(rebuildFromReplay(replay)).toEqual(
			events.reduce(reduceGatewayEvent, baseState()),
		);
	});

	it("deduplicates event IDs and event keys", () => {
		const first = event("trace_delta", {
			events: [{ eventKey: "trace_1", phase: "planning", title: "读取上下文" }],
		}, 1, { eventId: "same" });
		const state = reduceGatewayEvent(reduceGatewayEvent(baseState(), first), {
			...first,
			sequence: 2,
		});
		expect(state.currentTurn?.trace).toHaveLength(1);
	});

	it("fails closed on out-of-order sequences", () => {
		const state = reduceGatewayEvent(
			reduceGatewayEvent(baseState(), event("turn_started", {}, 2)),
			event("trace_delta", { events: [] }, 1),
		);
		expect(state.connection).toBe("resync_required");
	});

	it("maps public runtime phases into the six user stages", () => {
		let state = baseState();
		for (const [phase, stage] of [
			["planning", "understanding"],
			["authorization", "authorization"],
			["routing", "authorization"],
			["execution", "execution"],
			["verification", "verification"],
			["delivery", "delivery"],
		] as const) {
			state = reduceGatewayEvent(state, event("trace_delta", {
				events: [{ phase, actor: "runtime", title: phase }],
			}, state.lastSequence + 1));
			expect(state.currentTurn?.stage).toBe(stage);
		}
	});

	it("keeps Workspace state and exposes workspace_required as an actionable block", () => {
		let state = reduceGatewayEvent(baseState(), event("workspace_changed", {
			workspace: { path: "/repo", selectedAt: "2026-08-26T00:00:00.000Z" },
		}, 1));
		expect(state.workspace?.path).toBe("/repo");
		state = reduceGatewayEvent(state, event("terminal_error", {
			code: "workspace_required",
			message: "请先设置 Workspace",
		}, 2));
		expect(state.composer.blockedReason).toBe("workspace_required");
		expect(state.notices.at(-1)?.text).toContain("/workspace");
	});

	it("merges routing facts into authorization instead of a separate stage", () => {
		const state = reduceGatewayEvent(baseState(), event("trace_delta", {
			events: [{ phase: "routing", actor: "kernel", title: "Codex authorized" }],
		}, 1));
		expect(state.currentTurn?.stage).toBe("authorization");
		expect(state.currentTurn?.authorization).toContain("Codex authorized");
	});

	it("keeps one card per canonical Subtask and heartbeats update it in place", () => {
		let state = reduceGatewayEvent(baseState(), event("execution_delta", {
			subtaskId: "subtask_1",
			title: "检查 README",
			status: "running",
			progress: "读取文件",
		}, 1));
		state = reduceGatewayEvent(state, event("execution_delta", {
			subtaskId: "subtask_1",
			title: "检查 README",
			status: "running",
			progress: "仍在运行",
			heartbeat: true,
		}, 2));
		expect(Object.keys(state.currentTurn?.subtasks ?? {})).toEqual(["subtask_1"]);
		expect(state.currentTurn?.subtasks.subtask_1.progress).toBe("仍在运行");
	});

	it("tracks permission lifecycle without rendering raw authorization payloads", () => {
		let state = reduceGatewayEvent(baseState(), event("permission_request", {
			requestId: "perm_1",
			summary: "需要读取受限目录",
		}, 1));
		expect(state.currentTurn?.permission?.status).toBe("pending");
		state = reduceGatewayEvent(state, event("trace_delta", {
			events: [{ phase: "authorization", title: "权限已批准", eventKey: "perm_1:resolved" }],
		}, 2));
		expect(state.currentTurn?.permission?.status).toBe("resolved");
	});

	it("assembles and certifies result chunks by byte offset, hash, and length", () => {
		let state = reduceGatewayEvent(baseState(), event("result_delivery_available", {
			resultId: "result_1",
			contentHash: "sha256:2bb80d537b1da3e38bd30361aa855686bde0ba7e1f7d5e6f5b1f0f6b1e8c5e5c",
			byteLength: 5,
			certification: "certified",
		}, 1));
		state = reduceGatewayEvent(state, event("result_chunk", {
			resultId: "result_1", offset: 0, chunk: "hello",
		}, 2));
		state = reduceGatewayEvent(state, event("result_completed", {
			resultId: "result_1",
			contentHash: "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
			byteLength: 5,
			certification: "certified",
		}, 3));
		expect(state.currentTurn?.result?.content).toBe("hello");
		expect(state.currentTurn?.result?.verification).toBe("certified");
	});

	it("does not duplicate a final answer when result stream already owns the body", () => {
		let state = reduceGatewayEvent(baseState(), event("result_delivery_available", {
			resultId: "result_1", contentHash: "sha256:x", byteLength: 2, certification: "certified",
		}, 1));
		state = reduceGatewayEvent(state, event("result_chunk", {
			resultId: "result_1", offset: 0, chunk: "OK",
		}, 2));
		state = reduceGatewayEvent(state, event("final_answer", {
			lines: ["OK"], resultId: "result_1",
		}, 3));
		expect(state.currentTurn?.answerSources).toEqual(["result_stream"]);
		expect(state.currentTurn?.answer).toBe("OK");
	});

	it("does not absorb unrelated historical task projections into the current turn", () => {
		const state = reduceGatewayEvent(baseState(), event("task_projection", {
			currentTaskId: "old_task",
			runtimeState: { blockedTaskIds: ["old_task"] },
		}, 1));
		expect(state.currentTurn).toBeNull();
		expect(state.historyTaskNotice).toBeNull();
	});

	it("redacts sensitive and raw fields from renderable state", () => {
		const state = reduceGatewayEvent(baseState(), event("trace_delta", {
			events: [{
				phase: "planning",
				title: "安全进展",
				summary: "safe",
				reasoning: "hidden",
				prompt: "secret prompt",
				stdout: "raw",
				apiKey: "token",
			}],
		}, 1));
		const rendered = JSON.stringify(state);
		expect(rendered).not.toContain("hidden");
		expect(rendered).not.toContain("secret prompt");
		expect(rendered).not.toContain("raw");
		expect(rendered).not.toContain("token");
		expect(rendered).toContain("安全进展");
	});

	it("records terminal cancellation and unknown events as compact notices", () => {
		let state = reduceGatewayEvent(baseState(), event("terminal_error", {
			code: "cancelled",
			message: "用户已取消",
		}, 1));
		state = reduceGatewayEvent(state, {
			...event("terminal_error", {}, 2),
			kind: "unknown_kind" as GatewayEventEnvelope["kind"],
		});
		expect(state.currentTurn?.status).toBe("cancelled");
		expect(state.notices.at(-1)?.kind).toBe("unknown_event");
	});
});
