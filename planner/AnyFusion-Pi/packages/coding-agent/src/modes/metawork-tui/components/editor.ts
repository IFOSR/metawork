/**
 * MetaWork TUI 编辑器（统一 TUI 设计 §8.4）。
 *
 * 复用 pi-tui Editor：多行编辑、历史输入导航、粘贴、补全候选、中文宽字符处理。
 * 只新增客户端动作键位：
 * - Enter 提交（基类行为）；`\` + Enter 换行（Pi 既有绑定）。
 * - Escape 优先关闭候选/弹层；业务取消必须走显式的 /cancel 操作。
 * - Ctrl+C / Ctrl+D 只退出客户端，不隐式取消 Server 工作。
 * - F1 帮助、F4 权限面板、F5 加载更早历史、F6 Task 面板、
 *   F7/F8 选择 Turn、F9 展开过程。
 * 权限批准/拒绝只在权限面板获得焦点后有效，普通输入中的 a/x/c 永远不是业务命令。
 */

import { Editor, type EditorOptions, type EditorTheme, matchesKey as matchesTerminalKey, type TUI } from "@earendil-works/pi-tui";

export const METAWORK_TUI_KEYS = {
	help: ["\x1bOP", "\x1b[11~"],
	permissionPanel: ["\x1bOS", "\x1b[14~"],
	loadOlderHistory: ["\x1b[15~"],
	taskPanel: ["\x1b[17~"],
	previousTurn: ["\x1b[18~"],
	nextTurn: ["\x1b[19~"],
	toggleExpanded: ["\x1b[20~"],
	ctrlC: "\x03",
	ctrlD: "\x04",
} as const;

export interface MetaWorkEditorActions {
	/** 显式退出客户端：只退出，不取消 Server 工作。 */
	onExit(): void;
	/** Escape：返回 true 表示已关闭某个弹层/候选。 */
	onEscape(): boolean;
	onHelp(): void;
	onPermissionPanel(): void;
	onLoadOlderHistory(): void;
	onTaskPanel(): void;
	onSelectPreviousTurn(): void;
	onSelectNextTurn(): void;
	onToggleExpanded(): void;
	onScrollPage?(direction: -1 | 1): void;
}

export class MetaWorkEditor extends Editor {
	private actions: MetaWorkEditorActions | null = null;

	constructor(ui: TUI, editorTheme: EditorTheme, options?: EditorOptions) {
		super(ui, editorTheme, options);
	}

	setActions(actions: MetaWorkEditorActions): void {
		this.actions = actions;
	}

	handleInput(data: string): void {
		const pageUp = matchesTerminalKey(data, "pageUp") || matchesTerminalKey(data, "shift+pageUp");
		const pageDown = matchesTerminalKey(data, "pageDown") || matchesTerminalKey(data, "shift+pageDown");
		if (pageUp || pageDown) {
			this.actions?.onScrollPage?.(pageUp ? -1 : 1);
			return;
		}
		// 退出客户端：Ctrl+C / Ctrl+D 绝不进入业务取消路径。
		if (data === METAWORK_TUI_KEYS.ctrlC || data === METAWORK_TUI_KEYS.ctrlD) {
			this.actions?.onExit();
			return;
		}
		if (matchesKey(data, METAWORK_TUI_KEYS.help)) {
			this.actions?.onHelp();
			return;
		}
		if (matchesKey(data, METAWORK_TUI_KEYS.permissionPanel)) {
			this.actions?.onPermissionPanel();
			return;
		}
		if (matchesKey(data, METAWORK_TUI_KEYS.loadOlderHistory)) {
			this.actions?.onLoadOlderHistory();
			return;
		}
		if (matchesKey(data, METAWORK_TUI_KEYS.taskPanel)) {
			this.actions?.onTaskPanel();
			return;
		}
		if (matchesKey(data, METAWORK_TUI_KEYS.previousTurn)) {
			this.actions?.onSelectPreviousTurn();
			return;
		}
		if (matchesKey(data, METAWORK_TUI_KEYS.nextTurn)) {
			this.actions?.onSelectNextTurn();
			return;
		}
		if (matchesKey(data, METAWORK_TUI_KEYS.toggleExpanded)) {
			this.actions?.onToggleExpanded();
			return;
		}
		// Escape 优先关闭候选/弹层；不触发业务取消。
		if (data === "\x1b" && !this.isShowingAutocomplete()) {
			if (this.actions?.onEscape()) return;
		}
		super.handleInput(data);
	}
}

function matchesKey(data: string, keys: readonly string[]): boolean {
	return keys.includes(data);
}
