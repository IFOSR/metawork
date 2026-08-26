import { describe, expect, it } from "vitest";
import { emptyConversationViewModel } from "../src/modes/interactive/metawork-client-model.ts";
import {
	renderConversation,
	type ClientConnectionState,
} from "../src/modes/interactive/metawork-client-view.ts";

describe("MetaWork client view", () => {
	it("renders one turn timeline with progress and one final result", () => {
		const base = emptyConversationViewModel();
		const model = {
			...base,
			workspace: { path: "/workspace/metawork", selectedAt: "2026-08-26T00:00:00.000Z" },
			currentTurn: {
				id: "turn_internal",
				requestId: "req_internal",
				status: "completed" as const,
				stage: "delivery" as const,
				trace: [{
					eventKey: "trace_internal",
					stage: "planning" as const,
					actor: "planner",
					title: "已完成理解",
					summary: "已读取公开上下文",
				}],
				authorization: [],
				subtasks: {
					sub_1: {
						id: "sub_1",
						title: "检查 README",
						status: "completed",
						progress: "已完成",
						heartbeat: false,
					},
				},
				permission: null,
				result: {
					resultId: "result_internal",
					content: "最终报告正文",
					contentHash: "sha256:known",
					byteLength: 21,
					certification: "certified" as const,
					verification: "certified" as const,
				},
				answer: "最终报告正文",
				answerSources: ["result_stream" as const],
				error: null,
			},
		};

		const rendered = renderConversation(model, ["分析仓库"], "connected", 120);

		expect(rendered).toContain("MetaWork");
		expect(rendered).toContain("你");
		expect(rendered).toContain("分析仓库");
		for (const label of ["理解", "规划", "授权", "执行", "验证", "交付"]) {
			expect(rendered).toContain(label);
		}
		expect(rendered).toContain("检查 README");
		expect(rendered.match(/最终报告正文/g)).toHaveLength(1);
		expect(rendered).not.toContain("turn_internal");
		expect(rendered).not.toContain("result_internal");
	});

	it("uses a compact workspace label on narrow terminals and exposes connection state", () => {
		const rendered = renderConversation(
			{
				...emptyConversationViewModel(),
				workspace: { path: "/Users/example/projects/metawork", selectedAt: "2026-08-26T00:00:00.000Z" },
			},
			[],
			"reconnecting",
			80,
		);

		expect(rendered).toContain("reconnecting");
		expect(rendered).toContain("metawork");
		expect(rendered).not.toContain("/Users/example/projects/metawork");
	});
});
