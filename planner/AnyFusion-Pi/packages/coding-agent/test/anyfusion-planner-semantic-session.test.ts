import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAnyFusionPlannerBootstrap } from "../src/anyfusion/planner-bootstrap.ts";
import type { PlannerMcpConnection } from "../src/anyfusion/planner-mcp-extension.ts";
import {
	applyPlannerResourcePolicy,
	PLANNER_MCP_TOOL_NAMES,
	PLANNER_PROPOSAL_TOOL_NAME,
	PLANNER_WEB_TOOL_NAMES,
} from "../src/anyfusion/planner-policy.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("AnyFusion Planner semantic AgentSession", () => {
	let tempDir: string;
	let agentDir: string;
	let previousCommand: string | undefined;
	let previousArgs: string | undefined;
	let previousWorkspace: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `planner-semantic-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		previousCommand = process.env.ANYFUSION_PLANNER_MCP_COMMAND;
		previousArgs = process.env.ANYFUSION_PLANNER_MCP_ARGS_JSON;
		previousWorkspace = process.env.ANYFUSION_PLANNER_WORKSPACE;
		process.env.ANYFUSION_PLANNER_MCP_COMMAND = "/usr/local/bin/node";
		process.env.ANYFUSION_PLANNER_MCP_ARGS_JSON = '["/app/dist/planner-mcp.js"]';
		process.env.ANYFUSION_PLANNER_WORKSPACE = tempDir;
	});

	afterEach(() => {
		restoreEnvironment("ANYFUSION_PLANNER_MCP_COMMAND", previousCommand);
		restoreEnvironment("ANYFUSION_PLANNER_MCP_ARGS_JSON", previousArgs);
		restoreEnvironment("ANYFUSION_PLANNER_WORKSPACE", previousWorkspace);
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("exposes only Web, proposal, and authoritative MCP tools in semantic RPC", async () => {
		const connection = createConnection();
		const schemaPath = join(tempDir, "planning-agent-plan-v8.schema.json");
		writeFileSync(schemaPath, JSON.stringify({ type: "object" }));
		const bootstrap = createAnyFusionPlannerBootstrap({
			cwd: tempDir,
			schemaPath,
			connectionFactory: async () => connection,
		});
		const parsed = {
			noTools: false,
			noBuiltinTools: false,
			tools: [] as string[],
			excludeTools: [] as string[],
			noExtensions: false,
			noSkills: false,
			noPromptTemplates: false,
			noThemes: false,
		};
		applyPlannerResourcePolicy(parsed, { semanticRpc: true });

		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			noExtensions: parsed.noExtensions,
			noSkills: parsed.noSkills,
			noPromptTemplates: parsed.noPromptTemplates,
			noThemes: parsed.noThemes,
			systemPrompt: bootstrap.systemPrompt,
			extensionFactories: bootstrap.extensionFactories,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
			noTools: parsed.noBuiltinTools ? "builtin" : undefined,
			tools: parsed.tools,
			excludeTools: parsed.excludeTools,
			customTools: bootstrap.customTools,
		});

		try {
			await session.bindExtensions({});
			expect(session.getActiveToolNames().sort()).toEqual(
				[...PLANNER_WEB_TOOL_NAMES, PLANNER_PROPOSAL_TOOL_NAME, ...PLANNER_MCP_TOOL_NAMES].sort(),
			);
			expect(session.getActiveToolNames()).not.toEqual(
				expect.arrayContaining(["read", "grep", "find", "ls", "bash", "edit", "write"]),
			);
		} finally {
			session.dispose();
		}
	});
});

function createConnection(): PlannerMcpConnection {
	return {
		listTools: vi.fn(async () => ({
			tools: PLANNER_MCP_TOOL_NAMES.map((name) => ({
				name,
				description: `Description for ${name}`,
				inputSchema: { type: "object" as const },
			})),
		})),
		callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
		close: vi.fn(async () => undefined),
	};
}

function restoreEnvironment(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
