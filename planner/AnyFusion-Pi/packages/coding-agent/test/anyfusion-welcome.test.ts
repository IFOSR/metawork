import { beforeAll, describe, expect, it } from "vitest";
import { AnyFusionWelcomeComponent } from "../src/modes/interactive/components/anyfusion-welcome.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme("dark"));

describe("AnyFusion welcome", () => {
	it("renders the pixel logo, version, connection, workspace, model, and task summary", () => {
		const welcome = new AnyFusionWelcomeComponent({
			version: "0.80.2",
			getWorkspace: () => "/workspace/anyint",
			getModel: () => "openai/gpt-5.6",
			getDashboardSummary: () => ({
				connectionState: "connected",
				plannerStatus: "idle",
				focusedTask: { title: "Migrate TUI", status: "running" },
				taskCount: 2,
				runningExecutorName: "codex-cli",
			}),
			compactInstructions: "/ commands · Tab complete",
			expandedInstructions: "/ commands\nTab complete",
			onboarding: "Planner boundary",
		});
		const output = stripAnsi(welcome.render(80).join("\n"));
		expect(output).toContain("Planner v0.80.2");
		expect(output).toContain("MetaClaw connected");
		expect(output).toContain("anyint · openai/gpt-5.6 · planner idle");
		expect(output).toContain("Tasks 2 · Migrate TUI · running · executor codex-cli");
		expect(output).toContain("█████");
	});

	it("uses a compact branded mark on narrow terminals", () => {
		const welcome = new AnyFusionWelcomeComponent({
			version: "0.80.2",
			getWorkspace: () => "/workspace",
			getModel: () => "model",
			getDashboardSummary: () => ({
				connectionState: "connecting",
				plannerStatus: "waiting",
				focusedTask: null,
				taskCount: 0,
				runningExecutorName: null,
			}),
			compactInstructions: "",
			expandedInstructions: "",
			onboarding: "",
		});
		expect(stripAnsi(welcome.render(40).join("\n"))).toContain("◆ ANYFUSION");
	});
});
