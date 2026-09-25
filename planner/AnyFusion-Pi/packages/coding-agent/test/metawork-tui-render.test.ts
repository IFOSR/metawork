/**
 * MetaWork TUI 组件渲染与布局测试（统一 TUI 设计 §8.1、§15.2）。
 */

import { stripVTControlCharacters } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { computeMetaWorkLayout, formatSilence, formatTaskDuration } from "../src/modes/metawork-tui/layout.ts";
import { MetaWorkConversationPanel } from "../src/modes/metawork-tui/components/conversation-panel.ts";
import type { MetaWorkConversationPanelState } from "../src/modes/metawork-tui/components/conversation-panel.ts";
import { MetaWorkTaskDashboard } from "../src/modes/metawork-tui/components/task-dashboard-panel.ts";
import { MetaWorkActionBar, MetaWorkHeader } from "../src/modes/metawork-tui/components/status-bar.ts";
import { zipColumns } from "../src/modes/metawork-tui/components/root.ts";
import type { MetaWorkTurnProjection } from "../src/modes/metawork-tui/model.ts";

beforeAll(() => initTheme("dark"));

function turn(overrides: Partial<MetaWorkTurnProjection> = {}): MetaWorkTurnProjection {
	return {
		id: "turn_1",
		requestId: "req_1",
		interactionKind: "ai_turn",
		userInput: "分析一下",
		status: "running",
		stage: "planning",
		taskId: null,
		progressSummary: null,
		taskStartedAt: null,
		taskCompletedAt: null,
		lastEventAt: null,
		trace: [],
		subtasks: {},
		permission: null,
		result: null,
		artifacts: [],
		answer: "",
		answerSources: [],
		error: null,
		startedAtSequence: 1,
		...overrides,
	};
}

function plain(lines: string[]): string[] {
	return lines.map(line => stripVTControlCharacters(line).replace(/\s+$/u, ""));
}

describe("metawork-tui layout", () => {
	it("keeps conversation priority and overlay task panel on 80x24", () => {
		const layout = computeMetaWorkLayout(80, 24);
		expect(layout.variant).toBe("compact");
		expect(layout.taskPanel).toBe("overlay");
		expect(layout.conversationWidth).toBe(80);
		expect(layout.editorRows).toBeGreaterThanOrEqual(1);
	});

	it("places conversation and task panel side by side on 120x36", () => {
		const layout = computeMetaWorkLayout(120, 36);
		expect(layout.variant).toBe("standard");
		expect(layout.taskPanel).toBe("inline");
		expect(layout.taskPanelWidth).toBeGreaterThanOrEqual(30);
		expect(layout.conversationWidth).toBeGreaterThanOrEqual(24);
		expect(layout.conversationWidth + (layout.taskPanelWidth ?? 0)).toBeLessThan(120);
	});

	it("widens panels on 160x48 without auto-expanding history", () => {
		const wide = computeMetaWorkLayout(160, 48);
		const standard = computeMetaWorkLayout(120, 36);
		expect(wide.variant).toBe("wide");
		expect(wide.taskPanelWidth!).toBeGreaterThanOrEqual(standard.taskPanelWidth!);
		expect(wide.expandAllTrace).toBe(false);
		expect(wide.maxVisibleTurns).toBeGreaterThan(standard.maxVisibleTurns);
	});

	it("never produces negative widths on degenerate terminals", () => {
		for (const [columns, rows] of [[0, 0], [1, 1], [20, 5], [39, 9], [-5, -5]] as const) {
			const layout = computeMetaWorkLayout(columns, rows);
			expect(layout.conversationWidth).toBeGreaterThanOrEqual(1);
			expect(layout.columns).toBeGreaterThanOrEqual(1);
			expect(layout.rows).toBeGreaterThanOrEqual(1);
			expect(layout.editorRows).toBeGreaterThanOrEqual(1);
			expect(layout.maxVisibleTurns).toBeGreaterThanOrEqual(1);
		}
	});

	it("formats durations from server timestamps and silence separately", () => {
		const start = "2026-09-19T00:00:00.000Z";
		const end = "2026-09-19T00:02:05.000Z";
		expect(formatTaskDuration(start, end, Date.parse(end))).toBe("2m5s");
		expect(formatTaskDuration(null, end, Date.parse(end))).toBeNull();
		expect(formatTaskDuration(start, null, Date.parse(start) + 3_600_000)).toBe("1h0m");
		expect(formatSilence("2026-09-19T00:00:00.000Z", Date.parse("2026-09-19T00:05:00.000Z"))).toBe("5m");
		expect(formatSilence(null, Date.now())).toBeNull();
	});
});

