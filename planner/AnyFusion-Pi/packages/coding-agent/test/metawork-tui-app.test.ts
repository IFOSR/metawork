/**
 * MetaWork TUI 应用、编辑器与权限面板交互测试（统一 TUI 设计 §8.4、§8.5、§15.2）。
 */

import { stripVTControlCharacters } from "node:util";
import { ProcessTerminal, type Terminal, TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type {
	GatewayCommand,
	GatewayCommandEnvelope,
	GatewayCommandReceipt,
	GatewayEventEnvelope,
	GatewayScope,
} from "../src/anyfusion/gateway-protocol.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { MetaWorkTuiApp } from "../src/modes/metawork-tui/app.ts";
import { METAWORK_TUI_KEYS, MetaWorkEditor } from "../src/modes/metawork-tui/components/editor.ts";
import { MetaWorkPermissionPanel } from "../src/modes/metawork-tui/components/permission-panel.ts";
import { MetaWorkTuiController, type MetaWorkTuiGatewayPort } from "../src/modes/metawork-tui/controller.ts";
import { createFilePreferencesStore } from "../src/modes/metawork-tui/preferences.ts";

import { ObservationFixture, turn } from "./helpers/observation-fixture.ts";

beforeAll(() => initTheme("dark"));

class FakeTerminal implements Terminal {
	readonly chunks: string[] = [];
	columns = 120;
	rows = 36;
	kittyProtocolActive = false;
	private inputHandler: ((data: string) => void) | null = null;

	start(onInput: (data: string) => void): void {
		this.inputHandler = onInput;
	}

	stop(): void {}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.chunks.push(data);
	}

	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}

	press(data: string): void {
		this.inputHandler?.(data);
	}

	output(): string {
		return stripVTControlCharacters(this.chunks.join(""));
	}
}

function fakeGateway() {
	let counter = 0;
	let listener: (event: GatewayEventEnvelope) => void = () => undefined;
	const observed = new ObservationFixture();
	const gateway: MetaWorkTuiGatewayPort = {
		followConversation: async (id, callback) => observed.follow(id, callback),
		queryConversationResource: async () => ({ turns: [], nextCursor: null }),
		applyConversationPage: (id, page) => observed.set(id, page),
		connect: async () => undefined,
		onEvent: (next) => {
			listener = next;
			return () => undefined;
		},
		createConversation: async (): Promise<GatewayCommandReceipt> => ({
			requestId: "r",
			status: "accepted",
			conversationId: "conv_1",
		}),
		listWorkspaceConversations: async (): Promise<GatewayCommandReceipt> => ({
			requestId: "r",
			status: "accepted",
			conversationId: null,
		}),
		completeCommand: async (): Promise<GatewayCommandReceipt> => ({
			requestId: "r",
			status: "accepted",
			conversationId: null,
		}),
		getTaskView: async (conversationId): Promise<GatewayCommandReceipt> => ({
			requestId: "r",
			status: "accepted",
			conversationId,
		}),
		buildEnvelope: async (command: GatewayCommand, scope: GatewayScope): Promise<GatewayCommandEnvelope> => {
			counter += 1;
			return {
				protocolVersion: 2,
				requestId: `req_${counter}`,
				idempotencyKey: `idem_${counter}`,
				connectionId: "tui_1",
				scope,
				command,
				clientCapabilities: ["trace_v1"],
			};
		},
		submitEnvelope: async (envelope): Promise<GatewayCommandReceipt> => ({
			requestId: envelope.requestId,
			status: "accepted",
			conversationId: "conv_1",
		}),
		resubmitEnvelope: async (envelope): Promise<GatewayCommandReceipt> => ({
			requestId: envelope.requestId,
			status: "duplicate",
			conversationId: "conv_1",
		}),
		initializeWorkspace: async (): Promise<GatewayCommandReceipt> => ({
			requestId: "r",
			status: "accepted",
			conversationId: null,
		}),
		serverCapabilities: ["command_completion_v1", "task_view_v1"],
		dispose: () => undefined,
	};
	return {
		gateway,
		observed,
		emit: (event: GatewayEventEnvelope) => {
			if (!observed.scenario(event)) listener(event);
		},
	};
}

