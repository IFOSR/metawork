/**
 * MetaWork 唯一 TUI 应用装配（统一 TUI 设计 §6、§8）。
 *
 * 组装唯一组件树，绑定编辑器动作到控制器，管理弹层与焦点。
 * 不创建本地 Agent 会话运行时、不执行模型调用、不管理 Pi 会话文件。
 */

import type { Component, Focusable, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { getEditorTheme } from "../interactive/theme/theme.ts";
import { GatewayCompletionProvider } from "./completion-provider.ts";
import { MetaWorkConversationSelector } from "./components/conversation-selector.ts";
import { MetaWorkEditor } from "./components/editor.ts";
import { MetaWorkHelpPanel } from "./components/help-panel.ts";
import { MetaWorkPermissionPanel } from "./components/permission-panel.ts";
import { MetaWorkRoot, type MetaWorkRootState } from "./components/root.ts";
import { MetaWorkTaskDashboard } from "./components/task-dashboard-panel.ts";
import { formatClientError, type MetaWorkTuiController, type MetaWorkTuiViewState } from "./controller.ts";
import type { MetaWorkTuiPreferencesStore } from "./preferences.ts";

export interface MetaWorkTuiAppDeps {
	readonly ui: TUI;
	readonly controller: MetaWorkTuiController;
	readonly preferences: MetaWorkTuiPreferencesStore;
	readonly onExit: () => void;
}

export class MetaWorkTuiApp {
	private readonly ui: TUI;
	private readonly controller: MetaWorkTuiController;
	private readonly preferences: MetaWorkTuiPreferencesStore;
	private readonly onExit: () => void;
	private readonly editor: MetaWorkEditor;
	private readonly root: MetaWorkRoot;
	private readonly dashboard: MetaWorkTaskDashboard;
	private readonly completionProvider: GatewayCompletionProvider;
	private helpOverlay: OverlayHandle | null = null;
	private taskOverlay: OverlayHandle | null = null;
	private permissionOverlay: OverlayHandle | null = null;
	private permissionPanel: MetaWorkPermissionPanel | null = null;
	private lastView: MetaWorkTuiViewState | null = null;
	private conversationOverlay: OverlayHandle | null = null;
	private conversationSelector: MetaWorkConversationSelector | null = null;
	private removeMouseListener: (() => void) | null = null;

	constructor(deps: MetaWorkTuiAppDeps) {
		this.ui = deps.ui;
		this.controller = deps.controller;
		this.preferences = deps.preferences;
		this.onExit = deps.onExit;
		this.editor = new MetaWorkEditor(this.ui, getEditorTheme(), { paddingX: 1 });
		this.dashboard = new MetaWorkTaskDashboard(
			() => this.rootState().task,
			{
				open: (row) => void this.controller.openOverviewTask(row).catch((error) => this.showOperationError(error)),
				close: () => void this.controller.toggleTaskPanel(),
				more: (id) => void this.controller.loadMoreTasks(id),
				first: (id) => void this.controller.firstTasks(id),
				moreConversations: () => void this.controller.loadMoreConversations(),
				refresh: () => void this.controller.refreshConversationDirectory(),
				exit: () => this.onExit(),
				changed: () => this.ui.requestRender(),
			},
			() => Math.max(6, Math.floor(this.ui.terminal.rows * 0.7)),
		);
		this.root = new MetaWorkRoot({
			taskPanel: this.dashboard,
			getState: () => this.rootState(),
			getRows: () => this.ui.terminal.rows,
			editor: this.editor,
		});
		this.completionProvider = new GatewayCompletionProvider(
			{
				requestCompletion: (text, cursor) => this.controller.requestCompletion(text, cursor),
			},
			() => this.controller.getView().conversationId ?? "workspace",
		);
		this.ui.addChild(this.root);
	}

	start(): void {
		this.editor.onSubmit = (text) => {
			void this.controller.submit(text).catch((error) => {
				this.showOperationError(error);
			});
		};
		this.editor.onChange = (text) => this.controller.setDraft(text);
		this.editor.setAutocompleteProvider(this.completionProvider);
		this.editor.setActions({
			onExit: () => this.onExit(),
			onEscape: () => this.closeTopOverlay(),
			onHelp: () => this.controller.toggleHelp(),
			onPermissionPanel: () =>
				void this.controller.togglePermissionPanel().catch((error) => this.showOperationError(error)),
			onLoadOlderHistory: () => void this.controller.loadOlderHistory(),
			onTaskPanel: () => void this.controller.toggleTaskPanel(),
			onSelectPreviousTurn: () => this.controller.selectAdjacentTurn(-1),
			onSelectNextTurn: () => this.controller.selectAdjacentTurn(1),
			onToggleExpanded: () => this.controller.toggleExpanded(),
			onScrollPage: (direction) => {
				this.root.scrollPage(direction);
				this.ui.requestRender();
			},
		});
		this.ui.setFocus(this.editor);
		this.ui.start();
		// The viewport is bounded: wheel input must scroll its content, not the
		// terminal's scrollback. Consume mouse reports so clicks never edit drafts.
		this.removeMouseListener = this.ui.addInputListener((data) => {
			const mouse = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
			if (!mouse) return undefined;
			const button = Number(mouse[1]);
			if (
				mouse[4] === "M" &&
				(button === 64 || button === 65) &&
				!this.helpOverlay &&
				!this.permissionOverlay &&
				!this.conversationOverlay
			) {
				if (this.controller.getView().taskPanelOpen)
					this.dashboard.handleInput(button === 64 ? "\x1b[A" : "\x1b[B");
				else this.root.scrollLines(button === 64 ? -3 : 3);
				this.ui.requestRender();
			}
			if (
				mouse[4] === "M" &&
				button === 0 &&
				!this.taskOverlay &&
				!this.helpOverlay &&
				!this.permissionOverlay &&
				!this.conversationOverlay
			) {
				this.root.clickTask(Number(mouse[2]) - 1, Number(mouse[3]) - 1, this.ui.terminal.columns);
			}
			return { consume: true };
		});
		this.ui.terminal.write("\x1b[?1000h\x1b[?1006h");
	}

	stop(): void {
		if (!this.removeMouseListener) return;
		this.removeMouseListener();
		this.removeMouseListener = null;
		this.ui.terminal.write("\x1b[?1006l\x1b[?1000l");
	}

	handleView(view: MetaWorkTuiViewState): void {
		const previousScope = this.lastView?.conversationId ?? "workspace";
		this.lastView = view;
		const scope = view.conversationId ?? "workspace";
		if (scope !== previousScope) this.editor.setText(view.client.ui.drafts[scope] ?? "");
		this.syncOverlays(view);
		this.ui.requestRender();
	}

	private rootState(): MetaWorkRootState {
		const view = this.lastView ?? this.controller.getView();
		return {
			reader: view.reader,
			header: {
				connection: view.client.connection,
				serverCapabilitiesMissing: view.capabilitiesMissing,
				workspacePath: view.client.activeWorkspace?.path ?? null,
				workspaceDisplayName: view.client.activeWorkspace?.displayName ?? null,
				workspaceAvailability: view.client.activeWorkspace?.availability ?? null,
				conversationTitle: this.conversationTitle(view),
				conversationId: view.conversationId,
				navigationPending: view.navigationPending,
				selectedTurnId: view.selectedTurnId,
				selectedTurnStatus: view.selectedTurn?.status ?? null,
			},
			action: {
				operation: view.operation,
				commandHint: null,
				permissionSummary: view.permission?.status === "pending" ? view.permission.summary : null,
				submitting: view.submitting,
				awaitingReceipt: view.awaitingReceipt,
				cancelling: view.cancelling,
				cancelResult: view.cancelResult,
				notice: view.client.notices.at(-1) ?? null,
				silence: null,
				focus: view.taskPanelOpen ? "task_panel" : "editor",
			},
			conversation: {
				turns: view.visibleTurns,
				selectedTurnId: view.selectedTurnId,
				expandedTurnIds: view.expanded && view.selectedTurnId ? [view.selectedTurnId] : [],
				historyStatus: view.historyStatus,
				connection: view.client.connection,
				maxVisibleTurns: this.root.layout(this.ui.terminal.columns).maxVisibleTurns,
			},
			task: {
				...view.taskOverview,
				selectedConversationId: view.conversationId,
				selectedTaskId: view.selectedTurn?.taskId ?? null,
				hasMoreConversations: Boolean(view.client.conversationDirectoryCursor),
			},
		};
	}

	private conversationTitle(view: MetaWorkTuiViewState): string | null {
		if (!view.conversationId) return null;
		return (
			view.client.conversationSummaries.find((summary) => summary.conversationId === view.conversationId)?.title ??
			null
		);
	}

	private syncOverlays(view: MetaWorkTuiViewState): void {
		if (view.conversationSelectorOpen) {
			if (!this.conversationSelector) {
				this.conversationSelector = new MetaWorkConversationSelector(
					view.client.activeWorkspace,
					view.client.conversationSummaries,
					{
						attach: (id) =>
							void this.controller.attachConversation(id).catch((error) => this.showOperationError(error)),
						create: () =>
							void this.controller.createConversation().catch((error) => this.showOperationError(error)),
						refresh: (query) =>
							void this.controller
								.refreshConversationDirectory(query)
								.catch((error) => this.showOperationError(error)),
						cancel: () => this.controller.closeConversationSelector(),
						loadMore: () =>
							void this.controller.loadMoreConversations().catch((error) => this.showOperationError(error)),
					},
				);
				this.conversationOverlay = this.ui.showOverlay(this.conversationSelector, {
					width: "90%",
					maxHeight: "80%",
					anchor: "center",
				});
			}
			this.conversationSelector.update(
				view.client.activeWorkspace,
				view.client.conversationSummaries,
				Boolean(view.client.conversationDirectoryCursor),
			);
		} else if (this.conversationOverlay) {
			this.conversationOverlay.hide();
			this.conversationOverlay = null;
			this.conversationSelector = null;
			this.ui.setFocus(this.editor);
		}
		// 帮助：F1 打开/关闭。
		if (view.helpOpen && !this.helpOverlay) {
			this.helpOverlay = this.ui.showOverlay(
				new DismissableOverlay(new MetaWorkHelpPanel(), () => this.controller.toggleHelp()),
				{ width: "80%", maxHeight: "70%", anchor: "center" },
			);
		} else if (!view.helpOpen && this.helpOverlay) {
			this.helpOverlay.hide();
			this.helpOverlay = null;
			this.ui.setFocus(this.editor);
		}

		// Task 面板：compact 布局经覆盖层打开；inline 布局已在正文并列渲染。
		const layout = this.root.layout(this.ui.terminal.columns);
		const needsTaskOverlay = view.taskPanelOpen && layout.taskPanel === "overlay";
		if (needsTaskOverlay && !this.taskOverlay) {
			this.taskOverlay = this.ui.showOverlay(this.dashboard, {
				width: layout.taskPanelWidth ?? 40,
				maxHeight: "70%",
				anchor: "right-center",
			});
		} else if (!needsTaskOverlay && this.taskOverlay) {
			this.taskOverlay.hide();
			this.taskOverlay = null;
		}

		if (!view.helpOpen && !view.permissionPanelOpen && !view.conversationSelectorOpen) {
			this.ui.setFocus(view.taskPanelOpen ? this.dashboard : this.editor);
		}

		// 权限面板：只有显式打开时才创建；请求失效时自动关闭并刷新事实。
		if (view.permissionPanelOpen && view.permission) {
			if (!this.permissionPanel) {
				this.permissionPanel = new MetaWorkPermissionPanel(this.ui, view.permission, {
					approve: (requestId) => this.submitPermission(requestId, "approve"),
					deny: (requestId) => this.submitPermission(requestId, "deny"),
					close: () => this.controller.togglePermissionPanel(),
				});
				this.permissionOverlay = this.ui.showOverlay(this.permissionPanel, {
					width: "70%",
					maxHeight: "50%",
					anchor: "center",
				});
			} else {
				this.permissionPanel.update(view.permission);
			}
		} else if (!view.permissionPanelOpen && this.permissionOverlay) {
			this.permissionOverlay.hide();
			this.permissionOverlay = null;
			this.permissionPanel = null;
			this.ui.setFocus(this.editor);
		}
	}

	private submitPermission(requestId: string, resolution: "approve" | "deny"): void {
		this.permissionPanel?.markSubmitting();
		void this.controller.resolvePermission(requestId, resolution).catch((error) => this.showOperationError(error));
	}

	private closeTopOverlay(): boolean {
		const view = this.lastView;
		if (view?.reader) {
			this.controller.closeReader();
			return true;
		}
		if (this.conversationOverlay) {
			this.controller.closeConversationSelector();
			return true;
		}
		if (this.permissionOverlay) {
			this.controller.togglePermissionPanel();
			return true;
		}
		if (this.helpOverlay) {
			this.controller.toggleHelp();
			return true;
		}
		if (this.taskOverlay) {
			this.controller.toggleTaskPanel();
			return true;
		}
		return view?.permissionPanelOpen ?? false;
	}

	private showOperationError(error: unknown): void {
		const view = this.controller.getView();
		this.handleView({
			...view,
			client: {
				...view.client,
				notices: [...view.client.notices, { kind: "error" as const, text: formatClientError(error) }].slice(-20),
			},
		});
	}
}

/** 覆盖层包装：Escape/F1 关闭。 */
class DismissableOverlay implements Component, Focusable {
	focused = false;
	private readonly component: Component;
	private readonly onDismiss: () => void;

	constructor(component: Component, onDismiss: () => void) {
		this.component = component;
		this.onDismiss = onDismiss;
	}

	render(width: number): string[] {
		return this.component.render(width);
	}

	invalidate(): void {
		this.component.invalidate();
	}

	handleInput(data: string): void {
		if (data === "\x1b" || data === "\x1bOP" || data === "\x1b[11~") {
			this.onDismiss();
		}
	}
}
