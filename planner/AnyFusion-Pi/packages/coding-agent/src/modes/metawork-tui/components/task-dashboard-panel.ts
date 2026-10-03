/** Workspace navigation; lifecycle phases come from Task Domain. */
import { type Component, type Focusable, getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../../interactive/theme/theme.ts";
import { sanitizeDisplayText } from "../protocol-adapter.ts";
import type { TaskOverviewRow, TaskOverviewState } from "../task-overview.ts";

export interface MetaWorkTaskDashboardState extends TaskOverviewState {
	readonly selectedConversationId: string | null;
	readonly selectedTaskId: string | null;
	readonly hasMoreConversations: boolean;
}
export interface TaskDashboardActions {
	open(row: TaskOverviewRow): void;
	close(): void;
	more(conversationId: string): void;
	first(conversationId: string): void;
	moreConversations(): void;
	refresh(): void;
	exit(): void;
	changed(): void;
}
const LABELS: Record<string, string> = {
	retrying: "重试中",
	recovery_required: "需要恢复",
	executing: "执行中",
	queued: "排队",
	blocked: "阻塞",
	waiting: "等待",
	planning: "规划中",
	ready: "就绪",
	waiting_for_plan: "等待规划",
	waiting_for_user: "等待确认",
	recovering: "恢复中",
	publishing: "发布中",
	completed: "已完成",
	failed: "失败",
	cancelled: "已取消",
};

export class MetaWorkTaskDashboard implements Component, Focusable {
	focused = false;
	private readonly getState: () => MetaWorkTaskDashboardState;
	private readonly actions?: TaskDashboardActions;
	private selectedKey: string | null = null;
	private hits = new Map<number, string>();
	private readonly height: () => number;

	constructor(getState: () => MetaWorkTaskDashboardState, actions?: TaskDashboardActions, height = () => 18) {
		this.getState = getState;
		this.actions = actions;
		this.height = height;
	}
	invalidate(): void {}

	private entries() {
		const state = this.getState();
		return [
			...state.rows.map((row) => ({
				key: `${row.conversationId}\0${row.taskId}`,
				title: row.title,
				subtitle: row.conversationTitle,
				phase: row.phase,
				current: state.selectedConversationId === row.conversationId && state.selectedTaskId === row.taskId,
				run: () => this.actions?.open(row),
			})),
			...state.more.map((id) => ({
				key: `more:${id}`,
				title: "更多任务 →",
				subtitle: state.rows.find((row) => row.conversationId === id)?.conversationTitle ?? id,
				phase: "",
				current: false,
				run: () => this.actions?.more(id),
			})),
			...state.previous.map((id) => ({
				key: `first:${id}`,
				title: "返回首批任务",
				subtitle: state.rows.find((row) => row.conversationId === id)?.conversationTitle ?? id,
				phase: "",
				current: false,
				run: () => this.actions?.first(id),
			})),
			...(state.hasMoreConversations
				? [
						{
							key: "more-conversations",
							title: "更多会话中的任务 →",
							subtitle: "",
							phase: "",
							current: false,
							run: () => this.actions?.moreConversations(),
						},
					]
				: []),
		];
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const entries = this.entries();
		const index = Math.max(
			0,
			entries.findIndex((row) => row.key === this.selectedKey),
		);
		if (kb.matches(data, "tui.select.cancel")) this.actions?.close();
		else if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.pageUp")) {
			this.selectedKey = entries[Math.max(0, index - (kb.matches(data, "tui.select.pageUp") ? 5 : 1))]?.key ?? null;
		} else if (kb.matches(data, "tui.select.down") || kb.matches(data, "tui.select.pageDown")) {
			this.selectedKey =
				entries[Math.min(entries.length - 1, index + (kb.matches(data, "tui.select.pageDown") ? 5 : 1))]?.key ??
				null;
		} else if (kb.matches(data, "tui.select.confirm")) entries[index]?.run();
		else if (data === "r") this.actions?.refresh();
		else if (data === "\x03" || data === "\x04") this.actions?.exit();
		this.actions?.changed();
	}

	click(line: number): boolean {
		const key = this.hits.get(line);
		const entry = this.entries().find((row) => row.key === key);
		if (!entry) return false;
		this.selectedKey = entry.key;
		entry.run();
		return true;
	}

	render(width: number, maxRows = this.height()): string[] {
		const state = this.getState();
		const entries = this.entries();
		if (!entries.some((row) => row.key === this.selectedKey))
			this.selectedKey = entries.find((row) => row.current)?.key ?? entries[0]?.key ?? null;
		const counts = new Map<string, number>();
		for (const row of state.rows) counts.set(row.phase, (counts.get(row.phase) ?? 0) + 1);
		const lines = [
			theme.fg("accent", theme.bold("Task Dashboard")),
			theme.fg("dim", "当前 Workspace · 已加载任务"),
			[...counts].map(([phase, count]) => `${LABELS[phase] ?? phase} ${count}`).join(" · ") ||
				(state.loading ? "正在读取任务…" : "暂无活动任务"),
			theme.fg("dim", this.focused ? "↑/↓ 选择 · Enter 查看 · Esc 返回" : "F6 选择任务 · 点击查看"),
		];
		this.hits.clear();
		const count = Math.max(1, Math.floor((maxRows - lines.length - 2) / 2));
		const selected = Math.max(
			0,
			entries.findIndex((row) => row.key === this.selectedKey),
		);
		const start = Math.max(0, Math.min(selected - Math.floor(count / 2), entries.length - count));
		for (const row of entries.slice(start, start + count)) {
			const marker = this.focused && row.key === this.selectedKey ? "›" : row.current ? "●" : " ";
			this.hits.set(lines.length, row.key);
			this.hits.set(lines.length + 1, row.key);
			lines.push(
				theme.fg(
					this.focused && row.key === this.selectedKey ? "accent" : "text",
					`${marker} ${row.phase ? `[${LABELS[row.phase] ?? row.phase}] ` : ""}${sanitizeDisplayText(row.title)}`,
				),
			);
			lines.push(theme.fg("dim", `  ${sanitizeDisplayText(row.subtitle)}`));
		}
		if (entries.length > count)
			lines.push(theme.fg("dim", `${start + 1}–${Math.min(entries.length, start + count)} / ${entries.length}`));
		if (state.error) lines.push(theme.fg("warning", `刷新失败：${sanitizeDisplayText(state.error)}`));
		return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
	}
}
