import { describe, expect, it, vi } from "vitest";
import {
	AnyFusionClientModeController,
	formatClientError,
	type AnyFusionClientModeView,
} from "../src/modes/interactive/anyfusion-client-mode.ts";
import type { GatewayEventEnvelope } from "../src/anyfusion/gateway-protocol.ts";

function fixture(options: {
	conversationId?: string;
	workspaceHint?: string;
} = { conversationId: "conv_native" }) {
	let listener: ((event: GatewayEventEnvelope) => void) | undefined;
	let selectorActions: Parameters<AnyFusionClientModeView["showConversationSelector"]>[0] | undefined;
	const gateway = {
		connect: vi.fn(async () => undefined),
		onEvent: vi.fn((next: (event: GatewayEventEnvelope) => void) => {
			listener = next;
			return () => undefined;
		}),
		resume: vi.fn(async () => ({ lastSequence: 3, snapshot: [], deltas: [] })),
		createConversation: vi.fn(async () => ({
			requestId: "req_create",
			status: "accepted" as const,
			conversationId: "conv_new",
			workspaceId: "workspace_repo",
		})),
		attachConversation: vi.fn(async (conversationId: string) => ({
			requestId: "req_attach",
			status: "accepted" as const,
			conversationId,
		})),
		listWorkspaceConversations: vi.fn(async () => ({
			requestId: "req_list",
			status: "accepted" as const,
			conversationId: null,
			workspaceId: "workspace_repo",
		})),
		submitUserInput: vi.fn(async () => ({
			requestId: "req_1",
			status: "accepted" as const,
			conversationId: "conv_native",
		})),
		submitSlashCommand: vi.fn(async () => ({
			requestId: "req_2",
			status: "accepted" as const,
			conversationId: "conv_native",
		})),
		initializeWorkspace: vi.fn(async () => ({
			requestId: "req_workspace",
			status: "accepted" as const,
			conversationId: null,
			workspaceId: "workspace_repo",
		})),
		submitPermissionResolution: vi.fn(async () => ({
			requestId: "req_3",
			status: "accepted" as const,
			conversationId: "conv_native",
		})),
	};
	const view: AnyFusionClientModeView = {
		setConnectionState: vi.fn(),
		appendUserInput: vi.fn(),
		appendGatewayEvent: vi.fn(),
		showConversationSelector: vi.fn(actions => {
			selectorActions = actions;
		}),
		hideConversationSelector: vi.fn(),
		focusEditor: vi.fn(),
		showError: vi.fn(),
	};
	const controller = new AnyFusionClientModeController({
		gateway,
		conversationId: options.conversationId,
		workspaceHint: options.workspaceHint,
		view,
	});
	return {
		controller,
		gateway,
		view,
		publish: (event: GatewayEventEnvelope) => listener?.(event),
		selectorActions: () => selectorActions,
	};
}

