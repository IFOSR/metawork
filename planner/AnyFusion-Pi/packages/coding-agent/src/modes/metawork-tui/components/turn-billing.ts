import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { theme } from "../../interactive/theme/theme.ts";
import type { MetaWorkBillStageUsage, MetaWorkTurnProjection } from "../model.ts";

/** 金额展示直接透传服务端格式化的十进制 MetaCoin 值，不做换算。 */
function metaCoinDisplay(value: string): string {
	return value;
}

/** 与 Web 端 TurnBillCard 相同的阶段标签映射（统一 TUI 设计 §8.3）。 */
function stageLabel(stage: string | null): string {
	return (
		(
			{
				intake: "接收",
				context: "上下文",
				planning: "Planner",
				execution: "Executor",
				verification: "校验",
				delivery: "交付",
			} as Record<string, string>
		)[stage ?? ""] ??
		stage ??
		"未细分"
	);
}

const BILL_STATUS_LABELS: Record<string, string> = {
	billed: "已计费",
	unconfirmed: "待确认",
	no_charge: "无费用",
};

function stageUsageLines(usage: MetaWorkBillStageUsage, width: number): string[] {
	const identity = `${stageLabel(usage.stage)} · ${usage.agentClassRef ?? "未知 Agent"}`;
	const model =
		usage.providerRef && usage.modelId
			? `${usage.providerRef}/${usage.modelId}`
			: (usage.modelId ?? usage.providerRef ?? "");
	const cost = usage.assessedMetaCoin === null ? "费用待确认" : `${metaCoinDisplay(usage.assessedMetaCoin)} MetaCoin`;
	return [
		identity,
		...(model ? [model] : []),
		`输入 ${usage.inputTokens} 输出 ${usage.outputTokens}`,
		`合计 ${usage.totalTokens}`,
		theme.bold(cost),
	].flatMap((line) => wrap(theme.fg("dim", line), width, Math.min(2, width - 1)));
}

export function billingLines(turn: MetaWorkTurnProjection, width: number): string[] {
	const bill = turn.turnBill;
	if (!bill) {
		// 服务端未启用账单投影时才出现；三态视图保证正常路径下总有视图。
		return [truncateToWidth(theme.fg("dim", "账单 暂不可用"), width)];
	}
	const status = BILL_STATUS_LABELS[bill.userStatus] ?? bill.userStatus;
	const headline =
		bill.amountMicroCoin === null
			? `账单 ${status}${bill.diagnosticMessage ? ` · ${bill.diagnosticMessage}` : ""}`
			: `账单 ${status} · ${metaCoinDisplay(bill.amountMicroCoin)} MetaCoin${bill.amountIsFinal ? "" : "（暂计）"}`;
	const headlineColor = bill.userStatus === "unconfirmed" ? "dim" : "accent";
	return [
		...wrap(theme.fg(headlineColor, theme.bold(headline)), width, 0),
		...bill.stageBreakdown.flatMap((usage) => stageUsageLines(usage, width)),
	];
}

function wrap(text: string, width: number, indent: number): string[] {
	const inner = Math.max(1, width - indent);
	return wrapTextWithAnsi(text, inner).map((line) => `${" ".repeat(indent)}${line}`);
}
