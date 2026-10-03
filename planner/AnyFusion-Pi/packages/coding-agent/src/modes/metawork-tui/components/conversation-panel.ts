/**
 * MetaWork TUI 对话面板（统一 TUI 设计 §8.1、§8.2）。
 *
 * 按服务端确认的顺序组织多个 Turn；用户请求、过程摘要、结果各有一个明确位置。
 * 只消费展示模型：不解析文案判断状态，不从原始输出猜 Task，不调用 Gateway。
 */

import { type Component, Markdown, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../../interactive/theme/theme.ts";
import type { MetaWorkConnectionState, MetaWorkTurnProjection, MetaWorkTurnStatus } from "../model.ts";

import { billingLines } from "./turn-billing.ts";

export type MetaWorkHistoryStatus = "unloaded" | "loading" | "partial" | "exhausted" | "unavailable";

export interface MetaWorkConversationPanelState {
	readonly turns: readonly MetaWorkTurnProjection[];
	readonly selectedTurnId: string | null;
	readonly expandedTurnIds: readonly string[];
	readonly historyStatus: MetaWorkHistoryStatus;
	readonly connection: MetaWorkConnectionState;
	readonly maxVisibleTurns: number;
}

const STAGE_LABELS: Record<string, string> = {
	understanding: "理解",
	planning: "规划",
	authorization: "授权",
	execution: "执行",
	verification: "验证",
	delivery: "交付",
};

const STATUS_LABELS: Record<MetaWorkTurnStatus, string> = {
	running: "进行中",
	completed: "已完成",
	failed: "失败",
	blocked: "阻塞",
	cancelled: "已取消",
};

const STATUS_COLORS: Record<MetaWorkTurnStatus, "success" | "error" | "warning" | "dim" | "accent"> = {
	running: "accent",
	completed: "success",
	failed: "error",
	blocked: "warning",
	cancelled: "dim",
};

export function stageLabel(stage: string): string {
	return STAGE_LABELS[stage] ?? "等待";
}

export function turnStatusLabel(status: MetaWorkTurnStatus): string {
	return STATUS_LABELS[status] ?? status;
}

export class MetaWorkConversationPanel implements Component {
	private readonly markdown = new Markdown("", 0, 0, getMarkdownTheme());
	private readonly getState: () => MetaWorkConversationPanelState;

	constructor(getState: () => MetaWorkConversationPanelState) {
		this.getState = getState;
	}

	invalidate(): void {
		this.markdown.invalidate();
	}

	render(width: number): string[] {
		const state = this.getState();
		const safeWidth = Math.max(1, width);
		const lines: string[] = [];

		lines.push(...this.renderHistoryHint(state, safeWidth));

		const count = Math.max(1, state.maxVisibleTurns);
		const selected = state.turns.findIndex((turn) => turn.id === state.selectedTurnId);
		const end = selected >= 0 ? selected + 1 : state.turns.length;
		const visible = state.turns.slice(Math.max(0, end - count), end);
		if (visible.length === 0) {
			lines.push(
				truncateToWidth(
					state.historyStatus === "loading"
						? theme.fg("dim", "正在加载历史…")
						: theme.fg("dim", this.emptyHint(state)),
					safeWidth,
				),
			);
			return lines;
		}

		for (const turn of visible) {
			lines.push(...this.renderTurn(turn, state, safeWidth));
		}
		return lines;
	}

	private emptyHint(state: MetaWorkConversationPanelState): string {
		if (state.historyStatus === "unavailable") return "历史不可用 · 请刷新或重新选择 Conversation";
		if (state.connection === "ready") return "暂无对话 · 输入消息开始，或 /workspace /absolute/path 选择 Workspace";
		return "等待连接就绪…";
	}

	private renderHistoryHint(state: MetaWorkConversationPanelState, width: number): string[] {
		if (state.historyStatus === "partial") {
			return [truncateToWidth(theme.fg("dim", "更早的历史未加载 · Ctrl+H 加载更早"), width)];
		}
		if (state.historyStatus === "unavailable") {
			return [truncateToWidth(theme.fg("warning", "历史不可用：未加载的 Turn 不会伪造"), width)];
		}
		return [];
	}

	private renderTurn(turn: MetaWorkTurnProjection, state: MetaWorkConversationPanelState, width: number): string[] {
		const lines: string[] = [];
		const selected = state.selectedTurnId === turn.id;
		const expanded = state.expandedTurnIds.includes(turn.id);
		const role = turn.interactionKind === "system_command" ? "系统命令" : "助手";
		lines.push(
			truncateToWidth(
				`${selected ? theme.fg("accent", "▸") : " "} ` +
					`${theme.fg("accent", theme.bold(role))}` +
					` ${theme.fg(STATUS_COLORS[turn.status], turnStatusLabel(turn.status))}` +
					` ${theme.fg("dim", `${turn.id} · ${stageLabel(turn.stage)}`)}`,
				width,
			),
		);

		if (turn.userInput) {
			lines.push(truncateToWidth(theme.fg("dim", "你"), width));
			lines.push(...indent(wrapTextWithAnsi(turn.userInput, Math.max(1, width - 2)), "  "));
			if (turn.userInputRef && turn.userInputRef.byteLength > Buffer.byteLength(turn.userInput)) {
				lines.push(...wrapTextWithAnsi(`查看完整提问：/read ${turn.userInputRef.hash} 0`, width));
			}
		}

		lines.push(...this.renderProcess(turn, expanded, width));

		if (turn.permission && turn.permission.status === "pending") {
			lines.push(
				truncateToWidth(theme.fg("warning", `权限待处理: ${turn.permission.summary} · F4 打开权限面板`), width),
			);
		} else if (turn.permission && turn.permission.status === "expired") {
			lines.push(truncateToWidth(theme.fg("dim", "权限请求已过期 · 操作不可用"), width));
		}

		lines.push(...this.renderResult(turn, width));
		if (turn.turnBill) lines.push(...billingLines(turn, width));

		if (turn.error) {
			lines.push(
				...indent(wrapTextWithAnsi(turn.error, Math.max(1, width - 2)), "  ").map((line) =>
					theme.fg("error", line),
				),
			);
		}

		if (expanded && turn.artifacts.length > 0) {
			lines.push(truncateToWidth(theme.fg("dim", `产物 (${turn.artifacts.length})`), width));
			for (const artifact of turn.artifacts) {
				const note = artifact.previewable ? "" : theme.fg("dim", " · 不可预览");
				lines.push(truncateToWidth(`  ${theme.fg("text", artifact.displayName)}${note}`, width));
			}
		}

		lines.push(truncateToWidth(theme.fg("dim", "  F9 展开过程 · F7/F8 选择 Turn · F5 更早历史"), width));
		return lines;
	}

	private renderProcess(turn: MetaWorkTurnProjection, expanded: boolean, width: number): string[] {
		const lines: string[] = [];
		const visibleTrace = expanded ? turn.trace : turn.trace.slice(-2);
		for (const item of visibleTrace) {
			const text = `${stageLabel(item.stage)} · ${item.actor} · ${item.title}`;
			lines.push(truncateToWidth(theme.fg("dim", `  ${text}`), width));
			if (item.summary) {
				lines.push(truncateToWidth(theme.fg("dim", `    ${item.summary}`), width));
			}
		}
		if (!expanded && turn.trace.length > visibleTrace.length) {
			lines.push(
				truncateToWidth(theme.fg("dim", `  已折叠 ${turn.trace.length - visibleTrace.length} 条过程`), width),
			);
		}
		if (visibleTrace.length === 0 && turn.status === "running") {
			lines.push(truncateToWidth(theme.fg("dim", "  等待进展…"), width));
		}
		const subtasks = Object.values(turn.subtasks);
		if (subtasks.length > 0) {
			const summary = subtasks.map((subtask) => `${subtask.title}:${subtask.status}`).join(" · ");
			lines.push(truncateToWidth(theme.fg("dim", `  子任务 ${summary}`), width));
		}
		if (turn.progressSummary) {
			lines.push(truncateToWidth(theme.fg("dim", `  最近进展 ${turn.progressSummary}`), width));
		}
		return lines;
	}

	private renderResult(turn: MetaWorkTurnProjection, width: number): string[] {
		const lines: string[] = [];
		const result = turn.result;
		if (result?.verification === "streaming") {
			lines.push(truncateToWidth(theme.fg("dim", "  结果传输中（未完成，不视为最终正文）"), width));
		}
		if (result?.verification === "failed") {
			// hash/字节校验失败 = 结果传输问题，不是 Kernel 认证失败、不是 Task 重试理由。
			lines.push(truncateToWidth(theme.fg("error", "  结果校验失败：传输不完整，请刷新历史"), width));
		}
		const content = turn.answer;
		if (content) {
			this.markdown.setText(content);
			lines.push(...indent(this.markdown.render(Math.max(1, width - 2)), "  "));
			if (turn.answerRef && turn.answerRef.byteLength > Buffer.byteLength(content)) {
				lines.push(...wrapTextWithAnsi(`阅读完整结果：/read ${turn.answerRef.hash} 0`, width));
			}
			if (result && (result.verification === "certified" || result.verification === "uncertified")) {
				const label = result.verification === "certified" ? "已认证" : "未认证";
				lines.push(truncateToWidth(theme.fg("dim", `  [结果 ${label}]`), width));
			}
		}
		return lines;
	}
}

function indent(lines: string[], prefix: string): string[] {
	return lines.map((line) => `${prefix}${line}`);
}