describe("metawork-tui conversation panel", () => {
	it("moves the visible window to the selected historical Turn", () => {
		const panel = new MetaWorkConversationPanel(() => ({
			turns: ["old", "middle", "new"].map(id => turn({ id, userInput: `${id} question` })),
			selectedTurnId: "old", expandedTurnIds: [], historyStatus: "exhausted",
			connection: "ready", maxVisibleTurns: 1,
		}));
		const text = plain(panel.render(80)).join("\n");
		expect(text).toContain("old question");
		expect(text).not.toContain("new question");
	});

	function panelState(overrides: Partial<MetaWorkConversationPanelState> = {}): MetaWorkConversationPanelState {
		return {
			turns: [],
			selectedTurnId: null,
			expandedTurnIds: [],
			historyStatus: "exhausted",
			connection: "ready",
			maxVisibleTurns: 10,
			...overrides,
		};
	}

	it("renders user request, safe process summary and markdown result once", () => {
		const panel = new MetaWorkConversationPanel(() => panelState({
			turns: [turn({
				status: "completed",
				stage: "delivery",
				trace: [
					{ eventKey: "k1", stage: "planning", actor: "planner", title: "规划", summary: "生成计划", occurredAt: null },
					{ eventKey: "k2", stage: "execution", actor: "kernel", title: "派发", summary: "", occurredAt: null },
				],
				answer: "## 结果\n最终回答",
				result: {
					resultId: "result_1",
					content: "最终回答",
					contentHash: "sha256:x",
					byteLength: 4,
					certification: "certified",
					verification: "certified",
				},
			})],
			selectedTurnId: "turn_1",
		}));
		const text = plain(panel.render(80)).join("\n");
		expect(text).toContain("分析一下");
		expect(text).toContain("规划 · planner · 规划");
		// 未展开时只显示最近两条过程并提示折叠数量。
		expect(text).not.toContain("已折叠");
		expect(text).toContain("结果");
		expect(text).toContain("[结果 已认证]");
		expect(text.match(/最终回答/gu)?.length).toBe(1);
	});

	it("marks streaming and failed result transport without faking completeness", () => {
		const streaming = new MetaWorkConversationPanel(() => panelState({
			turns: [turn({
				result: {
					resultId: "r1",
					content: "部分",
					contentHash: "",
					byteLength: 0,
					certification: "certified",
					verification: "streaming",
				},
			})],
		}));
		expect(plain(streaming.render(80)).join("\n")).toContain("结果传输中");

		const failed = new MetaWorkConversationPanel(() => panelState({
			turns: [turn({
				result: {
					resultId: "r1",
					content: "部分",
					contentHash: "sha256:no",
					byteLength: 99,
					certification: "certified",
					verification: "failed",
				},
			})],
		}));
		const failedText = plain(failed.render(80)).join("\n");
		expect(failedText).toContain("结果校验失败");
		expect(failedText).not.toContain("已认证");
	});

	it("shows explicit missing-history hints instead of pretending all history is loaded", () => {
		const partial = new MetaWorkConversationPanel(() => panelState({
			historyStatus: "partial",
			turns: [turn({})],
		}));
		expect(plain(partial.render(80)).join("\n")).toContain("更早的历史未加载");

		const unavailable = new MetaWorkConversationPanel(() => panelState({
			historyStatus: "unavailable",
		}));
		expect(plain(unavailable.render(80)).join("\n")).toContain("历史不可用");
	});

	it("renders system commands as compact blocks separated from task progress", () => {
		const panel = new MetaWorkConversationPanel(() => panelState({
			turns: [turn({
				interactionKind: "system_command",
				userInput: "/task list",
				status: "completed",
				answer: "共 2 个任务",
				subtasks: {
					sub_1: { id: "sub_1", title: "子任务", status: "running", progress: "执行中", executor: "codex-cli", heartbeatAt: null },
				},
			})],
		}));
		const text = plain(panel.render(80)).join("\n");
		expect(text).toContain("系统命令");
		expect(text).toContain("共 2 个任务");
		expect(text).toContain("子任务 子任务:running");
	});

	it("strips control characters from untrusted turn text", () => {
		const panel = new MetaWorkConversationPanel(() => panelState({
			turns: [turn({ userInput: "危险\u001b[2J输入", error: "失败\u0007了" })],
		}));
		const text = plain(panel.render(80)).join("\n");
		expect(text).toContain("危险输入");
		expect(text).not.toContain("[2J");
	});
});

