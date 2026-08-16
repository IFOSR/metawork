import type { Component, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	AnyFusionPlannerWorkspaceComponent,
	AnyFusionTaskDashboardComponent,
} from "../src/modes/interactive/components/anyfusion-task-dashboard.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

class ConversationComponent implements Component {
	invalidate(): void {}
	render(width: number): string[] {
		return [`conversation:${width}`];
	}
}

const snapshot = {
	schemaVersion: 1,
	session: {
		focusedTask: { id: "task-1", title: "Ship dashboard", status: "running" },
		runtimeState: { runningExecutorName: "codex-cli", lastEvent: "attempt_started" },
		plannerState: { status: "idle" },
	},
	taskPool: [
		{
			id: "task-1",
			title: "Ship dashboard",
			goal: "Show task state",
			status: "running",
			blockingReason: null,
			subtasks: [{ id: "sub-1", title: "Render panel", status: "running", preferredAgentClassList: ["codex-cli"] }],
		},
		{
			id: "task-2",
			title: "Blocked task",
			goal: "Wait",
			status: "blocked",
			blockingReason: "input required",
			subtasks: [],
		},
	],
	executorStatuses: [
		{
			id: "codex-cli",
			enabled: true,
			verification: "verified",
			driver: "codex",
			binaryPath: "/usr/bin/codex",
			classHealth: "healthy",
		},
	],
	smokeRunAudits: [
		{
			runId: "smoke-1",
			scenario: "artifact",
			result: "passed",
			completedAt: "2026-08-07T00:00:00.000Z",
		},
	],
};

beforeAll(() => initTheme("dark"));

const dashboards: AnyFusionTaskDashboardComponent[] = [];

function createDashboard(requestRender = vi.fn()): AnyFusionTaskDashboardComponent {
	const dashboard = new AnyFusionTaskDashboardComponent({ requestRender } as unknown as TUI);
	dashboards.push(dashboard);
	return dashboard;
}

afterEach(() => {
	for (const dashboard of dashboards.splice(0)) dashboard.dispose();
	vi.useRealTimers();
});

describe("AnyFusion Task dashboard", () => {
	it("renders focused task, subtask, task pool, and executor projection", () => {
		const dashboard = createDashboard();
		expect(dashboard.setSnapshot(snapshot)).toBe(true);
		const output = stripAnsi(dashboard.render(42).join("\n"));
		expect(output).toContain("AnyFusion Tasks");
		expect(output).toContain("Ship dashboard");
		expect(output).toContain("Render panel");
		expect(output).toContain("codex-cli");
		expect(output).toContain("Executing");
		expect(output).toContain("执行中");
		expect(output).toContain("Task pool (2)");
		expect(output).toContain("Latest smoke");
		expect(output).toContain("artifact · passed");
	});

	it("hides the dashboard on narrow terminals and composes it beside conversation on wide terminals", () => {
		const dashboard = createDashboard();
		dashboard.setSnapshot(snapshot);
		const workspace = new AnyFusionPlannerWorkspaceComponent(new ConversationComponent(), dashboard);
		const narrow = stripAnsi(workspace.render(80).join("\n"));
		expect(narrow).toBe("conversation:80");
		const wide = stripAnsi(workspace.render(140).join("\n"));
		expect(wide).toContain("conversation:97");
		expect(wide).toContain("AnyFusion Tasks");
		expect(workspace.render(140).every((line) => stripAnsi(line).length <= 140)).toBe(true);
	});

	it("bottom-aligns the dashboard so it remains visible beside a long transcript viewport", () => {
		const dashboard = createDashboard();
		dashboard.setSnapshot(snapshot);
		const longConversation: Component = {
			invalidate: () => {},
			render: () => Array.from({ length: 40 }, (_, index) => `conversation line ${index + 1}`),
		};
		const workspace = new AnyFusionPlannerWorkspaceComponent(longConversation, dashboard);
		const output = workspace.render(140).map(stripAnsi);
		const visibleTail = output.slice(-24).join("\n");
		expect(visibleTail).toContain("AnyFusion Tasks");
		expect(output.at(-1)).toContain("└");
	});
	it("degrades malformed snapshots without affecting conversation rendering", () => {
		const dashboard = createDashboard();
		expect(dashboard.setSnapshot({ taskPool: [] })).toBe(false);
		const panel = stripAnsi(dashboard.render(42).join("\n"));
		expect(panel).toContain("Snapshot unavailable or stale");
		const workspace = new AnyFusionPlannerWorkspaceComponent(new ConversationComponent(), dashboard);
		expect(stripAnsi(workspace.render(80).join("\n"))).toBe("conversation:80");
	});

	it("animates only while an Executor is running", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const dashboard = createDashboard(requestRender);
		dashboard.setSnapshot(snapshot);
		const initial = stripAnsi(dashboard.render(42).join("\n"));
		vi.advanceTimersByTime(80);
		const advanced = stripAnsi(dashboard.render(42).join("\n"));
		expect(advanced).not.toBe(initial);
		expect(requestRender).toHaveBeenCalled();

		dashboard.setSnapshot({
			...snapshot,
			session: {
				...snapshot.session,
				runtimeState: { ...snapshot.session.runtimeState, runningExecutorName: null },
			},
		});
		const settled = stripAnsi(dashboard.render(42).join("\n"));
		vi.advanceTimersByTime(160);
		expect(stripAnsi(dashboard.render(42).join("\n"))).toBe(settled);
		expect(settled).not.toContain("Executing");
	});
});
