import {
	Container,
	type Focusable,
	getKeybindings,
	Input,
	Spacer,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type {
	MetaWorkConversationSummary,
	MetaWorkWorkspaceView,
} from "../metawork-client-model.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

export interface MetaWorkConversationSelectorActions {
	readonly attach: (conversationId: string) => void;
	readonly create: () => void;
	readonly refresh: (query?: string) => void;
	readonly cancel: () => void;
}

export class MetaWorkConversationSelector extends Container implements Focusable {
	private readonly searchInput = new Input();
	private readonly list = new Container();
	private readonly title = new Text("", 0, 0);
	private readonly hint = new Text("", 0, 0);
	private summaries: MetaWorkConversationSummary[];
	private filtered: MetaWorkConversationSummary[];
	private selectedIndex = 0;
	private searching = false;
	private _focused = false;
	private workspace: MetaWorkWorkspaceView | null;
	private readonly actions: MetaWorkConversationSelectorActions;

	constructor(
		workspace: MetaWorkWorkspaceView | null,
		summaries: readonly MetaWorkConversationSummary[],
		actions: MetaWorkConversationSelectorActions,
	) {
		super();
		this.workspace = workspace;
		this.actions = actions;
		this.summaries = [...summaries];
		this.filtered = [...summaries];
		this.searchInput.onSubmit = value => {
			this.applySearch(value);
			const selected = this.filtered[this.selectedIndex];
			if (selected) this.actions.attach(selected.conversationId);
		};
		this.addChild(new DynamicBorder());
		this.addChild(this.title);
		this.addChild(this.hint);
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.list);
		this.addChild(new DynamicBorder());
		this.refresh();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value && this.searching;
	}

	update(
		workspace: MetaWorkWorkspaceView | null,
		summaries: readonly MetaWorkConversationSummary[],
	): void {
		this.workspace = workspace;
		this.summaries = [...summaries];
		this.applySearch(this.searchInput.getValue());
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (this.searching) {
			if (kb.matches(keyData, "tui.select.cancel")) {
				this.searching = false;
				this.searchInput.focused = false;
				this.searchInput.setValue("");
				this.applySearch("");
				return;
			}
			if (kb.matches(keyData, "tui.select.up")) {
				this.move(-1);
				return;
			}
			if (kb.matches(keyData, "tui.select.down")) {
				this.move(1);
				return;
			}
			if (kb.matches(keyData, "tui.select.confirm")) {
				const selected = this.filtered[this.selectedIndex];
				if (selected) this.actions.attach(selected.conversationId);
				return;
			}
			this.searchInput.handleInput(keyData);
			this.applySearch(this.searchInput.getValue());
			this.actions.refresh(this.searchInput.getValue() || undefined);
			return;
		}

		if (kb.matches(keyData, "tui.select.up")) {
			this.move(-1);
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.move(1);
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.filtered[this.selectedIndex];
			if (selected) this.actions.attach(selected.conversationId);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.actions.cancel();
		} else if (keyData === "/") {
			this.searching = true;
			this.searchInput.focused = true;
			this.refresh();
		} else if (keyData.toLowerCase() === "n") {
			this.actions.create();
		} else if (keyData.toLowerCase() === "r") {
			this.actions.refresh();
		}
	}

	private move(delta: number): void {
		if (this.filtered.length === 0) return;
		this.selectedIndex = (
			this.selectedIndex + delta + this.filtered.length
		) % this.filtered.length;
		this.refresh();
	}

	private applySearch(query: string): void {
		const normalized = query.trim().toLocaleLowerCase();
		this.filtered = normalized
			? this.summaries.filter(item => (
					item.title.toLocaleLowerCase().includes(normalized)
					|| item.preview.toLocaleLowerCase().includes(normalized)
				))
			: [...this.summaries];
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
		this.refresh();
	}

	private refresh(): void {
		const workspaceName = this.workspace?.displayName ?? "Workspace";
		const availability = this.workspace?.availability === "unavailable"
			? theme.fg("warning", "unavailable")
			: theme.fg("success", "available");
		this.title.setText(`${theme.bold(workspaceName)}  ${availability}`);
		this.hint.setText(theme.fg(
			"muted",
			this.searching
				? "输入关键词搜索当前 Workspace，Enter 打开，Esc 返回"
				: "↑/↓ 选择  Enter 打开  / 搜索  n 新建  r 刷新  Esc 返回",
		));
		this.list.clear();
		if (this.filtered.length === 0) {
			this.list.addChild(new Text(
				theme.fg("muted", "当前 Workspace 还没有 Conversation，按 n 新建。"),
				0,
				0,
			));
			return;
		}
		for (const [index, item] of this.filtered.entries()) {
			const selected = index === this.selectedIndex;
			const marker = selected ? theme.fg("accent", "›") : " ";
			const activity = activityLabel(item.activity.state);
			const task = item.activity.taskId ? ` · ${item.activity.taskId}` : "";
			const age = relativeTime(item.updatedAt);
			const title = truncateToWidth(item.title || "New conversation", 72, "…");
			this.list.addChild(new Text(
				`${marker} ${selected ? theme.bold(title) : title}`
					+ `  ${theme.fg(activity.color, activity.label)}${task} · ${age}`,
				0,
				0,
			));
			if (item.preview && item.preview !== item.title) {
				this.list.addChild(new Text(
					theme.fg("muted", `    ${truncateToWidth(item.preview, 88, "…")}`),
					0,
					0,
				));
			}
		}
	}
}

function activityLabel(state: MetaWorkConversationSummary["activity"]["state"]): {
	label: string;
	color: "muted" | "accent" | "warning" | "error" | "success";
} {
	switch (state) {
		case "planning": return { label: "规划中", color: "accent" };
		case "executing": return { label: "执行中", color: "success" };
		case "waiting": return { label: "等待中", color: "warning" };
		case "blocked": return { label: "已阻塞", color: "error" };
		default: return { label: "空闲", color: "muted" };
	}
}

function relativeTime(value: string): string {
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) return "时间未知";
	const delta = Math.max(0, Date.now() - timestamp);
	const minutes = Math.floor(delta / 60_000);
	if (minutes < 1) return "刚刚";
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} 小时前`;
	return `${Math.floor(hours / 24)} 天前`;
}
