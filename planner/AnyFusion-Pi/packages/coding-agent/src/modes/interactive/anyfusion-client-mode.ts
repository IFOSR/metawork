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

interface GatewayClientPort {
	onEvent(listener: (event: GatewayEventEnvelope) => void): () => void;
	resume(conversationId: string): Promise<GatewayReplay>;
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
	setConnectionState(state: "connecting" | "connected" | "closed"): void;
	appendUserInput(text: string): void;
	appendGatewayEvent(event: GatewayEventEnvelope): void;
	showError(message: string): void;
}

export class AnyFusionClientModeController {
	private readonly deps: {
		gateway: GatewayClientPort;
		conversationId: string;
		view: AnyFusionClientModeView;
	};
	private readonly selection: ConversationSelection;
	private unsubscribe: (() => void) | null = null;
	private pendingPermissionRequestId: string | null = null;

	constructor(
		deps: {
			gateway: GatewayClientPort;
			conversationId: string;
			view: AnyFusionClientModeView;
		},
	) {
		this.deps = deps;
		this.selection = { mode: "attach", conversationId: deps.conversationId };
	}

	async start(): Promise<void> {
		this.deps.view.setConnectionState("connecting");
		this.unsubscribe = this.deps.gateway.onEvent((event) => {
			if (event.kind === "permission_request") {
				const payload = event.payload as { requestId?: unknown };
				if (typeof payload.requestId === "string") {
					this.pendingPermissionRequestId = payload.requestId;
				}
			}
			this.deps.view.appendGatewayEvent(event);
		});
		await this.deps.gateway.resume(this.deps.conversationId);
		this.deps.view.setConnectionState("connected");
	}

	async submit(text: string): Promise<void> {
		const input = text.trim();
		if (!input) return;
		this.deps.view.appendUserInput(input);
		let receipt: GatewayCommandReceipt;
		if ((input === "/approve" || input === "/deny") && this.pendingPermissionRequestId) {
			receipt = await this.deps.gateway.submitPermissionResolution(
				this.pendingPermissionRequestId,
				input === "/approve" ? "approve" : "deny",
				this.selection,
			);
		} else if (input.startsWith("/cancel ")) {
			receipt = await this.deps.gateway.cancelTurn(input.slice(8).trim(), this.selection);
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
		this.deps.gateway.dispose?.();
		this.deps.view.setConnectionState("closed");
	}
}

class TerminalClientView implements AnyFusionClientModeView {
	private readonly ui: TUI;
	private readonly conversationId: string;
	private readonly transcript: string[] = [];
	private readonly trace: string[] = [];
	private readonly transcriptText = new Text("", 1, 0);
	private readonly traceText = new Text("", 1, 0);
	private readonly statusText = new Text("", 1, 0);

	constructor(
		ui: TUI,
		conversationId: string,
		socketPath: string,
		editor: Editor,
	) {
		this.ui = ui;
		this.conversationId = conversationId;
		const header = new Text(
			theme.bold(theme.fg("accent", "◆ ANYFUSION"))
				+ `\n${theme.bold("Gateway Client")} ${theme.fg("dim", `v${VERSION}`)}`
				+ `\n${theme.fg("muted", `${conversationId} · ${socketPath}`)}`,
			1,
			0,
		);
		const editorContainer = new Container();
		editorContainer.addChild(
			new Text(
				theme.fg("dim", "输入 /approve 或 /deny 处理权限请求，/exit 退出"),
				1,
				0,
			),
		);
		editorContainer.addChild(editor);
		ui.addChild(header);
		ui.addChild(new Spacer(1));
		ui.addChild(new Text(theme.bold(theme.fg("accent", "执行轨迹")), 1, 0));
		ui.addChild(this.traceText);
		ui.addChild(new Spacer(1));
		ui.addChild(new Text(theme.bold(theme.fg("accent", "对话")), 1, 0));
		ui.addChild(this.transcriptText);
		ui.addChild(this.statusText);
		ui.addChild(editorContainer);
	}

	setConnectionState(state: "connecting" | "connected" | "closed"): void {
		this.statusText.setText(
			theme.fg(
				state === "connected" ? "success" : state === "closed" ? "warning" : "muted",
				`Gateway ${state} · conversation ${this.conversationId}`,
			),
		);
		this.ui.requestRender();
	}

	appendUserInput(text: string): void {
		this.transcript.push(theme.bold(theme.fg("accent", `You: ${text}`)));
		this.refreshTranscript();
	}

	appendGatewayEvent(event: GatewayEventEnvelope): void {
		const lines = formatGatewayEvent(event);
		if (event.kind === "conversation_snapshot" || event.kind === "final_answer") {
			this.transcript.push(...lines);
			this.refreshTranscript();
			return;
		}
		this.trace.push(...lines);
		this.trace.splice(0, Math.max(0, this.trace.length - 240));
		this.traceText.setText(this.trace.join("\n"));
		this.ui.requestRender();
	}

	showError(message: string): void {
		this.trace.push(theme.fg("error", `Error · ${message}`));
		this.traceText.setText(this.trace.join("\n"));
		this.ui.requestRender();
	}

	private refreshTranscript(): void {
		this.transcript.splice(0, Math.max(0, this.transcript.length - 240));
		this.transcriptText.setText(this.transcript.join("\n"));
		this.ui.requestRender();
	}
}

export async function runAnyFusionClientMode(input: {
	socketPath: string;
	conversationId: string;
}): Promise<void> {
	const ui = new TUI(new ProcessTerminal());
	const editor = new Editor(ui, getEditorTheme(), { paddingX: 1 });
	const transport = new GatewaySocketTransport(input.socketPath);
	const gateway = new GatewayClient(transport);
	const view = new TerminalClientView(ui, input.conversationId, input.socketPath, editor);
	const controller = new AnyFusionClientModeController({
		gateway,
		conversationId: input.conversationId,
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
