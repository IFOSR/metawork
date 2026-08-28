import {
	Container,
	Editor,
	ProcessTerminal,
	Spacer,
	Text,
	TUI,
} from "@earendil-works/pi-tui";
import { GatewayClient } from "../../anyfusion/gateway-client.ts";
import type {
	ConversationSelection,
	GatewayCommandReceipt,
	GatewayEventEnvelope,
	GatewayReplay,
} from "../../anyfusion/gateway-protocol.ts";
import { GatewaySocketTransport } from "../../anyfusion/gateway-socket-transport.ts";
import { VERSION } from "../../config.ts";
import { getEditorTheme, theme } from "./theme/theme.ts";
import {
	rebuildFromReplay,
	reduceGatewayEvent,
	type ConversationViewModel,
} from "./metawork-client-reducer.ts";
import {
	renderConversationViewport,
	type ClientConnectionState,
} from "./metawork-client-view.ts";
import {
	MetaWorkConversationSelector,
	type MetaWorkConversationSelectorActions,
} from "./components/metawork-conversation-selector.ts";

interface GatewayClientPort {
	connect?(): Promise<void>;
	onEvent(listener: (event: GatewayEventEnvelope) => void): () => void;
	onDisconnect?(listener: () => void): () => void;
	resume(conversationId: string): Promise<GatewayReplay>;
	createConversation(workspaceId: string): Promise<GatewayCommandReceipt>;
	attachConversation(conversationId: string): Promise<GatewayCommandReceipt>;
	listWorkspaceConversations(
		workspaceId: string,
		query?: string,
		cursor?: string,
	): Promise<GatewayCommandReceipt>;
	submitUserInput(text: string, conversation: ConversationSelection): Promise<GatewayCommandReceipt>;
	submitSlashCommand(text: string, conversation: ConversationSelection): Promise<GatewayCommandReceipt>;
	initializeWorkspace(text: string): Promise<GatewayCommandReceipt>;
	submitPermissionResolution(
		requestId: string,
		resolution: "approve" | "deny",
		conversation: ConversationSelection,
	): Promise<GatewayCommandReceipt>;
	cancelTurn(turnId: string, conversation: ConversationSelection): Promise<GatewayCommandReceipt>;
	dispose?(): void;
}

export interface AnyFusionClientModeView {
	setConnectionState(state: ClientConnectionState): void;
	appendUserInput(text: string): void;
	appendGatewayEvent(event: GatewayEventEnvelope): void;
	showConversationSelector(actions: MetaWorkConversationSelectorActions): void;
	hideConversationSelector(): void;
	focusEditor(): void;
	showError(message: string): void;
}

export class AnyFusionClientModeController {
	private readonly deps: {
		gateway: GatewayClientPort;
		conversationId?: string;
		workspaceHint?: string;
		view: AnyFusionClientModeView;
	};
	private selection: ConversationSelection | null;
	private conversationId: string | undefined;
	private activeWorkspaceId: string | null = null;
	private unsubscribe: (() => void) | null = null;
	private disconnectUnsubscribe: (() => void) | null = null;
	private pendingPermissionRequestId: string | null = null;
	private currentTurnId: string | null = null;
	private readonly workspaceConversationIds = new Set<string>();

	constructor(
			deps: {
				gateway: GatewayClientPort;
				conversationId?: string;
				workspaceHint?: string;
				view: AnyFusionClientModeView;
			},
		) {
		this.deps = deps;
		this.conversationId = deps.conversationId;
		this.selection = deps.conversationId
			? { mode: "attach", conversationId: deps.conversationId }
			: null;
	}

