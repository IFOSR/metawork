/**
 * MetaWork TUI 权限面板（统一 TUI 设计 §8.5）。
 *
 * 只发送请求 ID 与 approve/deny，范围由 Server 决定。请求过期、被其他端处理、
 * 历史重放或 scope 不符时禁用旧操作并刷新事实。快捷键只在面板获得焦点后有效，
 * 普通输入中的 a/x/c 永远不是业务命令。
 */

import {
	Container,
	type Focusable,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import { theme } from "../../interactive/theme/theme.ts";
import { DynamicBorder } from "../../interactive/components/dynamic-border.ts";
import type { MetaWorkPermissionProjection } from "../model.ts";

export interface MetaWorkPermissionPanelActions {
	readonly approve: (requestId: string) => void;
	readonly deny: (requestId: string) => void;
	readonly close: () => void;
}

export class MetaWorkPermissionPanel extends Container implements Focusable {
	private _focused = false;
	private status: "pending" | "submitting" | "resolved" | "expired" = "pending";
	private readonly title = new Text("", 1, 0);
	private readonly summary = new Text("", 1, 0);
	private readonly hint = new Text("", 1, 0);
	private permission: MetaWorkPermissionProjection;
	private readonly ui: TUI;
	private readonly actions: MetaWorkPermissionPanelActions;

	constructor(
		ui: TUI,
		permission: MetaWorkPermissionProjection,
		actions: MetaWorkPermissionPanelActions,
	) {
		super();
		this.ui = ui;
		this.actions = actions;
		this.permission = permission;
		this.addChild(new DynamicBorder());
		this.addChild(this.title);
		this.addChild(new Spacer(1));
		this.addChild(this.summary);
		this.addChild(new Spacer(1));
		this.addChild(this.hint);
		this.addChild(new DynamicBorder());
		this.refresh();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.refresh();
	}

	update(permission: MetaWorkPermissionProjection): void {
		this.permission = permission;
		if (permission.status === "resolved" || permission.status === "expired") {
			this.status = permission.status;
		}
		this.refresh();
	}

	/** 服务端已确认受理/拒绝后禁用旧操作。 */
	markSubmitting(): void {
		this.status = "submitting";
		this.refresh();
	}

	handleInput(data: string): void {
		// 只有面板获得焦点时 a/x/Escape 才有意义；普通输入中的字母永远不是业务命令。
		if (!this._focused) return;
		if (this.status !== "pending" && data !== "\x1b") return;
		if (data === "a" || data === "y") {
			this.actions.approve(this.permission.requestId);
			return;
		}
		if (data === "x" || data === "n") {
			this.actions.deny(this.permission.requestId);
			return;
		}
		if (data === "\x1b") {
			this.actions.close();
		}
	}

	private refresh(): void {
		this.title.setText(theme.fg("warning", theme.bold("权限请求")));
		this.summary.setText(theme.fg("text", this.permission.summary || "需要用户授权"));
		const statusLabel = this.status === "pending"
			? "a 允许 · x 拒绝 · Esc 关闭"
			: this.status === "submitting"
				? "正在提交决议…"
				: this.status === "resolved"
					? "该请求已处理"
					: "该请求已过期 · 请刷新事实";
		this.hint.setText(theme.fg(this.status === "pending" ? "dim" : "warning", statusLabel));
		this.ui.requestRender();
	}
}
