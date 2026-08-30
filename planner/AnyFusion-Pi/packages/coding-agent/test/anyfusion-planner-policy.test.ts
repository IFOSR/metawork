import { describe, expect, it } from "vitest";
import {
	applyPlannerResourcePolicy,
	buildPlannerProviderTimeoutOverrides,
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

	it("keeps semantic Provider timeouts inside the outer Planner RPC deadline", () => {
		expect(buildPlannerProviderTimeoutOverrides("180000")).toEqual({
			httpIdleTimeoutMs: 150000,
			websocketConnectTimeoutMs: 30000,
			retry: {
				enabled: false,
				maxRetries: 0,
				provider: {
					timeoutMs: 150000,
					maxRetries: 0,
					maxRetryDelayMs: 1000,
				},
			},
		});
		expect(buildPlannerProviderTimeoutOverrides("invalid")).toBeUndefined();
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

	it("removes repository readers from semantic RPC turns", () => {
		const parsed = {
			noTools: true,
			noBuiltinTools: false,
			tools: ["read", "grep", "find", "ls"],
			excludeTools: [],
			noExtensions: false,
			noSkills: false,
			noPromptTemplates: false,
			noThemes: false,
		};

		applyPlannerResourcePolicy(parsed, { semanticRpc: true });

		expect(parsed.noBuiltinTools).toBe(true);
		expect(parsed.tools).toEqual(
			PLANNER_ACTIVE_TOOL_NAMES.filter(
				(tool) => !PLANNER_ALLOWED_BUILTIN_TOOLS.includes(tool as (typeof PLANNER_ALLOWED_BUILTIN_TOOLS)[number]),
			),
		);
		expect(parsed.tools).not.toContain("read");
		expect(parsed.tools).not.toContain("grep");
		expect(parsed.tools).not.toContain("find");
		expect(parsed.tools).not.toContain("ls");
		expect(parsed.tools).toContain("web_fetch");
		expect(parsed.tools).toContain("web_search");
		expect(parsed.tools).not.toContain("bash");
		expect(parsed.tools).not.toContain("edit");
		expect(parsed.tools).not.toContain("write");
	});
});
