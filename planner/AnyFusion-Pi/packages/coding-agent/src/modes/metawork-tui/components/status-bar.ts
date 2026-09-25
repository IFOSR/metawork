/**
 * MetaWork TUI 顶部栏与操作行（统一 TUI 设计 §8.1、§8.5）。
 *
 * 只消费展示模型；不调用 Gateway、Runtime 或 Repository。
 * 数据缺失时显示“暂无信息”，不补零、不推断。
 */

import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../../interactive/theme/theme.ts";
import type { MetaWorkConnectionState } from "../model.ts";

export interface MetaWorkHeaderState {
	readonly connection: MetaWorkConnectionState;
	readonly serverCapabilitiesMissing: readonly string[];
	readonly workspacePath: string | null;
	readonly workspaceDisplayName: string | null;
	readonly workspaceAvailability: "available" | "unavailable" | null;
	readonly conversationTitle: string | null;
	readonly conversationId: string | null;
	/** 显式导航进行中：Server 确认新选择前标识为切换中。 */
	readonly navigationPending: boolean;
	readonly selectedTurnId: string | null;
	readonly selectedTurnStatus: string | null;
}

export interface MetaWorkActionState {
	readonly operation: string | null;
	readonly commandHint: string | null;
	readonly permissionSummary: string | null;
	readonly submitting: boolean;
	readonly awaitingReceipt: string | null;
	readonly cancelling: boolean;
	readonly cancelResult: string | null;
	readonly notice: { readonly kind: "info" | "error" | "unknown_event"; readonly text: string } | null;
	readonly silence: string | null;
	readonly focus: "editor" | "history" | "task_panel" | "permission" | "menu";
}

const CONNECTION_LABELS: Record<MetaWorkConnectionState, string> = {
	connecting: "连接中",
	ready: "已连接",
	reconnecting: "重连中",
	// 能力缺失/版本不符明确提示升级，不恢复旧 TUI、不静默丢面板。
	incompatible: "版本不兼容 · 请升级 Server",
	draining: "服务端正在停止",
	closed: "已断开",
};

export function connectionLabel(state: MetaWorkConnectionState): string {
	return CONNECTION_LABELS[state] ?? "未知状态";
}

export class MetaWorkHeader implements Component {
	private readonly getState: () => MetaWorkHeaderState;

	constructor(getState: () => MetaWorkHeaderState) {
		this.getState = getState;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const state = this.getState();
		const workspace = state.workspaceDisplayName ?? state.workspacePath ?? "未设置";
		const workspaceLabel = state.workspaceAvailability === "unavailable"
			? `${workspace}（不可用）`
			: workspace;
		const conversation = state.conversationTitle
			?? (state.conversationId ? state.conversationId : "未选择");
		const navigation = state.navigationPending ? " · 切换中" : "";
		const connection = connectionLabel(state.connection);
		const connectionText = state.connection === "ready"
			? theme.fg("success", connection)
			: theme.fg("warning", connection);

		const lines = [
			truncateToWidth(
				`${theme.fg("accent", theme.bold("MetaWork"))}`
					+ `  ${theme.fg("dim", "Workspace:")} ${theme.fg("text", workspaceLabel)}`
					+ `  ${theme.fg("dim", "Conversation:")} ${theme.fg("text", conversation)}${navigation}`,
				width,
			),
			truncateToWidth(
				`${theme.fg("dim", "连接:")} ${connectionText}`
					+ `  ${theme.fg("dim", "选中 Turn:")} ${state.selectedTurnId
						? `${theme.fg("text", state.selectedTurnId)}`
							+ `${state.selectedTurnStatus ? theme.fg("dim", ` · ${state.selectedTurnStatus}`) : ""}`
						: theme.fg("dim", "暂无信息")}`,
				width,
			),
		];
		if (state.serverCapabilitiesMissing.length > 0) {
			lines.push(truncateToWidth(
				theme.fg(
					"warning",
					`Server 缺少能力: ${state.serverCapabilitiesMissing.join(", ")} · 请升级 Server 后重试`,
				),
				width,
			));
		}
		return lines;
	}
}

export class MetaWorkActionBar implements Component {
	private readonly getState: () => MetaWorkActionState;

	constructor(getState: () => MetaWorkActionState) {
		this.getState = getState;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const state = this.getState();
		const lines: string[] = [];
		const operation: string[] = [];
		if (state.submitting) operation.push("提交中");
		if (state.awaitingReceipt) operation.push(`受理状态待确认 · ${state.awaitingReceipt}`);
		if (state.cancelling) operation.push("正在请求取消");
		if (state.cancelResult) operation.push(state.cancelResult);
		if (state.silence) operation.push(`已静默 ${state.silence}（仅表示未收到更新）`);
		if (state.operation) operation.push(state.operation);
		lines.push(truncateToWidth(
			operation.length > 0
				? theme.fg("text", operation.join(" · "))
				: theme.fg("dim", state.commandHint ?? "Enter 提交 · F1 帮助 · F6 Task 面板 · /cancel 取消当前 Turn"),
			width,
		));

		const hints: string[] = [`焦点: ${state.focus}`, "滚轮 / PgUp/PgDn 滚动"];
		if (state.permissionSummary) {
			hints.push(theme.fg("warning", `权限请求待处理: ${state.permissionSummary} · F4 打开`));
		}
		const notice = state.notice;
		if (notice) {
			const color = notice.kind === "error" ? "error" : notice.kind === "unknown_event" ? "warning" : "dim";
			hints.push(theme.fg(color, notice.text));
		}
		lines.push(truncateToWidth(hints.join("  "), width));
		return lines;
	}
}