describe("AnyFusionClientModeController", () => {
	it("opens the Workspace home without creating a Conversation", async () => {
		const { controller, gateway, view } = fixture({
			conversationId: undefined,
			workspaceHint: "/repo-a",
		});

		await controller.start();

		expect(gateway.createConversation).not.toHaveBeenCalled();
		expect(gateway.initializeWorkspace).toHaveBeenCalledWith(
			"/workspace /repo-a",
		);
		expect(gateway.listWorkspaceConversations).toHaveBeenCalledWith(
			"workspace_repo",
			undefined,
		);
		expect(view.showConversationSelector).toHaveBeenCalledOnce();
		expect(gateway.submitSlashCommand).not.toHaveBeenCalled();
		expect(gateway.resume).not.toHaveBeenCalled();
	});

	it("never applies the startup Workspace when attaching an existing Conversation", async () => {
		const { controller, gateway } = fixture({
			conversationId: "conv_existing",
			workspaceHint: "/repo-b",
		});

		await controller.start();

		expect(gateway.resume).toHaveBeenCalledWith("conv_existing");
		expect(gateway.initializeWorkspace).not.toHaveBeenCalled();
	});

	it("keeps the Client connected and prompts for a manual Workspace when defaulting is rejected", async () => {
		const { controller, gateway, view } = fixture({
			conversationId: undefined,
			workspaceHint: "/repo-a",
		});
		gateway.initializeWorkspace.mockResolvedValueOnce({
			requestId: "req_workspace",
			status: "rejected",
			conversationId: null,
			reason: "workspace_unauthorized",
		});

		await controller.start();

		expect(view.showError).toHaveBeenCalledWith(expect.stringContaining("/workspace /absolute/path"));
		expect(view.setConnectionState).toHaveBeenLastCalledWith("connected");
	});

	it("submits raw editor input through Gateway without a semantic AgentSession", async () => {
		const { controller, gateway, view } = fixture();
		await controller.start();
		await controller.submit("分析这个需求");

		expect(gateway.resume).toHaveBeenCalledWith("conv_native");
		expect(gateway.submitUserInput).toHaveBeenCalledWith(
			"分析这个需求",
			{ mode: "attach", conversationId: "conv_native" },
		);
		expect(view.appendUserInput).toHaveBeenCalledWith("分析这个需求");
	});

	it("routes slash commands and renders streamed Gateway events", async () => {
		const { controller, gateway, view, publish } = fixture();
		await controller.start();
		await controller.submit("/task list");
		const event: GatewayEventEnvelope = {
			protocolVersion: 2,
			eventId: "event_trace",
			sequence: 4,
			accountId: "local-default",
			conversationId: "conv_native",
			requestId: "req_2",
			turnId: "turn_1",
			kind: "trace_delta",
			payload: { events: [{ phase: "planner", message: "Planner parsed intent" }] },
			occurredAt: "2026-08-19T00:00:00.000Z",
		};
		publish(event);

		expect(gateway.submitSlashCommand).toHaveBeenCalledWith(
			"/task list",
			{ mode: "attach", conversationId: "conv_native" },
		);
		expect(view.appendGatewayEvent).toHaveBeenCalledWith(event);
	});

	it("turns the permission selector shorthand into a permission_resolution command", async () => {
		const { controller, gateway, publish } = fixture();
		await controller.start();
		publish({
			protocolVersion: 2,
			eventId: "event_permission",
			sequence: 5,
			accountId: "local-default",
			conversationId: "conv_native",
			requestId: "req_4",
			turnId: "turn_1",
			kind: "permission_request",
			payload: { requestId: "permission_1" },
			occurredAt: "2026-08-19T00:00:00.000Z",
		});

		await controller.submit("/approve");

		expect(gateway.submitPermissionResolution).toHaveBeenCalledWith(
			"permission_1",
			"approve",
			{ mode: "attach", conversationId: "conv_native" },
		);
		expect(gateway.submitSlashCommand).not.toHaveBeenCalled();
	});

	it("creates and attaches a Conversation from the Workspace selector", async () => {
		const { controller, gateway, view, selectorActions } = fixture({
			conversationId: undefined,
			workspaceHint: "/repo-a",
		});
		await controller.start();

		selectorActions()?.create();
		await vi.waitFor(() => expect(gateway.createConversation).toHaveBeenCalledWith("workspace_repo"));
		await vi.waitFor(() => expect(gateway.attachConversation).toHaveBeenCalledWith("conv_new"));
		expect(gateway.resume).toHaveBeenCalledWith("conv_new");
		await vi.waitFor(() => expect(view.focusEditor).toHaveBeenCalled());
	});

	it("restores Editor focus when the Conversation selector is cancelled", async () => {
		const { controller, view, selectorActions } = fixture({
			conversationId: undefined,
			workspaceHint: "/repo-a",
		});
		await controller.start();

		selectorActions()?.cancel();

		expect(view.hideConversationSelector).toHaveBeenCalled();
		expect(view.focusEditor).toHaveBeenCalled();
	});

	it("restores Editor focus after attaching an existing Conversation", async () => {
		const { controller, view, publish, selectorActions } = fixture({
			conversationId: undefined,
			workspaceHint: "/repo-a",
		});
		await controller.start();
		publish({
			protocolVersion: 2,
			eventId: "event_directory_focus",
			sequence: 1,
			accountId: "local-default",
			conversationId: "workspace_directory_workspace_repo",
			requestId: null,
			turnId: null,
			kind: "workspace_directory_snapshot",
			payload: {
				workspaceId: "workspace_repo",
				page: { items: [{ conversationId: "conv_allowed", workspaceId: "workspace_repo" }] },
			},
			occurredAt: "2026-08-28T00:00:00.000Z",
		});

		selectorActions()?.attach("conv_allowed");
		await vi.waitFor(() => expect(view.focusEditor).toHaveBeenCalled());
	});

	it("attaches /conversation only when it is in the current Workspace directory", async () => {
		const { controller, gateway, publish, view } = fixture({
			conversationId: undefined,
			workspaceHint: "/repo-a",
		});
		await controller.start();
		publish({
			protocolVersion: 2,
			eventId: "event_directory",
			sequence: 1,
			accountId: "local-default",
			conversationId: "workspace_directory_workspace_repo",
			requestId: null,
			turnId: null,
			kind: "workspace_directory_snapshot",
			payload: {
				workspaceId: "workspace_repo",
				page: {
					items: [{
						conversationId: "conv_allowed",
						workspaceId: "workspace_repo",
					}],
				},
			},
			occurredAt: "2026-08-28T00:00:00.000Z",
		});

		await controller.submit("/conversation conv_allowed");
		expect(gateway.attachConversation).toHaveBeenCalledWith("conv_allowed");

		await controller.submit("/conversation conv_other");
		expect(view.showError).toHaveBeenCalledWith(
			"该 Conversation 不在当前 Workspace，请使用 /conversations 重新选择。",
		);
		expect(gateway.attachConversation).not.toHaveBeenCalledWith("conv_other");
	});

	it("translates known internal errors into actionable user messages", () => {
		expect(formatClientError("workspace_required")).toContain("/workspace /absolute/path");
		expect(formatClientError("conversation_not_in_workspace")).toContain("当前 Workspace");
		expect(formatClientError("Gateway rejected the command")).toBe("命令未被 Server 接受，请重试。");
		expect(formatClientError("specific safe message")).toBe("specific safe message");
	});
});