	async start(): Promise<void> {
		this.deps.view.setConnectionState("connecting");
		this.disconnectUnsubscribe = this.deps.gateway.onDisconnect?.(() => {
			this.deps.view.setConnectionState("reconnecting");
		}) ?? null;
		this.unsubscribe = this.deps.gateway.onEvent((event) => {
			if (event.kind === "workspace_directory_snapshot") {
				const payload = isRecord(event.payload) ? event.payload : {};
				const workspace = isRecord(payload.workspace) ? payload.workspace : {};
				const page = isRecord(payload.page) ? payload.page : {};
				this.workspaceConversationIds.clear();
				for (const item of Array.isArray(page.items) ? page.items : []) {
					if (!isRecord(item)) continue;
					const conversationId = stringValue(item.conversationId, stringValue(item.id));
					if (conversationId) this.workspaceConversationIds.add(conversationId);
				}
				this.activeWorkspaceId = stringValue(
					workspace.id,
					stringValue(payload.workspaceId, this.activeWorkspaceId ?? ""),
				) || this.activeWorkspaceId;
			}
			if (event.kind === "workspace_conversation_upserted") {
				const payload = isRecord(event.payload) ? event.payload : {};
				const conversation = isRecord(payload.conversation) ? payload.conversation : {};
				const conversationId = stringValue(
					conversation.conversationId,
					stringValue(conversation.id),
				);
				if (conversationId) this.workspaceConversationIds.add(conversationId);
			}
			if (event.kind === "workspace_conversation_removed") {
				const payload = isRecord(event.payload) ? event.payload : {};
				this.workspaceConversationIds.delete(stringValue(payload.conversationId));
			}
			if (
				!isWorkspaceDirectoryEvent(event.kind)
				&& event.kind === "conversation_snapshot"
			) {
				this.conversationId = event.conversationId;
				this.selection = { mode: "attach", conversationId: event.conversationId };
			}
			if (event.turnId) this.currentTurnId = event.turnId;
			if (event.kind === "permission_request") {
				const payload = event.payload as { requestId?: unknown };
				if (typeof payload.requestId === "string") {
					this.pendingPermissionRequestId = payload.requestId;
				}
			}
			this.deps.view.appendGatewayEvent(event);
		});
		await this.deps.gateway.connect?.();
		if (this.conversationId) {
			const replay = await this.deps.gateway.resume(this.conversationId);
			for (const event of [...replay.snapshot, ...replay.deltas].sort((left, right) => left.sequence - right.sequence)) {
				this.deps.view.appendGatewayEvent(event);
			}
		} else {
			const workspaceHint = this.deps.workspaceHint?.trim();
			if (workspaceHint) {
				const receipt = await this.deps.gateway.initializeWorkspace(`/workspace ${workspaceHint}`);
				if (receipt.status === "rejected") {
					this.deps.view.showError(
						`默认 Workspace 设置失败：${receipt.reason ?? "Gateway rejected the command"}。`
						+ " 请使用 /workspace /absolute/path 手动设置。",
					);
				} else if (receipt.workspaceId) {
					this.activeWorkspaceId = receipt.workspaceId;
					await this.refreshConversations();
					this.openConversationSelector();
				}
			} else {
				this.deps.view.showError("请先使用 /workspace /absolute/path 选择 Workspace。");
			}
		}
		this.deps.view.setConnectionState("connected");
	}

	async submit(text: string): Promise<void> {
		const input = text.trim();
		if (!input) return;
		if (input === "/conversations") {
			await this.refreshConversations();
			this.openConversationSelector();
			return;
		}
		if (input.startsWith("/conversation ")) {
			try {
				await this.attachConversation(input.slice("/conversation ".length).trim());
			} catch (error) {
				this.deps.view.showError(formatClientError(error));
			}
			return;
		}
		if (input.startsWith("/workspace ")) {
			const receipt = await this.deps.gateway.initializeWorkspace(input);
			if (receipt.status === "rejected" || !receipt.workspaceId) {
				this.deps.view.showError(receipt.reason ?? "Workspace selection failed");
				return;
			}
			this.activeWorkspaceId = receipt.workspaceId;
			await this.refreshConversations();
			this.openConversationSelector();
			return;
		}
		if (!this.selection) {
			this.deps.view.showError("请先从当前 Workspace 新建或选择 Conversation。");
			this.openConversationSelector();
			return;
		}
		this.deps.view.appendUserInput(input);
		let receipt: GatewayCommandReceipt;
		if ((input === "/approve" || input === "a") && this.pendingPermissionRequestId) {
			receipt = await this.deps.gateway.submitPermissionResolution(
				this.pendingPermissionRequestId,
				"approve",
				this.selection,
			);
		} else if ((input === "/deny" || input === "x") && this.pendingPermissionRequestId) {
			receipt = await this.deps.gateway.submitPermissionResolution(
				this.pendingPermissionRequestId,
				"deny",
				this.selection,
			);
		} else if (input.startsWith("/cancel ")) {
			receipt = await this.deps.gateway.cancelTurn(input.slice(8).trim(), this.selection);
		} else if (input === "c" && this.currentTurnId) {
			receipt = await this.deps.gateway.cancelTurn(this.currentTurnId, this.selection);
		} else if (input.startsWith("/")) {
			receipt = await this.deps.gateway.submitSlashCommand(input, this.selection);
		} else {
			receipt = await this.deps.gateway.submitUserInput(input, this.selection);
		}
		if (receipt.status === "rejected") {
			this.deps.view.showError(formatClientError(receipt.reason ?? "Gateway rejected the command"));
		}
	}