function event(sequence: number, kind: string, payload: unknown, turnId: string | null = null): GatewayEventEnvelope {
	return {
		protocolVersion: 2,
		eventId: `evt_${sequence}`,
		sequence,
		accountId: "local-default",
		conversationId: "conv_1",
		requestId: null,
		turnId,
		kind: kind as GatewayEventEnvelope["kind"],
		payload,
		occurredAt: "2026-09-19T00:00:00.000Z",
	};
}

describe("metawork-tui editor key semantics", () => {
	function createEditor() {
		const ui = new TUI(new FakeTerminal());
		const editor = new MetaWorkEditor(ui, { borderColor: (text) => text, selectList: {} as never });
		const actions = {
			onExit: vi.fn(),
			onEscape: vi.fn(() => true),
			onHelp: vi.fn(),
			onPermissionPanel: vi.fn(),
			onLoadOlderHistory: vi.fn(),
			onTaskPanel: vi.fn(),
			onSelectPreviousTurn: vi.fn(),
			onSelectNextTurn: vi.fn(),
			onToggleExpanded: vi.fn(),
		};
		editor.setActions(actions);
		return { editor, actions };
	}

	it("exits the client on Ctrl+C and Ctrl+D without touching business state", () => {
		const { editor, actions } = createEditor();
		editor.handleInput(METAWORK_TUI_KEYS.ctrlC);
		editor.handleInput(METAWORK_TUI_KEYS.ctrlD);
		expect(actions.onExit).toHaveBeenCalledTimes(2);
		expect(actions.onToggleExpanded).not.toHaveBeenCalled();
	});

	it("maps function keys to UI actions and keeps escape for overlays", () => {
		const { editor, actions } = createEditor();
		for (const key of METAWORK_TUI_KEYS.help) editor.handleInput(key);
		for (const key of METAWORK_TUI_KEYS.taskPanel) editor.handleInput(key);
		editor.handleInput(METAWORK_TUI_KEYS.toggleExpanded[0]);
		editor.handleInput("\x1b");
		expect(actions.onHelp).toHaveBeenCalledTimes(2);
		expect(actions.onTaskPanel).toHaveBeenCalledTimes(1);
		expect(actions.onToggleExpanded).toHaveBeenCalledTimes(1);
		expect(actions.onEscape).toHaveBeenCalledTimes(1);
	});

	it("never turns plain letters into business commands", () => {
		const { editor, actions } = createEditor();
		for (const char of ["a", "x", "c"]) editor.handleInput(char);
		expect(editor.getText()).toBe("axc");
		expect(actions.onExit).not.toHaveBeenCalled();
		expect(actions.onToggleExpanded).not.toHaveBeenCalled();
	});
});

describe("metawork-tui permission panel", () => {
	it("requires focus, pending status and never fires on letter input outside it", () => {
		const terminal = new FakeTerminal();
		const ui = new TUI(terminal);
		const approve = vi.fn();
		const deny = vi.fn();
		const close = vi.fn();
		const panel = new MetaWorkPermissionPanel(
			ui,
			{ requestId: "perm_1", summary: "写入文件", status: "pending" },
			{ approve, deny, close },
		);

		// 未聚焦时字母输入不产生业务命令。
		panel.handleInput("a");
		panel.handleInput("x");
		expect(approve).not.toHaveBeenCalled();
		expect(deny).not.toHaveBeenCalled();

		panel.focused = true;
		panel.handleInput("a");
		expect(approve).toHaveBeenCalledWith("perm_1");
		panel.handleInput("x");
		expect(deny).toHaveBeenCalledWith("perm_1");
		panel.handleInput("\x1b");
		expect(close).toHaveBeenCalledTimes(1);

		// 已提交决议后旧操作被禁用。
		panel.markSubmitting();
		panel.handleInput("a");
		expect(approve).toHaveBeenCalledTimes(1);
	});
});

