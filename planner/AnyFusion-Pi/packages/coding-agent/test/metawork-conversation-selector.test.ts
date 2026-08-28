import { beforeAll, describe, expect, it, vi } from "vitest";
import { MetaWorkConversationSelector } from "../src/modes/interactive/components/metawork-conversation-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme("dark"));

const workspace = {
	id: "workspace_repo",
	displayName: "MetaWork",
	path: "/repo",
	availability: "available" as const,
};

const conversations = [
	{
		conversationId: "conv_running",
		workspaceId: "workspace_repo",
		title: "实现 Workspace 目录",
		preview: "实现 Workspace 目录",
		updatedAt: new Date().toISOString(),
		activity: {
			state: "executing" as const,
			taskId: "task_1",
			updatedAt: new Date().toISOString(),
		},
	},
	{
		conversationId: "conv_idle",
		workspaceId: "workspace_repo",
		title: "检查文档",
		preview: "检查文档",
		updatedAt: "2026-08-27T00:00:00.000Z",
		activity: {
			state: "idle" as const,
			taskId: null,
			updatedAt: "2026-08-27T00:00:00.000Z",
		},
	},
];

describe("MetaWork Conversation selector", () => {
	it("renders title, activity, and recent update without internal IDs", () => {
		const selector = new MetaWorkConversationSelector(
			workspace,
			conversations,
			{
				attach: vi.fn(),
				create: vi.fn(),
				refresh: vi.fn(),
				cancel: vi.fn(),
			},
		);

		const output = stripAnsi(selector.render(100).join("\n"));
		expect(output).toContain("MetaWork");
		expect(output).toContain("实现 Workspace 目录");
		expect(output).toContain("执行中");
		expect(output).not.toContain("task_1");
		expect(output).not.toContain("conv_running");
		expect(output).toContain("检查文档");
	});

	it("supports navigation, attach, create, refresh, and current-Workspace search", () => {
		const actions = {
			attach: vi.fn(),
			create: vi.fn(),
			refresh: vi.fn(),
			cancel: vi.fn(),
		};
		const selector = new MetaWorkConversationSelector(workspace, conversations, actions);

		selector.handleInput("\u001b[B");
		selector.handleInput("\r");
		expect(actions.attach).toHaveBeenCalledWith("conv_idle");

		selector.handleInput("n");
		selector.handleInput("r");
		expect(actions.create).toHaveBeenCalledOnce();
		expect(actions.refresh).toHaveBeenCalledWith();

		selector.handleInput("/");
		selector.handleInput("文");
		selector.handleInput("档");
		expect(actions.refresh).toHaveBeenLastCalledWith("文档");
		const output = stripAnsi(selector.render(100).join("\n"));
		expect(output).toContain("检查文档");
		expect(output).not.toContain("实现 Workspace 目录");
	});
});