	private openConversationSelector(): void {
		if (!this.activeWorkspaceId) {
			this.deps.view.showError("请先使用 /workspace /absolute/path 选择 Workspace。");
			return;
		}
		this.deps.view.showConversationSelector({
			attach: conversationId => {
				void this.attachConversation(conversationId).catch(error => {
					this.deps.view.showError(formatClientError(error));
				});
			},
			create: () => {
				void this.createConversation().catch(error => {
					this.deps.view.showError(formatClientError(error));
				});
			},
			refresh: query => {
				void this.refreshConversations(query).catch(error => {
					this.deps.view.showError(formatClientError(error));
				});
			},
			cancel: () => this.closeConversationSelector(),
		});
	}

	private async refreshConversations(query?: string): Promise<void> {
		if (!this.activeWorkspaceId) return;
		const receipt = await this.deps.gateway.listWorkspaceConversations(
			this.activeWorkspaceId,
			query,
		);
		if (receipt.status === "rejected") {
			throw new Error(receipt.reason ?? "Conversation directory refresh failed");
		}
	}

	private async createConversation(): Promise<void> {
		if (!this.activeWorkspaceId) {
			throw new Error("workspace_required");
		}
		const receipt = await this.deps.gateway.createConversation(this.activeWorkspaceId);
		if (receipt.status === "rejected" || !receipt.conversationId) {
			throw new Error(receipt.reason ?? "Conversation creation failed");
		}
		await this.attachConversation(receipt.conversationId, false);
	}

	private async attachConversation(
		conversationId: string,
		validateCurrentWorkspace = true,
	): Promise<void> {
		if (!conversationId) throw new Error("Conversation ID is required");
		if (validateCurrentWorkspace && !this.activeWorkspaceId) {
			throw new Error("workspace_required");
		}
		if (validateCurrentWorkspace && !this.workspaceConversationIds.has(conversationId)) {
			throw new Error("conversation_not_in_workspace");
		}
		const receipt = await this.deps.gateway.attachConversation(conversationId);
		if (receipt.status === "rejected") {
			throw new Error(receipt.reason ?? "Conversation attach failed");
		}
		this.conversationId = conversationId;
		this.selection = { mode: "attach", conversationId };
		await this.deps.gateway.resume(conversationId);
		this.closeConversationSelector();
	}

	private closeConversationSelector(): void {
		this.deps.view.hideConversationSelector();
		this.deps.view.focusEditor();
	}

	stop(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.disconnectUnsubscribe?.();
		this.disconnectUnsubscribe = null;
		this.deps.gateway.dispose?.();
		this.deps.view.setConnectionState("closed");
	}
}

class TerminalClientView implements AnyFusionClientModeView {
	private readonly ui: TUI;
	private readonly conversationId: string;
	private connectionState: ClientConnectionState = "connecting";
	private model: ConversationViewModel = rebuildFromReplay({
		lastSequence: 0,
		snapshot: [],
		deltas: [],
	});
	private readonly userMessages: string[] = [];
	private readonly timelineText = new Text("", 1, 0);
	private readonly editorContainer: Container;
	private readonly editor: Editor;
	private selector: MetaWorkConversationSelector | null = null;

	constructor(
		ui: TUI,
		conversationId: string | undefined,
		socketPath: string,
		editor: Editor,
	) {
		this.ui = ui;
		this.editor = editor;
		this.conversationId = conversationId ?? "new";
		this.editorContainer = new Container();
		this.editorContainer.addChild(
			new Text(
				theme.fg("dim", "输入 /approve 或 /deny 处理权限请求，/exit 退出"),
				1,
				0,
			),
		);
		this.editorContainer.addChild(editor);
		ui.addChild(this.timelineText);
		ui.addChild(this.editorContainer);
	}

	setConnectionState(state: ClientConnectionState): void {
		this.connectionState = state;
		this.refreshView();
		this.ui.requestRender();
	}

	appendUserInput(text: string): void {
		this.userMessages.push(text);
		this.userMessages.splice(0, Math.max(0, this.userMessages.length - 20));
		this.refreshView();
	}

	appendGatewayEvent(event: GatewayEventEnvelope): void {
		this.model = reduceGatewayEvent(this.model, event);
		this.selector?.update(this.model.activeWorkspace, this.model.conversationSummaries);
		this.refreshView();
	}

	showConversationSelector(actions: MetaWorkConversationSelectorActions): void {
		this.selector = new MetaWorkConversationSelector(
			this.model.activeWorkspace,
			this.model.conversationSummaries,
			actions,
		);
		this.editorContainer.clear();
		this.editorContainer.addChild(this.selector);
		this.ui.setFocus(this.selector);
		this.ui.requestRender();
	}

	hideConversationSelector(): void {
		if (!this.selector) return;
		this.selector = null;
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.ui.requestRender();
	}