describe("metawork-tui task dashboard", () => {
	it("shows all parallel subtasks with server timing and no fabricated values", () => {
		const dashboard = new MetaWorkTaskDashboard(
			() => ({
				selectedTurn: turn({
					taskId: "task_1",
					status: "running",
					progressSummary: "执行中",
					taskStartedAt: "2026-09-19T00:00:00.000Z",
					lastEventAt: "2026-09-19T00:00:30.000Z",
					subtasks: {
						sub_a: { id: "sub_a", title: "A", status: "running", progress: "", executor: "codex-cli", heartbeatAt: null },
						sub_b: { id: "sub_b", title: "B", status: "running", progress: "", executor: "pi-agent", heartbeatAt: null },
					},
					permission: { requestId: "perm_1", summary: "写入文件", status: "pending" },
				}),
				connectionLabel: "已连接",
				expanded: true,
			}),
			() => Date.parse("2026-09-19T00:01:00.000Z"),
		);
		const text = plain(dashboard.render(40)).join("\n");
		expect(text).toContain("Task: task_1");
		expect(text).toContain("运行时长 1m0s");
		expect(text).toContain("A");
		expect(text).toContain("B");
		expect(text).toContain("权限 pending: 写入文件");
	});

	it.each([36, 40, 45, 52, 120])("renders complete bill statistics in a %i-column task panel", (width) => {
		const dashboard = new MetaWorkTaskDashboard(() => ({
			selectedTurn: turn({
				taskId: "task_1",
				status: "completed",
				turnBill: {
					userStatus: "billed",
					headline: "本次费用：1.416796 MetaCoin",
					amountMicroCoin: "1.416796",
					amountIsFinal: true,
					diagnosticMessage: null,
					stageBreakdown: [
						{
							stage: "execution",
							agentClassRef: "pi-research",
							providerRef: "deepseek",
							modelId: "deepseek-flash",
							inputTokens: "851879",
							outputTokens: "25047",
							totalTokens: "876926",
							assessedMetaCoin: "1.332894",
							costStatus: "calculated",
						},
						{
							stage: "planning",
							agentClassRef: "planner",
							providerRef: "deepseek",
							modelId: "deepseek-flash",
							inputTokens: "50814",
							outputTokens: "2279",
							totalTokens: "53093",
							assessedMetaCoin: "0.083902",
							costStatus: "calculated",
						},
					],
					billId: "bill_1",
					finalizedAt: "2026-09-19T00:05:00.000Z",
				},
			}),
			connectionLabel: "已连接",
			expanded: false,
		}));
		const lines = plain(dashboard.render(width));
		const text = lines.join("\n");
		// 金额是 MetaCoin 十进制展示，不是原始 microCoin。
		expect(text).toContain("账单 已计费 · 1.416796 MetaCoin");
		expect(text).toContain("Executor · pi-research");
		expect(text).toContain("deepseek/deepseek-flash");
		expect(text).toContain("输入 851879");
		expect(text).toContain("输出 25047");
		expect(text).toContain("合计 876926");
		expect(text).toContain("1.332894 MetaCoin");
		expect(text).toContain("Planner · planner");
		expect(text).toContain("输入 50814");
		expect(text).toContain("输出 2279");
		expect(text).toContain("合计 53093");
		expect(text).toContain("0.083902 MetaCoin");
		expect(text).not.toContain("1416796");
	});

	it("explains why a task is waiting for execution capacity", () => {
		const dashboard = new MetaWorkTaskDashboard(() => ({
			selectedTurn: turn({
				taskId: "task_queued",
				status: "running",
				taskStatus: "ready",
				schedulingReason: "account_task_capacity",
			}),
			connectionLabel: "已连接",
			expanded: false,
		}));

		const text = plain(dashboard.render(80)).join("\n");
		expect(text).toContain("排队原因：账户并发容量已满");
	});

	it("shows the diagnostic message while metering is settling and a fallback without a view", () => {
		const pending = new MetaWorkTaskDashboard(() => ({
			selectedTurn: turn({
				taskId: "task_1",
				turnBill: {
					userStatus: "unconfirmed",
					headline: "费用暂时无法确认",
					amountMicroCoin: null,
					amountIsFinal: false,
					diagnosticMessage: "请求仍在等待计量收束",
					stageBreakdown: [],
					billId: null,
					finalizedAt: null,
				},
			}),
			connectionLabel: "已连接",
			expanded: false,
		}));
		const text = plain(pending.render(80)).join("\n");
		expect(text).toContain("账单 待确认 · 请求仍在等待计量收束");

		const noView = new MetaWorkTaskDashboard(() => ({
			selectedTurn: turn({ taskId: "task_1", turnBill: null }),
			connectionLabel: "已连接",
			expanded: false,
		}));
		expect(plain(noView.render(80)).join("\n")).toContain("账单 暂不可用");
	});

	it("shows 暂无信息 when the turn has no task or timing facts", () => {
		const dashboard = new MetaWorkTaskDashboard(() => ({
			selectedTurn: turn({ taskId: "task_1" }),
			connectionLabel: "已连接",
			expanded: false,
		}));
		const text = plain(dashboard.render(40)).join("\n");
		expect(text).toContain("运行时长 暂无信息");
		expect(text).toContain("暂无信息");

		const noTask = new MetaWorkTaskDashboard(() => ({
			selectedTurn: turn({}),
			connectionLabel: "已连接",
			expanded: false,
		}));
		expect(plain(noTask.render(40)).join("\n")).toContain("该 Turn 暂无关联 Task");
	});
});

