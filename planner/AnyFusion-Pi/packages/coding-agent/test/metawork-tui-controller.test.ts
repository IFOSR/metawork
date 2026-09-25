/**
 * MetaWork TUI 控制器测试（统一 TUI 设计 §15.2）。
 *
 * 用窄 Gateway 端口替身验证：提交固定目标、回执语义、不确定重放、
 * 取消语义、权限生命周期、补全版本匹配与导航代际。
 */

import { describe, expect, it, vi } from "vitest";
import type {
	GatewayCommand,
	GatewayCommandEnvelope,
	GatewayCommandReceipt,
	GatewayEventEnvelope,
	GatewayReplay,
	GatewayScope,
} from "../src/anyfusion/gateway-protocol.ts";
import {
	MetaWorkTuiController,
	type MetaWorkTuiGatewayPort,
} from "../src/modes/metawork-tui/controller.ts";
import { emptyMetaWorkClientState } from "../src/modes/metawork-tui/model.ts";

interface FakeGateway extends MetaWorkTuiGatewayPort {
	readonly submitted: Array<{ command: GatewayCommand; scope: GatewayScope; envelope: GatewayCommandEnvelope }>;
	emit(event: GatewayEventEnvelope): void;
	disconnect(): void;
	setCapabilities(capabilities: string[]): void;
	/** 模拟发送后断线丢 receipt。 */
	loseNextReceipt(): void;
	readonly calls: string[];
}