	focusEditor(): void {
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	showError(message: string): void {
		this.model = {
			...this.model,
			notices: [...this.model.notices, { kind: "error" as const, text: message }].slice(-20),
		};
		this.refreshView();
	}

	private refreshView(): void {
		const width = this.ui.terminal.columns;
		const maxTimelineLines = Math.max(6, this.ui.terminal.rows - 8);
		const rendered = renderConversationViewport(
			this.model,
			this.userMessages,
			this.connectionState,
			width,
			maxTimelineLines,
		);
		this.timelineText.setText(rendered.join("\n"));
		this.ui.requestRender();
	}
}

export function formatClientError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	switch (message) {
		case "workspace_required":
			return "请先使用 /workspace /absolute/path 选择 Workspace。";
		case "conversation_not_in_workspace":
			return "该 Conversation 不在当前 Workspace，请使用 /conversations 重新选择。";
		case "Gateway rejected the command":
			return "命令未被 Server 接受，请重试。";
		default:
			return message;
	}
}

export async function runAnyFusionClientMode(input: {
	socketPath: string;
	conversationId?: string;
	workspaceHint?: string;
}): Promise<void> {
	const ui = new TUI(new ProcessTerminal());
	const editor = new Editor(ui, getEditorTheme(), { paddingX: 1 });
	const transport = new GatewaySocketTransport(input.socketPath);
	const gateway = new GatewayClient(transport);
	const view = new TerminalClientView(ui, input.conversationId, input.socketPath, editor);
	const controller = new AnyFusionClientModeController({
		gateway,
		conversationId: input.conversationId,
		workspaceHint: input.workspaceHint,
		view,
	});
	let stopped = false;
	let finish!: () => void;
	const completed = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const stop = () => {
		if (stopped) return;
		stopped = true;
		controller.stop();
		transport.close();
		ui.stop();
		finish();
	};
	editor.onSubmit = (text) => {
		if (text.trim() === "/exit") {
			stop();
			return;
		}
		void controller.submit(text).catch((error) => {
			view.showError(error instanceof Error ? error.message : String(error));
		});
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	ui.setFocus(editor);
	ui.start();
	try {
		await controller.start();
		await completed;
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		stop();
	}
}

function formatGatewayEvent(event: GatewayEventEnvelope): string[] {
	const payload = isRecord(event.payload) ? event.payload : {};
	if (event.kind === "conversation_snapshot" || event.kind === "final_answer") {
		const lines = Array.isArray(payload.lines)
			? payload.lines.filter((line): line is string => typeof line === "string")
			: [];
		return lines.length > 0 ? lines : [theme.fg("dim", `${event.kind} · no text output`)];
	}
	if (event.kind === "trace_delta") {
		const events = Array.isArray(payload.events) ? payload.events : [];
		return events.map((item) => {
			if (!isRecord(item)) return theme.fg("dim", "trace · update");
			const phase = stringValue(item.phase, "trace");
			const actor = stringValue(item.actor, "runtime");
			const title = stringValue(item.title, stringValue(item.message, "progress"));
			const summary = stringValue(item.summary);
			return `${theme.fg("accent", `${phase} · ${actor}`)} ${title}${summary ? ` · ${summary}` : ""}`;
		});
	}
	if (event.kind === "task_projection") {
		return [
			`${theme.fg("accent", "task")} · planner ${stringValue(payload.plannerState, "updated")}`
				+ ` · runtime ${stringValue(payload.runtimeState, "updated")}`,
		];
	}
	if (event.kind === "permission_request") {
		return [
			theme.fg(
				"warning",
				`permission · ${stringValue(payload.summary, "approval required")} · use /approve or /deny`,
			),
		];
	}
	if (event.kind === "terminal_error") {
		return [theme.fg("error", `failed · ${stringValue(payload.message, "Gateway execution failed")}`)];
	}
	return [
		`${theme.fg("accent", event.kind.replaceAll("_", " "))}`
			+ `${event.turnId ? theme.fg("dim", ` · ${event.turnId}`) : ""}`,
	];
}

function stageLabel(stage: string): string {
	switch (stage) {
		case "understanding": return "理解";
		case "planning": return "规划";
		case "authorization": return "授权";
		case "execution": return "执行";
		case "verification": return "验证";
		case "delivery": return "交付";
		default: return "等待输入";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
	if (typeof value === "string") return value;
	if (isRecord(value)) {
		return Object.entries(value)
			.slice(0, 4)
			.map(([key, item]) => `${key}=${typeof item === "string" ? item : JSON.stringify(item)}`)
			.join(" ");
	}
	return fallback;
}

function isWorkspaceDirectoryEvent(kind: GatewayEventEnvelope["kind"]): boolean {
	return [
		"workspace_directory_snapshot",
		"workspace_conversation_upserted",
		"workspace_conversation_removed",
		"workspace_activity_changed",
		"workspace_availability_changed",
	].includes(kind);
}
