import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAnyFusionPlannerSystemPrompt } from "../src/anyfusion/planner-system-prompt.ts";

describe("AnyFusion Planner system prompt", () => {
	it("injects the fixed Skill exactly once behind stable system rules", async () => {
		const marker = `fixed-skill-marker-${process.pid}-${Date.now()}`;
		const skillPath = join(tmpdir(), `${marker}.md`);
		await writeFile(skillPath, `# Planner Skill\n\n${marker}\n`, "utf8");

		const prompt = buildAnyFusionPlannerSystemPrompt(skillPath);

		expect(prompt).toContain("PlanningAgentPlan v8");
		expect(prompt).toContain("Every completed semantic turn MUST call submit_planning_proposal");
		expect(prompt.match(new RegExp(marker, "g"))).toHaveLength(1);
	});

	it("contains the v8 Planner behavior without embedding dynamic routing facts", () => {
		const prompt = buildAnyFusionPlannerSystemPrompt();

		expect(prompt).toContain("copy it verbatim from the prior user turn");
		expect(prompt).toContain("There is no proposal-specific retry limit or outer repair loop");
		expect(prompt).toContain("The submit_planning_proposal tool schema is the sole field-level authority");
		expect(prompt).toContain("workGraph` is a top-level sibling of `task`");
		expect(prompt).toContain("contains exactly `schemaVersion`, `configurationRevision`, `reason`, and `subtasks`");
		expect(prompt).toContain("set `schemaVersion` to `7`");
		expect(prompt).toContain("copy `configuration.revisionId` verbatim");
		expect(prompt).toContain("`executorBindings`");
		expect(prompt).toContain("`agentClassRef`");
		expect(prompt).toContain('"mode": "fixed-by-agent-class"');
		expect(prompt).toContain('"mode": "proposed"');
		expect(prompt).toContain('"mode": "agent-class-default"');
		expect(prompt).toContain("Never invent AgentClass or Model references");
		expect(prompt).toContain("never bypass Kernel authorization");
		expect(prompt).not.toContain("reasons_note");
		expect(prompt).not.toContain("preferredAgentClassList");
		expect(prompt).toContain("Their arrival is not a semantic turn");
		expect(prompt).toContain("only when the current user explicitly asks");
		expect(prompt).toContain("Never inspect MetaClaw source code, tests, or ADRs to infer Runtime");
		expect(prompt).toContain("Once the required authoritative facts are available, stop querying");
		expect(prompt).toContain("Topical overlap with an existing Task is not explicit task-control intent");
		expect(prompt).toContain("ask one clarification instead of resuming, recovering, or clearing it");
		expect(prompt).not.toContain("ANYFUSION_PLANNER_CATALOG_JSON");
		expect(prompt).not.toContain('"name": "codex-cli"');
	});

	it("requires current runtime facts to override stale persisted planner history", () => {
		const prompt = buildAnyFusionPlannerSystemPrompt();

		expect(prompt).toContain("The latest `get_runtime_state` result is the current fact for the new turn.");
		expect(prompt).toContain("Cancelled Tasks are not active or blocked");
		expect(prompt).toContain("Never use stale Planner conversation history to claim a Task is active or blocked");
	});

	it("keeps direct replies read-only and routes side effects to Executor work", () => {
		const prompt = buildAnyFusionPlannerSystemPrompt();

		expect(prompt).toContain(
			"Use `web_search` or `web_fetch` before a real-time or source-dependent factual `direct_reply`",
		);
		expect(prompt).toContain("Shell execution, file or Git mutation, storage mutation");
		expect(prompt).toContain("must use `plan_work_graph`");
		expect(prompt).toContain("Workspace inspection unavailable to the semantic Planner");
		expect(prompt).toContain("authenticated external action");
		expect(prompt).toContain("durable progress or artifacts");
		expect(prompt).toContain("Do not choose actions from keywords");
		expect(prompt).toContain("A Web tool failure is not a missing user decision");
		expect(prompt).toContain("report the failure accurately in `direct_reply`");
	});

	it("fails closed when the fixed Skill is missing", () => {
		expect(() => buildAnyFusionPlannerSystemPrompt(join(tmpdir(), "missing-anyfusion-planner-skill.md"))).toThrow(
			"fixed Skill is unavailable",
		);
	});
});