function event(
	conversationId: string,
	sequence: number,
	kind: string,
	payload: unknown,
	extras: Partial<GatewayEventEnvelope> = {},
): GatewayEventEnvelope {
	return {
		protocolVersion: 2,
		eventId: `evt_${conversationId}_${sequence}_${kind}`,
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

function createFakeGateway(
	overrides: {
		receipt?: (command: GatewayCommand) => Partial<GatewayCommandReceipt>;
		capabilities?: string[];
		replay?: GatewayReplay;
	} = {},
): FakeGateway {
	let counter = 0;
	let eventListener: (event: GatewayEventEnvelope) => void = () => undefined;
	let disconnectListener: (() => void) | null = null;
	const submitted: FakeGateway["submitted"] = [];
	const calls: string[] = [];
	let capabilities = overrides.capabilities ?? ["command_completion_v1", "task_view_v1"];
	let loseReceipt = false;
	const gateway: FakeGateway = {
		submitted,
		calls,
		emit: e => eventListener(e),
		disconnect: () => disconnectListener?.(),
		setCapabilities: value => {
			capabilities = value;
		},
		loseNextReceipt: () => {
			loseReceipt = true;
		},
		get serverCapabilities() {
			return capabilities;
		},
		connect: async () => {
			calls.push("connect");
		},
		onEvent: listener => {
			eventListener = listener;
			return () => undefined;
		},
		onDisconnect: listener => {
			disconnectListener = listener;
			return () => undefined;
		},
		resume: async (conversationId): Promise<GatewayReplay> => {
			calls.push(`resume:${conversationId}`);
			return overrides.replay ?? { lastSequence: 0, snapshot: [], deltas: [] };
		},
		createConversation: async (): Promise<GatewayCommandReceipt> => {
			counter += 1;
			return { requestId: `req_create_${counter}`, status: "accepted", conversationId: `conv_${counter}` };
		},
		attachConversation: async (conversationId): Promise<GatewayCommandReceipt> => {
			calls.push(`attach:${conversationId}`);
			counter += 1;
			return { requestId: `req_attach_${counter}`, status: "accepted", conversationId };
		},
		listWorkspaceConversations: async (): Promise<GatewayCommandReceipt> => {
			calls.push("list_conversations");
			counter += 1;
			return { requestId: `req_list_${counter}`, status: "accepted", conversationId: null };
		},
		getConversationHistory: async (): Promise<GatewayCommandReceipt> => {
			counter += 1;
			return { requestId: `req_history_${counter}`, status: "accepted", conversationId: "conv_1" };
		},
		completeCommand: async (text, _cursor, conversationId): Promise<GatewayCommandReceipt> => {
			calls.push(`complete:${text}:${conversationId ?? "workspace"}`);
			counter += 1;
			return { requestId: `req_complete_${counter}`, status: "accepted", conversationId: null };
		},
		getTaskView: async (conversationId): Promise<GatewayCommandReceipt> => {
			calls.push(`task_view:${conversationId}`);
			counter += 1;
			return { requestId: `req_view_${counter}`, status: "accepted", conversationId };
		},
		buildEnvelope: async (command, scope) => {
			counter += 1;
			const envelope: GatewayCommandEnvelope = {
				protocolVersion: 2,
				requestId: `req_${counter}`,
				idempotencyKey: `idem_${counter}`,
				connectionId: "tui_1",
				scope,
				command,
				clientCapabilities: ["trace_v1"],
			};
			submitted.push({ command, scope, envelope });
			return envelope;
		},
		submitEnvelope: async envelope => {
			calls.push(`submit:${envelope.requestId}`);
			if (loseReceipt) {
				loseReceipt = false;
				throw new Error("transport closed before receipt");
			}
			const receipt: GatewayCommandReceipt = {
				requestId: envelope.requestId,
				status: "accepted",
				conversationId: envelope.scope.kind === "conversation"
					&& envelope.scope.selection.mode === "attach"
					? envelope.scope.selection.conversationId
					: "conv_1",
				...overrides.receipt?.(envelope.command),
			};
			return receipt;
		},
		resubmitEnvelope: async envelope => {
			calls.push(`resubmit:${envelope.requestId}`);
			return { requestId: envelope.requestId, status: "duplicate", conversationId: "conv_1" };
		},
		initializeWorkspace: async (): Promise<GatewayCommandReceipt> => {
			calls.push("initialize_workspace");
			counter += 1;
			return { requestId: `req_ws_${counter}`, status: "accepted", conversationId: null, workspaceId: "ws_1" };
		},
		dispose: () => {
			calls.push("dispose");
		},
	};
	return gateway;
}

function stateWithConversation(controller: MetaWorkTuiController): void {
	// 通过事件建立 Workspace 与 Conversation 目录。
	controller['handleEvent'](event("workspace_stream", 1, "workspace_directory_snapshot", {
		workspaceId: "ws_1",
		workspace: { id: "ws_1", path: "/repo", displayName: "repo", availability: "available" },
		page: {
			items: [{
				conversationId: "conv_1",
				workspaceId: "ws_1",
				title: "会话一",
				preview: "",
				updatedAt: "2026-09-19T00:00:00.000Z",
			}],
			nextCursor: null,
		},
	}));
}

describe("metawork-tui controller", () => {
	it("applies completion published before the admission receipt", async () => {
		const gateway = createFakeGateway();
		gateway.completeCommand = async () => {
			gateway.emit(event("connection", 1, "command_completion", {
				queryVersion: "command_completion_v1", requestId: "early", targetConversationId: null,
				state: "incomplete", suggestions: [], hint: "workspace", error: null,
			}));
			return { requestId: "early", status: "accepted", conversationId: null };
		};
		const controller = new MetaWorkTuiController({ gateway, completionDebounceMs: 0 });
		await controller.start();
		await expect(controller.requestCompletion("/wo", 3)).resolves.toMatchObject({ hint: "workspace" });
		controller.stop();
	});

	it("handles workspace navigation without requiring a Conversation", async () => {
		const gateway = createFakeGateway();
		const controller = new MetaWorkTuiController({ gateway });
		await controller.start();
		await controller.submit("/workspace /repo");
		expect(gateway.calls).toContain("initialize_workspace");
		expect(gateway.submitted).toHaveLength(0);
		stateWithConversation(controller);
		await controller.submit("/conversations");
		expect(controller.getView().conversationSelectorOpen).toBe(true);
		await controller.submit("/conversation conv_1");
		expect(gateway.calls).toContain("attach:conv_1");
		expect(controller.getView().conversationSelectorOpen).toBe(false);
		controller.stop();
	});

	it("refreshes the latest history on attach and uses the older cursor only for explicit paging", async () => {
		const gateway = createFakeGateway();
		const history = vi.spyOn(gateway, "getConversationHistory");
		const controller = new MetaWorkTuiController({ gateway });
		await controller.start();
		await controller.attachConversation("conv_1", false);
		gateway.emit(event("conv_1", 1, "conversation_history_page", {
			turns: [{ id: "old", status: "completed" }], nextCursor: "older",
		}));
		await controller.attachConversation("conv_1", false);
		expect(history).toHaveBeenLastCalledWith("conv_1", undefined, 50);
		await controller.loadOlderHistory();
		expect(history).toHaveBeenLastCalledWith("conv_1", "older", 50);
		controller.stop();
	});

	it("queries a selected Task when toggling its panel", async () => {
		const gateway = createFakeGateway();
		const controller = new MetaWorkTuiController({ gateway });
		await controller.start();
		await controller.attachConversation("conv_1", false);
		gateway.emit(event("conv_1", 1, "turn_started", { commandKind: "user_message" }, { turnId: "turn_1" }));
		gateway.emit(event("conv_1", 2, "trace_delta", {
			turnId: "turn_1", taskId: "task_1", status: "running", events: [],
		}, { turnId: "turn_1" }));
		await controller.toggleTaskPanel();
		expect(gateway.calls).toContain("task_view:conv_1");
		controller.stop();
	});

	it("reissues a Task refresh requested while an older query is in flight", async () => {
		vi.useFakeTimers();
		const gateway = createFakeGateway();
		let release!: (receipt: GatewayCommandReceipt) => void;
		const query = vi.spyOn(gateway, "getTaskView").mockImplementationOnce(
			() => new Promise(resolve => { release = resolve; }),
		);
		const controller = new MetaWorkTuiController({ gateway });
		try {
			await controller.start();
			await controller.attachConversation("conv_1", false);
			gateway.emit(event("conv_1", 1, "turn_started", { commandKind: "user_message" }, { turnId: "turn_1" }));
			gateway.emit(event("conv_1", 2, "trace_delta", {
				turnId: "turn_1", taskId: "task_1", events: [],
			}, { turnId: "turn_1" }));
			await vi.advanceTimersByTimeAsync(500);
			gateway.emit(event("conv_1", 3, "final_answer", { lines: ["done"] }, { turnId: "turn_1" }));
			await vi.advanceTimersByTimeAsync(500);
			release({ requestId: "q", status: "accepted", conversationId: "conv_1" });
			await vi.advanceTimersByTimeAsync(500);
			expect(query).toHaveBeenCalledTimes(2);
		} finally { controller.stop(); vi.useRealTimers(); }
	});

	it("coalesces billing refreshes while replaying Turns without Tasks", async () => {
		vi.useFakeTimers();
		const gateway = createFakeGateway();
		const bill = vi.fn(async () => ({ requestId: "bill", status: "accepted" as const, conversationId: null }));
		gateway.getQueryBillForTurn = bill;
		const controller = new MetaWorkTuiController({ gateway });
		try {
			await controller.start();
			await controller.attachConversation("conv_1", false);
			gateway.emit(event("conv_1", 1, "turn_started", { commandKind: "user_message" }, { turnId: "turn_1" }));
			for (let index = 2; index <= 21; index += 1) {
				gateway.emit(event("conv_1", index, "trace_delta", {
					turnId: "turn_1", events: [],
				}, { turnId: "turn_1" }));
			}
			expect(bill).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(500);
			expect(bill).toHaveBeenCalledTimes(1);
		} finally { controller.stop(); vi.useRealTimers(); }
	});

	it("does not enable replayed permissions before an authoritative Task refresh", async () => {
		const gateway = createFakeGateway();
		const controller = new MetaWorkTuiController({ gateway });
		await controller.start();
		await controller.attachConversation("conv_1", false);
		gateway.emit(event("conv_1", 1, "turn_started", { commandKind: "user_message" }, { turnId: "turn_1" }));
		gateway.emit(event("conv_1", 2, "trace_delta", {
			turnId: "turn_1", taskId: "task_1", status: "running", events: [],
		}, { turnId: "turn_1" }));
		gateway.emit(event("conv_1", 3, "permission_request", { requestId: "perm_1", summary: "write" }, { turnId: "turn_1" }));
		gateway.getTaskView = async () => {
			gateway.emit(event("connection", 1, "task_view_snapshot", {
				queryVersion: "task_view_v1", requestId: "view", targetConversationId: "conv_1",
				turnId: "turn_1", taskId: "task_1", asOfSequence: 3, subtasks: [], pendingPermission: null,
			}));
			return { requestId: "view", status: "accepted", conversationId: "conv_1" };
		};
		await controller.resolvePermission("perm_1", "approve");
		expect(gateway.submitted).toHaveLength(0);
		expect(controller.getView().permission?.status).not.toBe("pending");
		controller.stop();
	});

	it("turns user input into a versioned command with the target fixed at submit time", async () => {
		const gateway = createFakeGateway();
		const controller = new MetaWorkTuiController({ gateway, createId: prefix => `${prefix}_1` });
		await controller.start();
		stateWithConversation(controller);
		await controller.attachConversation("conv_1", false);

		await controller.submit("你好");

		expect(gateway.submitted).toHaveLength(1);
		expect(gateway.submitted[0]!.command).toEqual({ kind: "user_message", text: "你好", attachments: [] });
		expect(gateway.submitted[0]!.scope).toEqual({
			kind: "conversation",
			selection: { mode: "attach", conversationId: "conv_1" },
		});
		const view = controller.getView();
		expect(view.submitting).toBe(false);
		expect(view.client.pendingSubmissions[gateway.submitted[0]!.envelope.requestId]?.state).toBe("accepted");
	});

	it("routes /cancel to cancel_turn and only reports the authoritative result", async () => {
		const gateway = createFakeGateway();
		const controller = new MetaWorkTuiController({ gateway });
		await controller.start();
		stateWithConversation(controller);
		await controller.attachConversation("conv_1", false);
		// 运行中的 Turn。
		controller['handleEvent'](event("conv_1", 1, "turn_started", { commandKind: "user_message" }, { turnId: "turn_1" }));

		await controller.submit("/cancel");

		expect(gateway.submitted.at(-1)!.command).toEqual({ kind: "cancel_turn", turnId: "turn_1" });
		// receipt 受理后仍显示"正在请求取消"，不宣称 Executor 已退出。
		expect(controller.getView().cancelling).toBe(true);
		expect(controller.getView().cancelResult).toBeNull();

		// 权威状态到达后才展示结果。
		controller['handleEvent'](event("conv_1", 2, "terminal_error", { code: "cancelled", message: "已取消" }, { turnId: "turn_1" }));
		expect(controller.getView().cancelling).toBe(false);
		expect(controller.getView().cancelResult).toBe("取消结果：cancelled");
	});

	it("keeps the identical envelope when the receipt is lost and replays it on reconnect", async () => {
		const gateway = createFakeGateway();
		const controller = new MetaWorkTuiController({ gateway });
		await controller.start();
		stateWithConversation(controller);
		await controller.attachConversation("conv_1", false);

		// 发送后断线且没有 receipt：envelope 在发送前已固定。
		gateway.loseNextReceipt();
		await controller.submit("你好");
		const envelope = gateway.submitted[0]!.envelope;
		expect(controller.getView().client.pendingSubmissions[envelope.requestId]?.state).toBe("uncertain");
		expect(controller.getView().awaitingReceipt).toContain("待确认");
		expect(controller.getView().operation).toContain("受理状态待确认");

		// 重连后只重放同一 requestId / idempotencyKey / 目标与内容。
		gateway.disconnect();
		expect(controller.getView().client.pendingSubmissions[envelope.requestId]?.state).toBe("uncertain");
		await new Promise(resolve => setTimeout(resolve, 5));
		expect(gateway.calls).toContain(`resubmit:${envelope.requestId}`);
		expect(controller.getView().client.pendingSubmissions[envelope.requestId]?.state).toBe("duplicate");
		expect(gateway.submitted).toHaveLength(1);
	});

	it("does not resolve permission when the request is not pending", async () => {
		const gateway = createFakeGateway();
		const controller = new MetaWorkTuiController({ gateway });
		await controller.start();
		stateWithConversation(controller);
		await controller.attachConversation("conv_1", false);
		gateway.emit(event("conv_1", 1, "turn_started", { commandKind: "user_message" }, { turnId: "turn_1" }));
		controller['handleEvent'](event("conv_1", 2, "trace_delta", {
			turnId: "turn_1", taskId: "task_1", events: [],
		}, { turnId: "turn_1" }));
		controller['handleEvent'](event("conv_1", 3, "permission_request", { requestId: "perm_1", summary: "写入" }, { turnId: "turn_1" }));
		let snapshotSequence = 0;
		gateway.getTaskView = async () => {
			snapshotSequence += 1;
			gateway.emit(event("connection", snapshotSequence, "task_view_snapshot", {
				queryVersion: "task_view_v1", requestId: `view_${snapshotSequence}`,
				targetConversationId: "conv_1", turnId: "turn_1", taskId: "task_1", asOfSequence: 3,
				subtasks: [], pendingPermission: { requestId: "perm_1", summary: "写入", status: "pending" },
			}));
			return { requestId: `view_${snapshotSequence}`, status: "accepted", conversationId: "conv_1" };
		};

		await controller.resolvePermission("perm_unknown", "approve");
		expect(gateway.submitted).toHaveLength(0);
		expect(controller.getView().operation).toContain("已失效");

		await controller.resolvePermission("perm_1", "approve");
		expect(gateway.submitted.at(-1)!.command).toEqual({
			kind: "permission_resolution",
			requestId: "perm_1",
			resolution: "approve",
		});
		// Admission is not resolution: retain the authoritative pending fact.
		expect(controller.getView().client.conversations.conv_1!.turns.turn_1!.permission?.status).toBe("pending");
		expect(controller.getView().permissionPanelOpen).toBe(false);
		controller.stop();
	});

	it("fails closed when required server capabilities are missing", async () => {
		const gateway = createFakeGateway({ capabilities: [] });
		const controller = new MetaWorkTuiController({
			gateway,
			requiredCapabilities: ["command_completion_v1", "task_view_v1"],
		});
		await controller.start();
		const view = controller.getView();
		expect(view.client.connection).toBe("incompatible");
		expect(view.capabilitiesMissing).toEqual(["command_completion_v1", "task_view_v1"]);
	});

	it("matches completion responses by request id and drops stale/superseded ones", async () => {
		const gateway = createFakeGateway();
		const controller = new MetaWorkTuiController({ gateway, completionDebounceMs: 0 });
		await controller.start();
		stateWithConversation(controller);
		await controller.attachConversation("conv_1", false);

		const pending = controller.requestCompletion("/ta", 3);
		// 等待控制器发出请求并注册 requestId。
		await new Promise(resolve => setTimeout(resolve, 0));
		const requestId = gateway.submitted.at(-1)?.envelope.requestId
			?? controller['getView']().client.completionRequests.conv_1?.requestId;
		const knownRequestId = controller['getView']().client.completionRequests.conv_1?.requestId
			?? requestId!;
		// 旧 requestId 的响应必须被丢弃。
		controller['handleEvent'](event("client_connection_x", 1, "command_completion", {
			queryVersion: "command_completion_v1",
			requestId: "req_stale",
			targetConversationId: "conv_1",
			state: "incomplete",
			suggestions: [{ value: "/stale", label: "/stale", description: "", replacement: { start: 0, end: 3, text: "/stale" } }],
			hint: null,
			error: null,
		}));
		expect(controller.getView().client.completions.conv_1).toBeUndefined();

		controller['handleEvent'](event("client_connection_x", 2, "command_completion", {
			queryVersion: "command_completion_v1",
			requestId: knownRequestId,
			targetConversationId: "conv_1",
			state: "incomplete",
			suggestions: [{ value: "/task", label: "/task", description: "", replacement: { start: 0, end: 3, text: "/task" } }],
			hint: null,
			error: null,
		}));
		await expect(pending).resolves.toMatchObject({ state: "incomplete" });
	});

	it("separates Workspace-scope completion from Conversation-scope completion", async () => {
		const gateway = createFakeGateway();
		const controller = new MetaWorkTuiController({ gateway, completionDebounceMs: 0, completionTimeoutMs: 50 });
		await controller.start();
		await controller.requestCompletion("/wo", 3);
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(gateway.calls.some(call => call === "complete:/wo:workspace")).toBe(true);
	});

	it("validates Conversation ownership before attaching", async () => {
		const gateway = createFakeGateway();
		const controller = new MetaWorkTuiController({ gateway });
		await controller.start();
		stateWithConversation(controller);
		await expect(controller.attachConversation("conv_other")).rejects.toThrow("conversation_not_in_workspace");
	});

	it("requests the read-only task view for the selected turn's task", async () => {
		const gateway = createFakeGateway();
		const controller = new MetaWorkTuiController({ gateway });
		await controller.start();
		stateWithConversation(controller);
		await controller.attachConversation("conv_1", false);
		gateway.emit(event("conv_1", 1, "turn_started", { commandKind: "user_message" }, { turnId: "turn_1" }));
		controller['handleEvent'](event("conv_1", 2, "trace_delta", {
			turnId: "turn_1",
			taskId: "task_1",
			status: "running",
			events: [],
		}, { turnId: "turn_1" }));

		await controller.openTaskPanel();
		expect(gateway.calls).toContain("task_view:conv_1");
		expect(controller.getView().taskPanelOpen).toBe(true);
	});

	it("selects adjacent turns without reopening history and keeps the selection", async () => {
		const gateway = createFakeGateway();
		const controller = new MetaWorkTuiController({ gateway });
		await controller.start();
		stateWithConversation(controller);
		await controller.attachConversation("conv_1", false);
		controller['handleEvent'](event("conv_1", 1, "turn_started", { commandKind: "user_message" }, { turnId: "turn_1" }));
		controller['handleEvent'](event("conv_1", 2, "turn_started", { commandKind: "user_message" }, { turnId: "turn_2" }));

		controller.selectAdjacentTurn(-1);
		expect(controller.getView().selectedTurnId).toBe("turn_1");
		// 新进展不抢占选中项。
		controller['handleEvent'](event("conv_1", 3, "execution_delta", { subtaskId: "sub_1", status: "running" }, { turnId: "turn_2" }));
		expect(controller.getView().selectedTurnId).toBe("turn_1");
	});

	it("normalizes applyGatewayReplay through the shared pipeline on reconnect", async () => {
		const gateway = createFakeGateway({
			replay: {
				lastSequence: 4,
				snapshot: [event("conv_1", 1, "turn_started", { commandKind: "user_message" }, { turnId: "turn_1" })],
				deltas: [event("conv_1", 4, "final_answer", { lines: ["完成"] }, { turnId: "turn_1" })],
			},
		});
		const controller = new MetaWorkTuiController({ gateway });
		await controller.start();
		stateWithConversation(controller);
		await controller.attachConversation("conv_1", false);
		gateway.disconnect();
		await new Promise(resolve => setTimeout(resolve, 5));

		const turn = controller.getView().client.conversations.conv_1!.turns.turn_1!;
		expect(turn.status).toBe("completed");
		expect(turn.answer).toBe("完成");
		expect(controller.getView().client.connection).toBe("ready");
	});

	it("projects the workspace directory snapshot that uses canonicalPath", async () => {
		const gateway = createFakeGateway();
		const controller = new MetaWorkTuiController({ gateway });
		await controller.start();
		controller['handleEvent'](event("workspace_stream", 1, "workspace_directory_snapshot", {
			workspaceId: "ws_1",
			// 服务端 WorkspaceRecord 使用 canonicalPath（不是 path）。
			workspace: { id: "ws_1", canonicalPath: "/repo/workspace-a", displayName: "workspace-a", availability: "available" },
			page: { items: [], nextCursor: null },
		}));
		expect(controller.getView().client.activeWorkspace).toMatchObject({
			id: "ws_1",
			path: "/repo/workspace-a",
			displayName: "workspace-a",
		});
	});

	it("fails closed with an in-UI error when the Server is unreachable", async () => {
		const gateway = createFakeGateway();
		const failing: MetaWorkTuiGatewayPort = {
			...gateway,
			connect: async () => {
				gateway.disconnect();
				throw new Error("connect ENOENT /tmp/missing.sock");
			},
		};
		const controller = new MetaWorkTuiController({ gateway: failing });
		await controller.start();
		const view = controller.getView();
		// 连接失败：closed + 明确提示，不谎称 ready（即便随后收到 disconnect）。
		expect(view.client.connection).toBe("closed");
		expect(view.client.notices.at(-1)?.kind).toBe("error");
		expect(view.client.notices.at(-1)?.text).toContain("无法连接 Server");
		expect(view.client.notices.at(-1)?.text).toContain("metawork server start");
	});

	it("starts from an empty client state with the reducer as the only truth", async () => {
		const gateway = createFakeGateway();
		const controller = new MetaWorkTuiController({ gateway });
		expect(emptyMetaWorkClientState().notices).toEqual([]);
		await controller.start();
		expect(controller.getView().client.connection).toBe("ready");
		expect(controller.getView().visibleTurns).toEqual([]);
	});
});
