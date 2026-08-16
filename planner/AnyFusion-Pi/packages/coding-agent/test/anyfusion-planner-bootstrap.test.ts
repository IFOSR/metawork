import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAnyFusionPlannerBootstrap } from "../src/anyfusion/planner-bootstrap.ts";
import { PLANNER_ACTIVE_TOOL_NAMES } from "../src/anyfusion/planner-policy.ts";

describe("AnyFusion Planner bootstrap", () => {
	it("gives Native TUI and RPC the same fixed prompt, tools, and extension factory shape", async () => {
		const suffix = `${process.pid}-${Date.now()}`;
		const schemaPath = join(tmpdir(), `planner-v7-${suffix}.json`);
		const skillPath = join(tmpdir(), `planner-skill-${suffix}.md`);
		await writeFile(schemaPath, JSON.stringify({ type: "object", properties: { schemaVersion: { const: 7 } } }));
		await writeFile(skillPath, "# Fixed Planner Skill\n");

		const tui = createAnyFusionPlannerBootstrap({ cwd: "/workspace", schemaPath, skillPath });
		const rpc = createAnyFusionPlannerBootstrap({ cwd: "/workspace", schemaPath, skillPath });

		expect(tui.systemPrompt).toBe(rpc.systemPrompt);
		expect(tui.activeToolNames).toEqual([...PLANNER_ACTIVE_TOOL_NAMES]);
		expect(rpc.activeToolNames).toEqual(tui.activeToolNames);
		expect(tui.customTools.map((tool) => tool.name)).toEqual(["submit_planning_proposal"]);
		expect(tui.extensionFactories).toHaveLength(1);
		expect(rpc.extensionFactories).toHaveLength(1);
	});

	it("accepts a managed project below the Linux workspace boundary", async () => {
		const schemaPath = join(tmpdir(), `planner-v7-managed-${process.pid}-${Date.now()}.json`);
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
});
