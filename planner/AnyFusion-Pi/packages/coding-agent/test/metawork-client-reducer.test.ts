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
		protocolVersion: 2,
		eventId: overrides.eventId ?? `event_${sequence}`,
		sequence,
		accountId: "local-default",
		conversationId: overrides.conversationId ?? "conv_1",
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
	it.each(["slash_command", "permission_resolution", "cancel_turn"])(
		"classifies %s as a system command",
		(commandKind) => {
			const state = reduceGatewayEvent(
				baseState(),
				event("turn_started", { commandKind }, 1),
			);

			expect(state.currentCommand).toMatchObject({
				interactionKind: "system_command",
				status: "running",
				output: "",
				error: null,
			});
			expect(state.currentTurn).toBeNull();
		},
	);

	it("stores system command output without creating an AI turn", () => {
		let state = reduceGatewayEvent(
			baseState(),
			event("turn_started", { commandKind: "slash_command" }, 1),
		);
		state = reduceGatewayEvent(state, event("final_answer", {
			lines: ["当前没有正在执行的任务"],
		}, 2));

		expect(state.currentCommand).toMatchObject({
			status: "completed",
			output: "当前没有正在执行的任务",
			error: null,
		});
		expect(state.currentTurn).toBeNull();
	});

	it("stores system command failures without creating an AI turn", () => {
		let state = reduceGatewayEvent(
			baseState(),
			event("turn_started", { commandKind: "slash_command" }, 1),
		);
		state = reduceGatewayEvent(state, event("terminal_error", {
			code: "command_invalid",
			message: "未知命令节点: does-not-exist。 输入 /help 查看命令树。",
		}, 2));

		expect(state.currentCommand).toMatchObject({
			status: "failed",
			output: "",
			error: "未知命令节点: does-not-exist。 输入 /help 查看命令树。",
		});
		expect(state.currentTurn).toBeNull();
	});

	it("classifies user messages as AI turns", () => {
		const state = reduceGatewayEvent(
			baseState(),
			event("turn_started", { commandKind: "user_message" }, 1),
		);

		expect(state.currentTurn).toMatchObject({
			interactionKind: "ai_turn",
			status: "running",
			stage: "understanding",
		});
		expect(state.currentCommand).toBeNull();
	});

	it("does not carry command output into a later AI turn", () => {
		let state = reduceGatewayEvent(
			baseState(),
			event("turn_started", { commandKind: "slash_command" }, 1),
		);
		state = reduceGatewayEvent(state, event("final_answer", {
			lines: ["命令结果"],
		}, 2));
		state = reduceGatewayEvent(state, event("turn_started", {
			commandKind: "user_message",
		}, 3, {
			requestId: "req_2",
			turnId: "turn_2",
		}));

		expect(state.currentCommand).toBeNull();
		expect(state.currentTurn).toMatchObject({
			id: "turn_2",
			answer: "",
			error: null,
		});
	});

	it("ignores a late command result after a newer AI turn starts", () => {
		let state = reduceGatewayEvent(
			baseState(),
			event("turn_started", { commandKind: "slash_command" }, 1),
		);
		state = reduceGatewayEvent(state, event("turn_started", {
			commandKind: "user_message",
		}, 2, {
			requestId: "req_2",
			turnId: "turn_2",
		}));
		state = reduceGatewayEvent(state, event("final_answer", {
			lines: ["迟到的命令结果"],
		}, 3, {
			requestId: "req_1",
			turnId: "turn_1",
		}));

		expect(state.currentTurn).toMatchObject({
			id: "turn_2",
			status: "running",
			answer: "",
		});
	});

	it("rebuilds system commands identically from replay and live events", () => {
		const events = [
			event("turn_started", { commandKind: "slash_command" }, 1),
			event("final_answer", { lines: ["帮助内容"] }, 2),
		];
		const replay: GatewayReplay = {
			lastSequence: 2,
			snapshot: events.slice(0, 1),
			deltas: events.slice(1),
		};

		expect(rebuildFromReplay(replay)).toEqual(
			events.reduce(reduceGatewayEvent, baseState()),
		);
		expect(rebuildFromReplay(replay).currentCommand?.output).toBe("帮助内容");
	});

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
		expect(state.activeWorkspace?.path).toBe("/repo");
		state = reduceGatewayEvent(state, event("terminal_error", {
			code: "workspace_required",
			message: "请先设置 Workspace",
		}, 2));
		expect(state.composer.blockedReason).toBe("workspace_required");
		expect(state.notices.at(-1)?.text).toContain("/workspace");
	});

	it("restores Workspace from a Conversation snapshot before live changes", () => {
		const state = reduceGatewayEvent(baseState(), event("conversation_snapshot", {
			lines: [],
			workspace: {
				path: "/repo-a",
				selectedAt: "2026-08-27T00:00:00.000Z",
			},
		}, 1));

		expect(state.activeWorkspace).toEqual({
			id: "",
			displayName: "repo-a",
			path: "/repo-a",
			availability: "available",
		});
		expect(state.activeConversationId).toBe("conv_1");
	});

	it("keeps Workspace directory state separate from the attached transcript", () => {
		const state = reduceGatewayEvent(baseState(), event("workspace_directory_snapshot", {
			workspaceId: "workspace_repo",
			workspace: {
				id: "workspace_repo",
				displayName: "MetaWork",
				canonicalPath: "/repo",
				availability: "available",
			},
			page: {
				items: [{
					conversationId: "conv_running",
					workspaceId: "workspace_repo",
					title: "检查构建",
					preview: "检查构建",
					updatedAt: "2026-08-28T00:00:00.000Z",
					activity: {
						state: "executing",
						taskId: "task_1",
						updatedAt: "2026-08-28T00:00:00.000Z",
					},
				}],
				nextCursor: null,
			},
		}, 1, {
			conversationId: "workspace_directory_workspace_repo",
			turnId: null,
			requestId: null,
		}));

		expect(state.activeWorkspace?.id).toBe("workspace_repo");
		expect(state.conversationSummaries[0]).toMatchObject({
			conversationId: "conv_running",
			title: "检查构建",
			activity: { state: "executing", taskId: "task_1" },
		});
		expect(state.activeConversationId).toBeNull();
		expect(state.currentTurn).toBeNull();
		expect(state.notices).toEqual([]);
	});

	it("tracks independent Workspace and Conversation sequence cursors", () => {
		let state = reduceGatewayEvent(baseState(), event("conversation_snapshot", {
			lines: [],
		}, 5));
		state = reduceGatewayEvent(state, event("workspace_directory_snapshot", {
			workspaceId: "workspace_repo",
			page: { items: [], nextCursor: null },
		}, 1, {
			conversationId: "workspace_directory_workspace_repo",
			turnId: null,
			requestId: null,
		}));

		expect(state.connection).toBe("connected");
		expect(state.streamSequences).toEqual({
			conv_1: 5,
			workspace_directory_workspace_repo: 1,
		});
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