describe("metawork-tui status bar", () => {
	it("reports connection, workspace, selected turn and missing capabilities", () => {
		const header = new MetaWorkHeader(() => ({
			connection: "ready",
			serverCapabilitiesMissing: [],
			workspacePath: "/repo",
			workspaceDisplayName: "repo",
			workspaceAvailability: "available",
			conversationTitle: "会话一",
			conversationId: "conv_1",
			navigationPending: false,
			selectedTurnId: "turn_1",
			selectedTurnStatus: "running",
		}));
		const text = plain(header.render(120)).join("\n");
		expect(text).toContain("MetaWork");
		expect(text).toContain("repo");
		expect(text).toContain("会话一");
		expect(text).toContain("已连接");

		const incompatible = new MetaWorkHeader(() => ({
			connection: "incompatible",
			serverCapabilitiesMissing: ["task_view_v1"],
			workspacePath: null,
			workspaceDisplayName: null,
			workspaceAvailability: null,
			conversationTitle: null,
			conversationId: null,
			navigationPending: false,
			selectedTurnId: null,
			selectedTurnStatus: null,
		}));
		const incompatibleText = plain(incompatible.render(120)).join("\n");
		expect(incompatibleText).toContain("请升级 Server");
		expect(incompatibleText).toContain("task_view_v1");
	});

	it("shows cancel request state without claiming executor exit", () => {
		const bar = new MetaWorkActionBar(() => ({
			operation: null,
			commandHint: null,
			permissionSummary: "写入文件",
			submitting: false,
			awaitingReceipt: null,
			cancelling: true,
			cancelResult: null,
			notice: null,
			silence: "30s",
			focus: "editor",
		}));
		const text = plain(bar.render(120)).join("\n");
		expect(text).toContain("正在请求取消");
		expect(text).toContain("仅表示未收到更新");
		expect(text).toContain("权限请求待处理");
	});
});

describe("metawork-tui root body", () => {
	it("zips conversation and task columns without negative widths", () => {
		const lines = zipColumns(["左边一", "左边二"], ["右边一"], 10, 6, 2);
		expect(stripVTControlCharacters(lines[0]!)).toBe("左边一      右边一");
		expect(stripVTControlCharacters(lines[1]!).trimEnd()).toBe("左边二");
	});

	it("truncates overlong columns instead of overflowing", () => {
		const lines = zipColumns(["这是一个很长的左边内容"], ["右边"], 6, 4, 1);
		const plainLine = stripVTControlCharacters(lines[0]!);
		expect(plainLine).toContain("右边");
		expect(plainLine.length).toBeLessThanOrEqual(11);
	});
});
