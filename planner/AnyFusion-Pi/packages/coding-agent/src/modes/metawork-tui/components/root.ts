/**
 * MetaWork TUI 根组件（统一 TUI 设计 §8.1、§6）。
 *
 * 唯一组件树：顶部栏 + 对话/ Task 面板 + 操作行 + 编辑器。
 * 按终端尺寸切换布局；尺寸变化不丢草稿、不改变选中 Turn、不触发业务命令。
 */

import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { computeMetaWorkLayout, type MetaWorkLayout } from "../layout.ts";
import { MetaWorkConversationPanel, type MetaWorkConversationPanelState } from "./conversation-panel.ts";
import { MetaWorkTaskDashboard, type MetaWorkTaskDashboardState } from "./task-dashboard-panel.ts";
import { MetaWorkActionBar, MetaWorkHeader, type MetaWorkActionState, type MetaWorkHeaderState } from "./status-bar.ts";

export interface MetaWorkRootState {
	readonly header: MetaWorkHeaderState;
	readonly action: MetaWorkActionState;
	readonly conversation: MetaWorkConversationPanelState;
	readonly task: MetaWorkTaskDashboardState;
}

export interface MetaWorkRootDeps {
	readonly getState: () => MetaWorkRootState;
	readonly getRows: () => number;
	readonly editor: Component;
	readonly now?: () => number;
}

export class MetaWorkRoot implements Component {
	private readonly header: MetaWorkHeader;
	private readonly actionBar: MetaWorkActionBar;
	private readonly conversation: MetaWorkConversationPanel;
	private readonly task: MetaWorkTaskDashboard;
	private readonly deps: MetaWorkRootDeps;
	private scrollOffset = 0;
	private bodyRows = 0;
	private viewportRows = 1;
	private selectionKey = "";
	private taskScrollTop = 0;
	private taskRows = 0;

	scrollPage(direction: -1 | 1): void {
		this.scrollLines(direction * this.viewportRows);
	}

	scrollLines(delta: number): void {
		this.scrollOffset = Math.max(0, Math.min(
			Math.max(0, this.bodyRows - this.viewportRows),
			this.scrollOffset - delta,
		));
		this.taskScrollTop = Math.max(0, Math.min(
			Math.max(0, this.taskRows - this.viewportRows),
			this.taskScrollTop + delta,
		));
	}

	constructor(deps: MetaWorkRootDeps) {
		this.deps = deps;
		this.header = new MetaWorkHeader(() => this.deps.getState().header);
		this.actionBar = new MetaWorkActionBar(() => this.deps.getState().action);
		this.conversation = new MetaWorkConversationPanel(() => this.deps.getState().conversation);
		this.task = new MetaWorkTaskDashboard(
			() => this.deps.getState().task,
			deps.now ?? (() => Date.now()),
		);
	}

	/** 当前布局（供 app 决定覆盖层）。 */
	layout(width: number): MetaWorkLayout {
		return computeMetaWorkLayout(width, this.deps.getRows());
	}

	invalidate(): void {
		this.header.invalidate();
		this.actionBar.invalidate();
		this.conversation.invalidate();
		this.task.invalidate();
	}

	render(width: number): string[] {
		const state = this.deps.getState();
		const layout = this.layout(width);
		const lines: string[] = [];

		if (layout.showHeader) {
			lines.push(...this.header.render(width));
			lines.push("");
		}

		const footer = ["", ...this.actionBar.render(width), ...this.deps.editor.render(width)];
		this.viewportRows = Math.max(1, layout.rows - lines.length - footer.length);
		const selection = `${state.header.conversationId}:${state.conversation.selectedTurnId}`;
		if (selection !== this.selectionKey) {
			this.scrollOffset = 0;
			this.taskScrollTop = 0;
			this.bodyRows = 0;
			this.selectionKey = selection;
		}
		lines.push(...this.renderBody(width, layout));
		lines.push(...footer);
		return lines.slice(-layout.rows);
	}

	private visibleConversation(body: string[]): string[] {
		if (this.scrollOffset > 0) {
			// Keep a scrolled history anchor stable as live output grows below it.
			this.scrollOffset += Math.max(0, body.length - this.bodyRows);
		}
		this.bodyRows = body.length;
		this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, body.length - this.viewportRows));
		const end = body.length - this.scrollOffset;
		return body.slice(Math.max(0, end - this.viewportRows), end);
	}

	private renderBody(
		width: number,
		layout: MetaWorkLayout,
	): string[] {
		if (layout.taskPanel !== "inline" || layout.taskPanelWidth === null) {
			// compact 布局：对话框优先，Task 面板经覆盖层按需打开。
			return this.visibleConversation(this.conversation.render(width));
		}
		const gap = 2;
		const taskWidth = Math.max(1, Math.min(layout.taskPanelWidth, width - 1));
		const conversationWidth = Math.max(1, width - taskWidth - gap);
		const left = this.visibleConversation(this.conversation.render(conversationWidth));
		const right = this.task.render(taskWidth);
		this.taskRows = right.length;
		this.taskScrollTop = Math.min(this.taskScrollTop, Math.max(0, right.length - this.viewportRows));
		return zipColumns(left, right.slice(this.taskScrollTop, this.taskScrollTop + this.viewportRows),
			conversationWidth, taskWidth, gap);
	}
}

/** 并列渲染两列：左侧不足宽度时补空格，超出先截断。 */
export function zipColumns(
	left: string[],
	right: string[],
	leftWidth: number,
	rightWidth: number,
	gap: number,
): string[] {
	const rows = Math.max(left.length, right.length);
	const lines: string[] = [];
	for (let index = 0; index < rows; index += 1) {
		const leftLine = pad(left[index] ?? "", leftWidth);
		const rightLine = right[index] ?? "";
		lines.push(`${leftLine}${" ".repeat(gap)}${truncateToWidth(rightLine, rightWidth)}`);
	}
	return lines;
}

function pad(line: string, width: number): string {
	const truncated = visibleWidth(line) > width ? truncateToWidth(line, width) : line;
	const remaining = width - visibleWidth(truncated);
	return remaining > 0 ? `${truncated}${" ".repeat(remaining)}` : truncated;
}
