import { stripVTControlCharacters } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { MetaWorkConversationPanel } from "../src/modes/metawork-tui/components/conversation-panel.ts";
import type { MetaWorkTurnProjection } from "../src/modes/metawork-tui/model.ts";

beforeAll(() => initTheme("dark"));

describe("public result controls in the native TUI", () => {
	it("shows authorized decisions, public directories and conflicts at narrow and wide widths", () => {
		const turn: MetaWorkTurnProjection = {
			id: "turn",
			requestId: "request",
			interactionKind: "ai_turn",
			userInput: "启动服务",
			status: "blocked",
			stage: "delivery",
			taskId: "task",
			taskPhase: "needs_action",
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
			resultDecision: {
				actions: ["accept_result"],
				expectedResult: {
					taskId: "task",
					generationId: "g",
					graphRevision: 2,
					subtaskId: "s",
					attemptId: "a",
					resultId: "r",
				},
			},
			publicDelivery: {
				workspace: "/user/repo",
				taskDirectory: "/user/repo/backend",
				mode: "worktree",
				modeSource: "planner",
				deliveryPolicy: "auto_publish",
				state: "failed",
				candidate: "conflict",
				stateLabel: "发布失败",
				files: ["server.mjs"],
				conflicts: ["package.json"],
			},
		};
		const panel = new MetaWorkConversationPanel(() => ({
			turns: [turn],
			selectedTurnId: "turn",
			expandedTurnIds: ["turn"],
			historyStatus: "exhausted",
			connection: "ready",
			maxVisibleTurns: 10,
		}));
		for (const width of [40, 120]) {
			const text = panel
				.render(width)
				.map((line) => stripVTControlCharacters(line))
				.join("\n");
			expect(text).toContain("需要处理");
			expect(text).toContain("/user/repo/backend");
			expect(text).toContain("server.mjs");
			expect(text).toContain("发布失败");
			expect(text).toContain("执行模式: Worktree");
			expect(text).toContain("模式来源: Planner 判断");
			expect(text).toContain("候选: 发布冲突，需要处理后继续");
			expect(text).toContain("package.json");
			expect(text).toContain("接受并交付");
			expect(text).toContain("/task accept-result task");
			expect(text).not.toContain("重新执行");
		}
	});
});