describe("metawork-tui app startup", () => {
	it("enables wheel reporting only during the app lifetime and consumes clicks without typing", () => {
		const terminal = new FakeTerminal();
		const ui = new TUI(terminal);
		const { gateway } = fakeGateway();
		const controller = new MetaWorkTuiController({ gateway });
		const app = new MetaWorkTuiApp({
			ui,
			controller,
			preferences: createFilePreferencesStore("/tmp/unused-prefs.json"),
			onExit: () => undefined,
		});
		try {
			app.start();
			expect(terminal.chunks.join("")).toContain("\x1b[?1000h\x1b[?1006h");
			terminal.press("\x1b[<0;10;8M");
			terminal.press("\x1b[<0;10;8m");
			expect(app["editor"].getText()).toBe("");
			app.stop();
			expect(terminal.chunks.join("")).toContain("\x1b[?1006l\x1b[?1000l");
		} finally {
			ui.stop();
		}
	});

	it.each([
		["Kitty press/repeat", "\x1b[5;1:2~", "\x1b[6;1:2~"],
		["Kitty keypad", "\x1b[57421u", "\x1b[57422u"],
		["shift paging", "\x1b[5;2~", "\x1b[6;2~"],
		["mouse wheel", "\x1b[<64;10;8M", "\x1b[<65;10;8M"],
	])("scrolls a completed result with %s without changing the draft or submitting work", async (_name, up, down) => {
		const terminal = new FakeTerminal();
		terminal.rows = 24;
		const ui = new TUI(terminal);
		const { gateway, emit } = fakeGateway();
		const submit = vi.spyOn(gateway, "submitEnvelope");
		let app: MetaWorkTuiApp;
		const controller = new MetaWorkTuiController({ gateway, onStateChange: (view) => app?.handleView(view) });
		app = new MetaWorkTuiApp({
			ui,
			controller,
			preferences: createFilePreferencesStore("/tmp/unused-prefs.json"),
			onExit: () => undefined,
		});
		try {
			app.start();
			await controller.start();
			await controller.attachConversation("conv_1", false);
			emit(event(1, "turn_started", { commandKind: "user_message" }, "turn_1"));
			emit(event(2, "final_answer", { lines: Array.from({ length: 80 }, (_, i) => `ROW_${i}\n`) }, "turn_1"));
			terminal.press("draft");
			expect(app["root"].render(120).join("\n")).toContain("ROW_79");
			for (let i = 0; i < 80; i += 1) terminal.press(up);
			const top = app["root"].render(120).join("\n");
			expect(top).toContain("ROW_0");
			expect(top).not.toContain("ROW_79");
			app.handleView(controller.getView());
			expect(app["root"].render(120).join("\n")).toBe(top);
			terminal.press("\x1b[5;1:3~"); // A release must not scroll again.
			expect(app["root"].render(120).join("\n")).toBe(top);
			for (let i = 0; i < 80; i += 1) terminal.press(down);
			expect(app["root"].render(120).join("\n")).toContain("ROW_79");
			expect(controller.getView().client.ui.drafts.conv_1).toBe("draft");
			expect(submit).not.toHaveBeenCalled();
		} finally {
			controller.stop();
			ui.stop();
		}
	});

	it.each([80, 120])(
		"keeps a bounded viewport at %i columns and pages without losing editor focus",
		async (columns) => {
			const terminal = new FakeTerminal();
			terminal.columns = columns;
			terminal.rows = 24;
			const ui = new TUI(terminal);
			const { gateway, emit } = fakeGateway();
			let app: MetaWorkTuiApp;
			const controller = new MetaWorkTuiController({ gateway, onStateChange: (view) => app?.handleView(view) });
			app = new MetaWorkTuiApp({
				ui,
				controller,
				preferences: createFilePreferencesStore("/tmp/unused-prefs.json"),
				onExit: () => undefined,
			});
			try {
				app.start();
				await controller.start();
				await controller.attachConversation("conv_1", false);
				emit(event(1, "turn_started", { commandKind: "user_message" }, "turn_1"));
				emit(event(2, "final_answer", { lines: Array.from({ length: 80 }, (_, i) => `ROW_${i}\n`) }, "turn_1"));
				const bottom = app["root"].render(columns);
				expect(bottom.length).toBeLessThanOrEqual(24);
				expect(bottom.join("\n")).toContain("ROW_79");
				if (columns === 120) expect(bottom.join("\n")).toContain("Task Dashboard");
				for (let i = 0; i < 20; i += 1) terminal.press("\x1b[5~");
				const top = app["root"].render(columns);
				expect(top.join("\n")).toContain("ROW_0");
				terminal.press("draft");
				expect(controller.getView().client.ui.drafts.conv_1).toBe("draft");
			} finally {
				controller.stop();
				ui.stop();
			}
		},
	);

	it("opens the directory from input and attaches the selected Conversation with Enter", async () => {
		const terminal = new FakeTerminal();
		const ui = new TUI(terminal);
		const { gateway, emit } = fakeGateway();
		const attach = vi.spyOn(gateway, "followConversation");
		let app: MetaWorkTuiApp;
		const controller = new MetaWorkTuiController({ gateway, onStateChange: (view) => app?.handleView(view) });
		app = new MetaWorkTuiApp({
			ui,
			controller,
			preferences: createFilePreferencesStore("/tmp/unused-prefs.json"),
			onExit: () => undefined,
		});
		try {
			app.start();
			await controller.start();
			emit(
				event(1, "workspace_directory_snapshot", {
					workspaceId: "ws_1",
					workspace: { id: "ws_1", path: "/repo" },
					page: {
						items: [
							{
								conversationId: "conv_1",
								workspaceId: "ws_1",
								title: "Existing conversation",
								preview: "",
								updatedAt: "2026-09-20T00:00:00Z",
							},
						],
					},
				}),
			);
			await controller.submit("/conversations");
			terminal.press("\r");
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(attach).toHaveBeenCalledWith("conv_1", expect.any(Function));
			expect(controller.getView().conversationSelectorOpen).toBe(false);
		} finally {
			controller.stop();
			ui.stop();
		}
	});

	it("queries Task facts through the real F6 action", async () => {
		const terminal = new FakeTerminal();
		terminal.columns = 80;
		const ui = new TUI(terminal);
		const { gateway, emit } = fakeGateway();
		const query = vi.spyOn(gateway, "getTaskView");
		let app: MetaWorkTuiApp;
		const controller = new MetaWorkTuiController({ gateway, onStateChange: (view) => app?.handleView(view) });
		app = new MetaWorkTuiApp({
			ui,
			controller,
			preferences: createFilePreferencesStore("/tmp/unused-prefs.json"),
			onExit: () => undefined,
		});
		try {
			app.start();
			await controller.start();
			await controller.attachConversation("conv_1", false);
			emit(event(1, "turn_started", { commandKind: "user_message" }, "turn_1"));
			emit(event(2, "trace_delta", { turnId: "turn_1", taskId: "task_1", events: [] }, "turn_1"));
			terminal.press(METAWORK_TUI_KEYS.taskPanel[0]);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(query).toHaveBeenCalledWith("conv_1", "turn_1", "task_1");
		} finally {
			controller.stop();
			ui.stop();
		}
	});

	it("renders the single TUI tree with header, conversation and editor", async () => {
		const terminal = new FakeTerminal();
		const ui = new TUI(terminal);
		const { gateway, emit } = fakeGateway();
		let app: MetaWorkTuiApp | null = null;
		const controller = new MetaWorkTuiController({
			gateway,
			requiredCapabilities: ["command_completion_v1", "task_view_v1"],
			onStateChange: (view) => app?.handleView(view),
			onExit: () => undefined,
		});
		app = new MetaWorkTuiApp({
			ui,
			controller,
			preferences: createFilePreferencesStore("/tmp/does-not-exist/metawork-prefs.json"),
			onExit: () => undefined,
		});
		try {
			app.start();
			await controller.start();
			app.handleView(controller.getView());
			emit(
				event(1, "workspace_directory_snapshot", {
					workspaceId: "ws_1",
					workspace: { id: "ws_1", path: "/repo", displayName: "repo", availability: "available" },
					page: {
						items: [
							{
								conversationId: "conv_1",
								workspaceId: "ws_1",
								title: "会话一",
								preview: "",
								updatedAt: "2026-09-19T00:00:00.000Z",
							},
						],
						nextCursor: null,
					},
				}),
			);
			await controller.attachConversation("conv_1", false);
			emit(event(2, "turn_started", { commandKind: "user_message" }, "turn_1"));
			emit(event(3, "final_answer", { lines: ["已完成分析"] }, "turn_1"));
			await new Promise((resolve) => setTimeout(resolve, 60));

			const output = terminal.output();
			expect(output).toContain("MetaWork");
			expect(output).toContain("repo");
			expect(output).toContain("已完成分析");
			expect(controller.getView().client.connection).toBe("ready");
		} finally {
			controller.stop();
			ui.stop();
		}
	});

	it("keeps ProcessTerminal importable for production wiring", () => {
		expect(typeof ProcessTerminal).toBe("function");
	});
});

