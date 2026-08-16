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

		expect(prompt).toContain("PlanningAgentPlan v7");
		expect(prompt).toContain("Every completed semantic turn MUST call submit_planning_proposal");
		expect(prompt.match(new RegExp(marker, "g"))).toHaveLength(1);
	});

	it("contains the migrated Planner behavior without embedding dynamic routing facts", () => {
		const prompt = buildAnyFusionPlannerSystemPrompt();

		expect(prompt).toContain("copy it verbatim from the prior user turn");
		expect(prompt).toContain("There is no proposal-specific retry limit or outer repair loop");
		expect(prompt).toContain("The submit_planning_proposal tool schema is the sole field-level authority");
		expect(prompt).toContain("workGraph` is a top-level sibling of `task`");
		expect(prompt).not.toContain("deliveryKind");
		expect(prompt).not.toContain("reasons_note");
		expect(prompt).toContain("complete ordered set of canonical AgentClasses");
		expect(prompt).toContain("Their arrival is not a semantic turn");
		expect(prompt).toContain("only when the current user explicitly asks");
		expect(prompt).not.toContain("ANYFUSION_PLANNER_CATALOG_JSON");
		expect(prompt).not.toContain('"name": "codex-cli"');
	});

	it("fails closed when the fixed Skill is missing", () => {
		expect(() => buildAnyFusionPlannerSystemPrompt(join(tmpdir(), "missing-anyfusion-planner-skill.md"))).toThrow(
			"fixed Skill is unavailable",
		);
	});
});
