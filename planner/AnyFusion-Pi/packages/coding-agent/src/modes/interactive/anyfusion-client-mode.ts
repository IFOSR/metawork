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
	renderConversation,
	type ClientConnectionState,
} from "./metawork-client-view.ts";

interface GatewayClientPort {
	onEvent(listener: (event: GatewayEventEnvelope) => void): () => void;
	onDisconnect?(listener: () => void): () => void;
	resume(conversationId: string): Promise<GatewayReplay>;
	createConversation?(): Promise<string>;
	submitUserInput(text: string, conversation: ConversationSelection): Promise<GatewayCommandReceipt>;
	submitSlashCommand(text: string, conversation: ConversationSelection): Promise<GatewayCommandReceipt>;
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
	showError(message: string): void;
}

export class AnyFusionClientModeController {
	private readonly deps: {
		gateway: GatewayClientPort;
		conversationId?: string;
		workspaceHint?: string;
		view: AnyFusionClientModeView;
	};
	private selection: ConversationSelection;
	private conversationId: string | undefined;
	private unsubscribe: (() => void) | null = null;
	private disconnectUnsubscribe: (() => void) | null = null;
	private pendingPermissionRequestId: string | null = null;
	private currentTurnId: string | null = null;

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
			: { mode: "new" };
	}

	async start(): Promise<void> {
		this.deps.view.setConnectionState("connecting");
		this.disconnectUnsubscribe = this.deps.gateway.onDisconnect?.(() => {
			this.deps.view.setConnectionState("reconnecting");
		}) ?? null;
		this.unsubscribe = this.deps.gateway.onEvent((event) => {
			if (event.turnId) this.currentTurnId = event.turnId;
			if (event.kind === "permission_request") {
				const payload = event.payload as { requestId?: unknown };
				if (typeof payload.requestId === "string") {
					this.pendingPermissionRequestId = payload.requestId;
				}
			}
			this.deps.view.appendGatewayEvent(event);
		});
		if (this.conversationId) {
			const replay = await this.deps.gateway.resume(this.conversationId);
			for (const event of [...replay.snapshot, ...replay.deltas].sort((left, right) => left.sequence - right.sequence)) {
				this.deps.view.appendGatewayEvent(event);
			}
		} else if (!this.deps.gateway.createConversation) {
			throw new Error("Gateway client cannot create a Conversation");
		} else {
			this.conversationId = await this.deps.gateway.createConversation();
			this.selection = { mode: "attach", conversationId: this.conversationId };
			const workspaceHint = this.deps.workspaceHint?.trim();
			if (workspaceHint) {
				const receipt = await this.deps.gateway.submitSlashCommand(
					`/workspace ${workspaceHint}`,
					this.selection,
				);
				if (receipt.status === "rejected") {
					this.deps.view.showError(
						`默认 Workspace 设置失败：${receipt.reason ?? "Gateway rejected the command"}。`
							+ " 请使用 /workspace /absolute/path 手动设置。",
					);
				}
			}
		}
		this.deps.view.setConnectionState("connected");
	}

	async submit(text: string): Promise<void> {
		const input = text.trim();
		if (!input) return;
		this.deps.view.appendUserInput(input);
		let receipt: GatewayCommandReceipt;
		if ((input === "/approve" || input === "a") && this.pendingPermissionRequestId) {
			receipt = await this.deps.gateway.submitPermissionResolution(
				this.pendingPermissionRequestId,
				input === "/approve" ? "approve" : "deny",
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
			this.deps.view.showError(receipt.reason ?? "Gateway rejected the command");
		}
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
	private readonly statusText = new Text("", 1, 0);

	constructor(
		ui: TUI,
		conversationId: string | undefined,
		socketPath: string,
		editor: Editor,
	) {
		this.ui = ui;
		this.conversationId = conversationId ?? "new";
		const editorContainer = new Container();
		editorContainer.addChild(
			new Text(
				theme.fg("dim", "输入 /approve 或 /deny 处理权限请求，/exit 退出"),
				1,
				0,
			),
		);
		editorContainer.addChild(editor);
		ui.addChild(this.timelineText);
		ui.addChild(this.statusText);
		ui.addChild(editorContainer);
	}

	setConnectionState(state: ClientConnectionState): void {
		this.connectionState = state;
		this.statusText.setText(theme.fg(
			state === "connected" ? "success" : state === "offline" || state === "closed" ? "warning" : "muted",
			`${state} · 输入 /help 查看命令`,
		));
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
		this.refreshView();
	}

	showError(message: string): void {
		this.model = {
			...this.model,
			notices: [...this.model.notices, { kind: "error" as const, text: message }].slice(-20),
		};
		this.refreshView();
	}

	private refreshView(): void {
		const rendered = renderConversation(this.model, this.userMessages, this.connectionState, 120);
		this.timelineText.setText(rendered);
		this.ui.requestRender();
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