describe("workspace task switching through the terminal", () => {
	it.each([80, 120])(
		"selects parallel, queued and old-Turn tasks on a %i-column terminal",
		async (columns) => {
			const terminal = new FakeTerminal();
			terminal.columns = columns;
			const ui = new TUI(terminal);
			const { gateway, observed, emit } = fakeGateway();
			const tasks = [
				{ conversationId: "a", taskId: "a1", phase: "executing" },
				{ conversationId: "b", taskId: "b1", phase: "executing" },
				{ conversationId: "b", taskId: "b2", phase: "queued" },
				{ conversationId: "c", taskId: "c1", phase: "blocked" },
			];
			const activity = (id: string) => ({
				tasks: tasks
					.filter((task) => task.conversationId === id)
					.map((task) => ({
						...task,
						title: `任务 ${task.taskId}`,
						executionGeneration: "g",
						explanation: "",
						canCancel: true,
					})),
				nextCursor: null,
				pendingInteractions: [],
			});
			for (const id of ["a", "b", "c"])
				observed.set(id, {
					turns: [
						{
							...turn(id, `recent_${id}`),
							taskId: id === "b" ? "b2" : `${id}1`,
							userInput: `提问 ${id}`,
							answer: `当前进展 ${id}`,
						},
					],
					activity: activity(id),
				});
			const read = vi.spyOn(gateway, "queryConversationResource").mockImplementation(async (command) => {
				if (command.resource === "activity") return activity(command.conversationId);
				if (command.resource === "locate")
					return {
						turns: [
							{
								...turn(command.conversationId, `original_${command.taskId}`),
								taskId: command.taskId!,
								answer: `执行过程 ${command.taskId}`,
							},
						],
						nextCursor: null,
					};
				return {};
			});
			const submit = vi.spyOn(gateway, "submitEnvelope");
			let app: MetaWorkTuiApp;
			const controller = new MetaWorkTuiController({ gateway, onStateChange: (view) => app?.handleView(view) });
			app = new MetaWorkTuiApp({
				ui,
				controller,
				preferences: createFilePreferencesStore("/tmp/unused-task-prefs"),
				onExit: () => undefined,
			});
			try {
				app.start();
				await controller.start();
				emit(
					event(1, "workspace_directory_snapshot", {
						workspaceId: "ws",
						workspace: { id: "ws", path: "/repo" },
						page: {
							items: ["a", "b", "c"].map((id) => ({
								conversationId: id,
								workspaceId: "ws",
								title: `会话 ${id}`,
								preview: "",
								updatedAt: "2026-10-03T00:00:00Z",
								activity: { state: "executing", taskId: `${id}1`, updatedAt: "" },
							})),
							nextCursor: null,
						},
					}),
				);
				await controller.attachConversation("a");
				terminal.press("保留草稿");
				await vi.waitFor(() => expect(controller.getView().taskOverview.rows).toHaveLength(4), { timeout: 5_000 });
				terminal.press(METAWORK_TUI_KEYS.taskPanel[0]);
				await new Promise((resolve) => setTimeout(resolve, 30));
				expect(terminal.output()).toContain("执行中 2");
				terminal.press("\x1b[B");
				terminal.press("\r");
				await vi.waitFor(() => expect(controller.getView().selectedTurnId).toBe("original_b1"));
				expect(controller.getView().conversationId).toBe("b");
				expect(controller.getView().selectedTurn?.answer).toBe("执行过程 b1");
				expect(controller.getView().client.ui.drafts.a).toBe("保留草稿");
				expect(controller.getView().taskPanelOpen).toBe(false);
				terminal.press("另一个草稿");
				terminal.press(METAWORK_TUI_KEYS.taskPanel[0]);
				await new Promise((resolve) => setTimeout(resolve, 30));
				terminal.press("\x1b[B");
				terminal.press("\r");
				await vi.waitFor(() => expect(controller.getView().selectedTurnId).toBe("original_b2"));
				expect(controller.getView().selectedTurn?.taskId).toBe("b2");
				// A background status update must not steal the selected Task or draft.
				tasks[0]!.phase = "blocked";
				observed.set("b", { activity: activity("b") });
				await vi.waitFor(() => expect(controller.getView().taskOverview.rows[0]?.phase).toBe("blocked"), {
					timeout: 5_000,
				});
				expect(controller.getView().selectedTurnId).toBe("original_b2");
				expect(controller.getView().client.ui.drafts.b).toBe("另一个草稿");
				terminal.press(METAWORK_TUI_KEYS.taskPanel[0]);
				await new Promise((resolve) => setTimeout(resolve, 30));
				terminal.press("\x1b[A");
				terminal.press("\x1b[A");
				terminal.press("\r");
				await vi.waitFor(() => expect(controller.getView().selectedTurnId).toBe("original_a1"));
				expect(controller.getView().client.ui.drafts.a).toBe("保留草稿");
				expect(read).toHaveBeenCalledWith(
					expect.objectContaining({ resource: "locate", taskId: "b1", conversationId: "b" }),
				);
				if (columns === 120) {
					await new Promise((resolve) => setTimeout(resolve, 30));
					terminal.press("\x1b[<0;119;10M");
					await vi.waitFor(() => expect(controller.getView().selectedTurnId).toBe("original_b1"));
				}
				await controller.attachConversation("b");
				const normalRead = read.getMockImplementation()!;
				let release!: (value: unknown) => void;
				read.mockImplementation((command) =>
					command.resource === "locate" && command.taskId === "b1"
						? new Promise((resolve) => {
								release = resolve;
							})
						: normalRead(command),
				);
				const firstRow = controller.getView().taskOverview.rows.find((row) => row.taskId === "b1")!;
				const secondRow = controller.getView().taskOverview.rows.find((row) => row.taskId === "b2")!;
				const stale = controller.openOverviewTask(firstRow);
				await controller.openOverviewTask(secondRow);
				release({ turns: [{ ...turn("b", "stale_b1"), taskId: "b1" }], nextCursor: null });
				await stale;
				expect(controller.getView().selectedTurnId).toBe("original_b2");
				expect(submit).not.toHaveBeenCalled();
			} finally {
				controller.stop();
				app.stop();
				ui.stop();
			}
		},
		15_000,
	);
});
