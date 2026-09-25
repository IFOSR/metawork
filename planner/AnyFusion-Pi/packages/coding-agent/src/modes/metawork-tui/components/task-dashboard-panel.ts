/**
 * MetaWork TUI Task Dashboard（统一 TUI 设计 §8.3）。
 *
 * 只展示选中 Turn 的 presentation Task：Conversation → Turn → Task →
 * Subtask → Attempt。Task 与 Turn 的关联来自服务端；不同 Conversation 的
 * 任务不混成一个"当前执行器"；账户级历史阻塞任务不自动插入当前 Turn。
 */

import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { theme } from "../../interactive/theme/theme.ts";
import type { MetaWorkBillStageUsage, MetaWorkTurnProjection } from "../model.ts";
import { formatSilence, formatTaskDuration } from "../layout.ts";

export interface MetaWorkTaskDashboardState {
	readonly selectedTurn: MetaWorkTurnProjection | null;
	readonly connectionLabel: string;
	readonly expanded: boolean;
}

export class MetaWorkTaskDashboard implements Component {
	private readonly getState: () => MetaWorkTaskDashboardState;
	private readonly now: () => number;

	constructor(
		getState: () => MetaWorkTaskDashboardState,
		now: () => number = () => Date.now(),
	) {
		this.getState = getState;
		this.now = now;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const state = this.getState();
		const safeWidth = Math.max(1, width);
		const lines: string[] = [
			truncateToWidth(theme.fg("accent", theme.bold("Task Dashboard")), safeWidth),
		];
		const turn = state.selectedTurn;
		if (!turn) {
			lines.push(truncateToWidth(theme.fg("dim", "未选择 Turn · 暂无信息"), safeWidth));
			return lines;
		}
		if (!turn.taskId) {
			lines.push(truncateToWidth(theme.fg("dim", "该 Turn 暂无关联 Task"), safeWidth));
			lines.push(truncateToWidth(theme.fg("dim", `Turn: ${turn.id} · ${turn.status}`), safeWidth));
			if (turn.turnBill !== undefined) lines.push(...billingLines(turn, safeWidth));
			return lines;
		}

		lines.push(truncateToWidth(theme.fg("text", `Task: ${turn.taskId}`), safeWidth));
		if (turn.taskTitle || turn.taskStatus) {
			lines.push(truncateToWidth(`${turn.taskTitle ?? ""} · ${turn.taskStatus ?? "暂无信息"}`, safeWidth));
		}
		const schedulingLabel = schedulingReasonLabel(turn.schedulingReason);
		if (schedulingLabel) {
			lines.push(truncateToWidth(theme.fg("warning", `排队原因：${schedulingLabel}`), safeWidth));
		}
		if (turn.routing) {
			for (const [label, value] of Object.entries(turn.routing)) {
				if (value) lines.push(truncateToWidth(theme.fg("dim", `${label}: ${value}`), safeWidth));
			}
		}
		lines.push(truncateToWidth(theme.fg("dim", `Turn: ${turn.id} · ${turn.status} · ${turn.stage}`), safeWidth));
		lines.push(...billingLines(turn, safeWidth));
		// 运行时长由服务端开始时间与本地展示时钟计算；结束后使用服务端完成时间冻结。
		const duration = formatTaskDuration(turn.taskStartedAt, turn.taskCompletedAt, this.now());
		const silence = turn.taskCompletedAt ? null : formatSilence(turn.lastEventAt, this.now());
		const timing: string[] = [];
		timing.push(duration ? `运行时长 ${duration}` : "运行时长 暂无信息");
		if (silence) timing.push(`已静默 ${silence}`);
		lines.push(truncateToWidth(theme.fg("dim", timing.join(" · ")), safeWidth));

		if (turn.progressSummary) {
			lines.push(...wrap(theme.fg("text", turn.progressSummary), safeWidth, 0));
		}

		const subtasks = Object.values(turn.subtasks);
		lines.push(truncateToWidth(theme.fg("dim", `Subtasks (${subtasks.length})`), safeWidth));
		if (subtasks.length === 0) {
			lines.push(truncateToWidth(theme.fg("dim", "  暂无信息"), safeWidth));
		}
		for (const subtask of subtasks) {
			// 同一 Task 的多个并行 Subtask 必须同时可见。
			lines.push(truncateToWidth(
				`  ${theme.fg("text", subtask.title)} ${theme.fg("accent", subtask.status)}`
					+ `${subtask.executor ? theme.fg("dim", ` · ${subtask.executor}`) : ""}`,
				safeWidth,
			));
			if (state.expanded && subtask.progress) {
				lines.push(truncateToWidth(theme.fg("dim", `    ${subtask.progress}`), safeWidth));
			}
			for (const attempt of subtask.attempts ?? []) {
				lines.push(truncateToWidth(theme.fg("dim",
					`    ${attempt.label} · ${attempt.status} · ${attempt.attemptId}`), safeWidth));
				const duration = formatTaskDuration(attempt.startedAt,
					["已完成", "失败", "已取消"].includes(attempt.status) ? attempt.updatedAt : null, this.now());
				if (duration) lines.push(truncateToWidth(theme.fg("dim", `      ${duration}`), safeWidth));
				if (state.expanded && attempt.result) {
					lines.push(...wrap(theme.fg("dim", attempt.result), safeWidth, 6));
				}
			}
		}

		if (state.expanded) {
			const trace = turn.trace.slice(-6);
			lines.push(truncateToWidth(theme.fg("dim", `最近过程 (${trace.length}/${turn.trace.length})`), safeWidth));
			for (const item of trace) {
				lines.push(truncateToWidth(theme.fg("dim", `  ${item.title}`), safeWidth));
			}
			lines.push(truncateToWidth(theme.fg("dim", `产物 (${turn.artifacts.length})`), safeWidth));
			for (const artifact of turn.artifacts) {
				lines.push(truncateToWidth(
					`  ${artifact.displayName}${artifact.previewable ? "" : theme.fg("dim", " · 不可预览")}`,
					safeWidth,
				));
			}
		}

		if (turn.permission) {
			const permissionColor = turn.permission.status === "pending" ? "warning" : "dim";
			lines.push(truncateToWidth(
				theme.fg(permissionColor, `权限 ${turn.permission.status}: ${turn.permission.summary}`),
				safeWidth,
			));
		}
		if (turn.result) {
			lines.push(truncateToWidth(
				theme.fg("dim", `结果 ${turn.result.resultId} · ${turn.result.verification}`),
				safeWidth,
			));
		}
		lines.push(truncateToWidth(theme.fg("dim", `连接: ${state.connectionLabel}`), safeWidth));
		return lines;
	}
}

