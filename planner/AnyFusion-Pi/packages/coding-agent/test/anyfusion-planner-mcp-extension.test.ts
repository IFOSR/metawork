import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createPlannerMcpExtensionFactory,
	type PlannerMcpConnection,
	readPlannerMcpLaunchConfig,
} from "../src/anyfusion/planner-mcp-extension.ts";
import { PLANNER_MCP_TOOL_NAMES } from "../src/anyfusion/planner-policy.ts";
import { createPlannerProposalGate } from "../src/anyfusion/planner-proposal-gate.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";

const previousCommand = process.env.ANYFUSION_PLANNER_MCP_COMMAND;
const previousArgs = process.env.ANYFUSION_PLANNER_MCP_ARGS_JSON;

beforeEach(() => {
	process.env.ANYFUSION_PLANNER_MCP_COMMAND = "/usr/local/bin/node";
	process.env.ANYFUSION_PLANNER_MCP_ARGS_JSON = '["/app/dist/planner-mcp.js"]';
});

afterEach(() => {
	if (previousCommand === undefined) delete process.env.ANYFUSION_PLANNER_MCP_COMMAND;
	else process.env.ANYFUSION_PLANNER_MCP_COMMAND = previousCommand;
	if (previousArgs === undefined) delete process.env.ANYFUSION_PLANNER_MCP_ARGS_JSON;
	else process.env.ANYFUSION_PLANNER_MCP_ARGS_JSON = previousArgs;
});

describe("AnyFusion Planner MCP extension", () => {
	it("registers exactly the fixed allowlist and ignores extra server tools", async () => {
		const harness = createExtensionHarness();
		const connection = createConnection([...requiredTools(), tool("extra_mutator")]);
		const factory = createPlannerMcpExtensionFactory({
			proposalGate: createPlannerProposalGate(),
			connectionFactory: async () => connection,
		});

		await factory(harness.api);

		expect([...harness.tools.keys()]).toEqual([...PLANNER_MCP_TOOL_NAMES]);
		expect(harness.tools.has("extra_mutator")).toBe(false);
	});

	it("fails closed before the first turn when a required tool is absent", async () => {
		const harness = createExtensionHarness();
		const connection = createConnection(requiredTools().slice(1));
		const factory = createPlannerMcpExtensionFactory({
			proposalGate: createPlannerProposalGate(),
			connectionFactory: async () => connection,
		});

		await expect(factory(harness.api)).rejects.toThrow("missing required tools: search_tasks");
		expect(connection.close).toHaveBeenCalledOnce();
	});

	it("returns ordinary MCP domain errors without treating them as transport failure", async () => {
		const harness = createExtensionHarness();
		const gate = createPlannerProposalGate();
		const connection = createConnection(requiredTools(), {
			content: [{ type: "text", text: "task not found" }],
			isError: true,
		});
		await createPlannerMcpExtensionFactory({ proposalGate: gate, connectionFactory: async () => connection })(
			harness.api,
		);
		const abort = vi.fn();

		const result = await harness.tools
			.get("get_task_context")!
			.execute("call-1", { taskId: "missing" }, undefined, undefined, { abort, ui: { notify: vi.fn() } } as never);

		expect(result.content).toEqual([{ type: "text", text: "task not found" }]);
		expect(gate.unavailableReason).toBeUndefined();
		expect(abort).not.toHaveBeenCalled();
	});

	it("locks proposal and aborts a disconnected turn, then reconnects before the next turn", async () => {
		const harness = createExtensionHarness();
		const gate = createPlannerProposalGate();
		const first = createConnection(requiredTools());
		const second = createConnection(requiredTools());
		let failure: ((error: Error) => void) | undefined;
		let connectionCount = 0;
		await createPlannerMcpExtensionFactory({
			proposalGate: gate,
			connectionFactory: async (_config, onFailure) => {
				failure = onFailure;
				return connectionCount++ === 0 ? first : second;
			},
		})(harness.api);
		const abort = vi.fn();
		const notify = vi.fn();
		const context = { abort, isIdle: () => false, ui: { notify } } as never;
		await harness.emit("before_agent_start", {}, context);

		failure!(new Error("pipe closed"));

		expect(gate.unavailableReason).toContain('"status":"planner_context_unavailable"');
		expect(abort).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("pipe closed"), "error");
		await expect(harness.emit("tool_call", { toolName: "submit_planning_proposal" }, context)).resolves.toMatchObject(
			{
				block: true,
			},
		);

		await harness.emit("before_agent_start", {}, context);

		expect(connectionCount).toBe(2);
		expect(gate.unavailableReason).toBeUndefined();
	});

	it("requires an absolute MetaClaw command and strict string args", () => {
		expect(
			readPlannerMcpLaunchConfig({
				ANYFUSION_PLANNER_MCP_COMMAND: "/usr/local/bin/node",
				ANYFUSION_PLANNER_MCP_ARGS_JSON: '["/app/dist/planner-mcp.js"]',
				ANYFUSION_PLANNER_WORKSPACE: "/workspace",
			}),
		).toEqual({
			command: "/usr/local/bin/node",
			args: ["/app/dist/planner-mcp.js"],
			cwd: "/workspace",
		});
		expect(
			readPlannerMcpLaunchConfig({
				ANYFUSION_PLANNER_MCP_COMMAND: "/usr/local/bin/node",
				ANYFUSION_PLANNER_MCP_ARGS_JSON: "[]",
			}).cwd,
		).toBe(process.cwd());
		expect(() =>
			readPlannerMcpLaunchConfig({
				ANYFUSION_PLANNER_MCP_COMMAND: "node",
				ANYFUSION_PLANNER_MCP_ARGS_JSON: "[]",
			}),
		).toThrow("absolute shared image Node executable");
		expect(() =>
			readPlannerMcpLaunchConfig({
				ANYFUSION_PLANNER_MCP_COMMAND: "/usr/local/bin/node",
				ANYFUSION_PLANNER_MCP_ARGS_JSON: "[1]",
			}),
		).toThrow("only string arguments");
	});
});

function createExtensionHarness() {
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, Array<(event: never, context: never) => unknown>>();
	return {
		tools,
		api: {
			registerTool: (definition: ToolDefinition) => tools.set(definition.name, definition),
			on: (event: string, handler: (event: never, context: never) => unknown) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
		} as never,
		async emit(event: string, payload: unknown, context: unknown) {
			let result: unknown;
			for (const handler of handlers.get(event) ?? []) result = await handler(payload as never, context as never);
			return result;
		},
	};
}

function requiredTools() {
	return PLANNER_MCP_TOOL_NAMES.map(tool);
}

function tool(name: string) {
	return { name, description: `Description for ${name}`, inputSchema: { type: "object" as const } };
}

function createConnection(
	tools: ReturnType<typeof tool>[],
	callResult: { content: Array<{ type: string; text: string }>; isError?: boolean } = {
		content: [{ type: "text", text: "ok" }],
	},
) {
	return {
		listTools: vi.fn(async () => ({ tools })),
		callTool: vi.fn(async () => callResult),
		close: vi.fn(async () => undefined),
	} satisfies PlannerMcpConnection;
}
