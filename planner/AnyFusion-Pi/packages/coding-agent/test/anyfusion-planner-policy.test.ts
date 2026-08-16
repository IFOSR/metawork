import { describe, expect, it } from "vitest";
import {
	applyPlannerResourcePolicy,
	METACLAW_SLASH_COMMANDS,
	PLANNER_ACTIVE_TOOL_NAMES,
	PLANNER_ALLOWED_BUILTIN_TOOLS,
	plannerRpcCommandError,
	validatePlannerInvocation,
} from "../src/anyfusion/planner-policy.ts";

describe("AnyFusion Planner policy", () => {
	it("rejects provider, model, and package lifecycle controls", () => {
		expect(validatePlannerInvocation(["--provider", "openai"])).toContain(
			"--provider is managed by AnyFusion and cannot be supplied by the Planner client.",
		);
		expect(validatePlannerInvocation(["update"])[0]).toContain("does not expose");
	});

	it("rejects direct RPC shell and model controls", () => {
		expect(plannerRpcCommandError({ type: "bash", command: "rm -rf /" })).toContain("disabled");
		expect(plannerRpcCommandError({ type: "set_model", provider: "x", modelId: "y" })).toContain("disabled");
		expect(plannerRpcCommandError({ type: "prompt", message: "!cat secret" })).toContain("accepts conversation");
	});

	it("exposes MetaClaw command roots separately from Planner-local commands", () => {
		expect(METACLAW_SLASH_COMMANDS.map((command) => command.name)).toEqual([
			"permission",
			"task",
			"executor",
			"memory",
			"profile",
			"learning",
			"config",
			"help",
			"exit",
		]);
	});

	it("forces the read-only built-in tool surface", () => {
		const parsed = {
			noTools: true,
			noBuiltinTools: true,
			tools: ["bash", "write"],
			excludeTools: [],
			noExtensions: false,
			noSkills: false,
			noPromptTemplates: false,
			noThemes: false,
		};
		applyPlannerResourcePolicy(parsed);
		expect(PLANNER_ALLOWED_BUILTIN_TOOLS).toEqual(["read", "grep", "find", "ls"]);
		expect(parsed.tools).toEqual([...PLANNER_ACTIVE_TOOL_NAMES]);
		expect(parsed.excludeTools).toEqual(["bash", "edit", "write"]);
		expect(parsed.noExtensions).toBe(true);
		expect(parsed.noSkills).toBe(true);
		expect(parsed.noPromptTemplates).toBe(true);
	});
});