/** 金额展示直接透传服务端格式化的十进制 MetaCoin 值，不做换算。 */
function metaCoinDisplay(value: string): string {
	return value;
}

/** 与 Web 端 TurnBillCard 相同的阶段标签映射（统一 TUI 设计 §8.3）。 */
function stageLabel(stage: string | null): string {
	return ({
		intake: "接收",
		context: "上下文",
		planning: "Planner",
		execution: "Executor",
		verification: "校验",
		delivery: "交付",
	} as Record<string, string>)[stage ?? ""] ?? stage ?? "未细分";
}

const BILL_STATUS_LABELS: Record<string, string> = {
	billed: "已计费",
	unconfirmed: "待确认",
	no_charge: "无费用",
};

function schedulingReasonLabel(reason: string | null | undefined): string | null {
	if (!reason) return null;
	return ({
		account_task_capacity: "账户并发容量已满",
		conversation_slot_occupied: "当前会话已有任务执行中",
		conversation_slot_releasing: "当前会话正在释放执行资源",
		recovery_blocked: "任务正在等待恢复处理",
	} as Record<string, string>)[reason] ?? reason;
}

function stageUsageLines(usage: MetaWorkBillStageUsage, width: number): string[] {
	const identity = `${stageLabel(usage.stage)} · ${usage.agentClassRef ?? "未知 Agent"}`;
	const model = usage.providerRef && usage.modelId ? `${usage.providerRef}/${usage.modelId}` : usage.modelId ?? usage.providerRef ?? "";
	const cost = usage.assessedMetaCoin === null
		? "费用待确认"
		: `${metaCoinDisplay(usage.assessedMetaCoin)} MetaCoin`;
	return [
		identity,
		...(model ? [model] : []),
		`输入 ${usage.inputTokens} 输出 ${usage.outputTokens}`,
		`合计 ${usage.totalTokens}`,
		theme.bold(cost),
	].flatMap(line => wrap(theme.fg("dim", line), width, Math.min(2, width - 1)));
}

function billingLines(turn: MetaWorkTurnProjection, width: number): string[] {
	const bill = turn.turnBill;
	if (!bill) {
		// 服务端未启用账单投影时才出现；三态视图保证正常路径下总有视图。
		return [truncateToWidth(theme.fg("dim", "账单 暂不可用"), width)];
	}
	const status = BILL_STATUS_LABELS[bill.userStatus] ?? bill.userStatus;
	const headline = bill.amountMicroCoin === null
		? `账单 ${status}${bill.diagnosticMessage ? ` · ${bill.diagnosticMessage}` : ""}`
		: `账单 ${status} · ${metaCoinDisplay(bill.amountMicroCoin)} MetaCoin${bill.amountIsFinal ? "" : "（暂计）"}`;
	const headlineColor = bill.userStatus === "unconfirmed" ? "dim" : "accent";
	return [
		...wrap(theme.fg(headlineColor, theme.bold(headline)), width, 0),
		...bill.stageBreakdown.flatMap(usage => stageUsageLines(usage, width)),
	];
}

function wrap(text: string, width: number, indent: number): string[] {
	const inner = Math.max(1, width - indent);
	return wrapTextWithAnsi(text, inner).map(line => `${" ".repeat(indent)}${line}`);
}
