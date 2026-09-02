import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAnyFusionPlannerBootstrap } from "../src/anyfusion/planner-bootstrap.ts";
import { PLANNER_ACTIVE_TOOL_NAMES } from "../src/anyfusion/planner-policy.ts";

describe("AnyFusion Planner bootstrap", () => {
	it("gives Native TUI and RPC the same fixed prompt, tools, and extension factory shape", async () => {
		const suffix = `${process.pid}-${Date.now()}`;
		const schemaPath = join(tmpdir(), `planner-v8-${suffix}.json`);
		const skillPath = join(tmpdir(), `planner-skill-${suffix}.md`);
		await writeFile(schemaPath, JSON.stringify({ type: "object", properties: { schemaVersion: { const: 8 } } }));
		await writeFile(skillPath, "# Fixed Planner Skill\n");

		const tui = createAnyFusionPlannerBootstrap({ cwd: "/workspace", schemaPath, skillPath });
		const rpc = createAnyFusionPlannerBootstrap({ cwd: "/workspace", schemaPath, skillPath });

		expect(tui.systemPrompt).toBe(rpc.systemPrompt);
		expect(tui.activeToolNames).toEqual([...PLANNER_ACTIVE_TOOL_NAMES]);
		expect(rpc.activeToolNames).toEqual(tui.activeToolNames);
		expect(tui.customTools.map((tool) => tool.name)).toEqual([
			"web_fetch",
			"web_search",
			"submit_planning_proposal",
			"submit_executor_manual_proposal",
		]);
		expect(tui.customTools.find((tool) => tool.name === "submit_planning_proposal")?.description).toContain(
			"PlanningAgentPlan v8",
		);
		expect(tui.customTools.find((tool) => tool.name === "submit_planning_proposal")?.promptSnippet).toContain(
			"PlanningAgentPlan v8",
		);
		expect(
			tui.customTools.find((tool) => tool.name === "submit_executor_manual_proposal")?.promptGuidelines,
		).toEqual(expect.arrayContaining([
			expect.stringContaining("copy that existing tag text verbatim"),
			expect.stringContaining("Do not add assertions for adjacent capabilities"),
			expect.stringContaining("capability-policy"),
		]));
		expect(tui.customTools.find((tool) => tool.name === "web_fetch")?.promptGuidelines).toEqual(
			expect.arrayContaining([
				expect.stringContaining("supplied public URL"),
			]),
		);
		expect(tui.customTools.find((tool) => tool.name === "web_search")?.promptGuidelines).toEqual(
			expect.arrayContaining([
				expect.stringContaining("real-time"),
			]),
		);
		expect(tui.extensionFactories).toHaveLength(1);
		expect(rpc.extensionFactories).toHaveLength(1);
	});

	it("accepts a managed project below the Linux workspace boundary", async () => {
		const schemaPath = join(tmpdir(), `planner-v8-managed-${process.pid}-${Date.now()}.json`);
		await writeFile(schemaPath, JSON.stringify({ type: "object" }));
		expect(() =>
			createAnyFusionPlannerBootstrap({
				cwd: "/workspace/default",
				schemaPath,
			}),
		).not.toThrow();
	});

	it("fails closed outside the Linux workspace boundary", () => {
		expect(() => createAnyFusionPlannerBootstrap({ cwd: "/tmp/project" })).toThrow(
			"cwd must be inside the Runtime-authorized workspace /workspace",
		);
	});

	it("accepts the Runtime-authorized native workspace", async () => {
		const previous = process.env.ANYFUSION_PLANNER_WORKSPACE;
		const schemaPath = join(tmpdir(), `planner-native-${process.pid}-${Date.now()}.json`);
		await writeFile(schemaPath, JSON.stringify({ type: "object" }));
		process.env.ANYFUSION_PLANNER_WORKSPACE = "/tmp/project";
		try {
			expect(() => createAnyFusionPlannerBootstrap({ cwd: "/tmp/project", schemaPath })).not.toThrow();
		} finally {
			if (previous === undefined) delete process.env.ANYFUSION_PLANNER_WORKSPACE;
			else process.env.ANYFUSION_PLANNER_WORKSPACE = previous;
		}
	});

	it("reports the active PlanningAgentPlan version for an invalid schema artifact", async () => {
		const schemaPath = join(tmpdir(), `planner-v8-invalid-${process.pid}-${Date.now()}.json`);
		await writeFile(schemaPath, JSON.stringify([]));

		expect(() => createAnyFusionPlannerBootstrap({ cwd: "/workspace", schemaPath })).toThrow(
			"PlanningAgentPlan v8 schema must be a JSON object",
		);
	});

  it("exposes only the Executor manual proposal tool during configuration turns", async () => {
		const previousPurpose = process.env.ANYFUSION_PLANNER_TURN_PURPOSE;
		process.env.ANYFUSION_PLANNER_TURN_PURPOSE = "configuration";
		try {
			const bootstrap = createAnyFusionPlannerBootstrap({ cwd: "/workspace" });
			expect(bootstrap.customTools.map((tool) => tool.name)).toEqual(["submit_executor_manual_proposal"]);
			expect(bootstrap.customTools.find((tool) => tool.name === "submit_planning_proposal")).toBeUndefined();
			expect(bootstrap.activeToolNames).toEqual(["submit_executor_manual_proposal"]);
      expect(bootstrap.thinkingLevelOverride).toBe("low");
      expect(bootstrap.extensionFactories).toEqual([]);
      expect(bootstrap.systemPrompt).toContain(
        "If that tool cannot be called, output only the same JSON object that the tool accepts",
      );
    } finally {
			if (previousPurpose === undefined) delete process.env.ANYFUSION_PLANNER_TURN_PURPOSE;
			else process.env.ANYFUSION_PLANNER_TURN_PURPOSE = previousPurpose;
		}
	});

	it("wires the bootstrap tool allowlist into the real CLI AgentSession", () => {
		const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
		expect(mainSource).toContain("tools: plannerBootstrap?.activeToolNames ?? sessionOptions.tools");
	});
});
