import { isAbsolute } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type TSchema, Type } from "typebox";
import { defineTool, type ExtensionContext, type ExtensionFactory } from "../core/extensions/types.ts";
import { PLANNER_MCP_TOOL_NAMES, PLANNER_PROPOSAL_TOOL_NAME } from "./planner-policy.ts";
import type { PlannerProposalGate } from "./planner-proposal-gate.ts";

interface McpToolDescription {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown> & { type: "object" };
}

interface McpCallResult {
	content?: unknown[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
	[key: string]: unknown;
}

export interface PlannerMcpConnection {
	listTools(cursor?: string): Promise<{ tools: McpToolDescription[]; nextCursor?: string }>;
	callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
	close(): Promise<void>;
}

export interface PlannerMcpExtensionOptions {
	proposalGate: PlannerProposalGate;
	connectionFactory?: (
		config: PlannerMcpLaunchConfig,
		onFailure: (error: Error) => void,
	) => Promise<PlannerMcpConnection>;
}

export interface PlannerMcpLaunchConfig {
	command: string;
	args: string[];
	cwd: string;
}

export function createPlannerMcpExtensionFactory(options: PlannerMcpExtensionOptions): ExtensionFactory {
	return async (pi) => {
		const connectionFactory = options.connectionFactory ?? createSdkConnection;
		let connection: PlannerMcpConnection | undefined;
		let closing = false;
		let activeContext: ExtensionContext | undefined;
		let toolDescriptions = new Map<string, McpToolDescription>();

		const markUnavailable = (error: Error): string => {
			const message = plannerMcpUnavailableMessage(error.message);
			options.proposalGate.unavailableReason = message;
			if (activeContext && !activeContext.isIdle()) {
				activeContext.ui.notify(message, "error");
				activeContext.abort();
			}
			return message;
		};

		const connectAndDiscover = async (): Promise<void> => {
			closing = true;
			await connection?.close().catch(() => undefined);
			closing = false;
			const config = readPlannerMcpLaunchConfig();
			const nextConnection = await connectionFactory(config, (error) => {
				if (!closing) markUnavailable(error);
			});
			try {
				const discovered = await discoverTools(nextConnection);
				const missing = PLANNER_MCP_TOOL_NAMES.filter((name) => !discovered.has(name));
				if (missing.length > 0) {
					throw new Error(`MetaClaw Planner MCP is missing required tools: ${missing.join(", ")}`);
				}
				connection = nextConnection;
				toolDescriptions = discovered;
				options.proposalGate.unavailableReason = undefined;
			} catch (error) {
				closing = true;
				await nextConnection.close().catch(() => undefined);
				closing = false;
				throw error;
			}
		};

		await connectAndDiscover();

		for (const name of PLANNER_MCP_TOOL_NAMES) {
			const description = toolDescriptions.get(name)!;
			pi.registerTool(
				defineTool({
					name,
					label: description.description ?? name,
					description: description.description ?? `Query MetaClaw through ${name}`,
					promptSnippet: description.description ?? `Query authoritative MetaClaw facts through ${name}`,
					parameters: Type.Unsafe<Record<string, unknown>>(description.inputSchema as TSchema),
					async execute(_toolCallId, params, signal, _onUpdate, ctx) {
						if (!connection || options.proposalGate.unavailableReason) {
							const message =
								options.proposalGate.unavailableReason ?? plannerMcpUnavailableMessage("not connected");
							ctx.ui.notify(message, "error");
							ctx.abort();
							return mcpErrorResult(message);
						}
						try {
							const result = await connection.callTool(name, params, signal);
							return {
								content: normalizeMcpContent(result),
								details: result,
							};
						} catch (error) {
							if (signal?.aborted && !options.proposalGate.unavailableReason) throw abortError();
							const message = markUnavailable(toError(error));
							return mcpErrorResult(message);
						}
					},
				}),
			);
		}

		pi.on("before_agent_start", async (_event, ctx) => {
			activeContext = ctx;
			if (!options.proposalGate.unavailableReason) return;
			try {
				await connectAndDiscover();
			} catch (error) {
				const message = markUnavailable(toError(error));
				ctx.ui.notify(message, "error");
				ctx.abort();
			}
		});

		pi.on("agent_end", () => {
			activeContext = undefined;
		});

		pi.on("tool_call", (event) => {
			if (event.toolName !== PLANNER_PROPOSAL_TOOL_NAME || !options.proposalGate.unavailableReason) return;
			return { block: true, reason: options.proposalGate.unavailableReason };
		});

		pi.on("session_shutdown", async () => {
			activeContext = undefined;
			closing = true;
			await connection?.close().catch(() => undefined);
			connection = undefined;
			closing = false;
		});
	};
}

export function readPlannerMcpLaunchConfig(env: NodeJS.ProcessEnv = process.env): PlannerMcpLaunchConfig {
	const command = env.ANYFUSION_PLANNER_MCP_COMMAND?.trim();
	if (!command || !isAbsolute(command)) {
		throw new Error("ANYFUSION_PLANNER_MCP_COMMAND must be the absolute shared image Node executable path");
	}
	const argsJson = env.ANYFUSION_PLANNER_MCP_ARGS_JSON;
	if (!argsJson) throw new Error("ANYFUSION_PLANNER_MCP_ARGS_JSON is required");
	let parsed: unknown;
	try {
		parsed = JSON.parse(argsJson);
	} catch (error) {
		throw new Error(`ANYFUSION_PLANNER_MCP_ARGS_JSON must be valid JSON: ${toError(error).message}`);
	}
	if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
		throw new Error("ANYFUSION_PLANNER_MCP_ARGS_JSON must contain only string arguments");
	}
	const workspace = env.ANYFUSION_PLANNER_WORKSPACE?.trim();
	return { command, args: parsed, cwd: workspace && isAbsolute(workspace) ? workspace : process.cwd() };
}

async function createSdkConnection(
	config: PlannerMcpLaunchConfig,
	onFailure: (error: Error) => void,
): Promise<PlannerMcpConnection> {
	const transport = new StdioClientTransport({
		command: config.command,
		args: config.args,
		cwd: config.cwd,
		env: stringEnvironment(process.env),
		stderr: "pipe",
	});
	const client = new Client({ name: "anyfusion-pi-planner", version: "1.0.0" });
	client.onclose = () => onFailure(new Error("MetaClaw Planner MCP transport closed"));
	client.onerror = onFailure;
	await client.connect(transport);
	return {
		async listTools(cursor) {
			const result = await client.listTools(cursor ? { cursor } : undefined);
			return { tools: result.tools as McpToolDescription[], nextCursor: result.nextCursor };
		},
		async callTool(name, args, signal) {
			return (await client.callTool({ name, arguments: args }, undefined, { signal })) as McpCallResult;
		},
		async close() {
			await client.close();
		},
	};
}

async function discoverTools(connection: PlannerMcpConnection): Promise<Map<string, McpToolDescription>> {
	const discovered = new Map<string, McpToolDescription>();
	let cursor: string | undefined;
	do {
		const page = await connection.listTools(cursor);
		for (const tool of page.tools) {
			if ((PLANNER_MCP_TOOL_NAMES as readonly string[]).includes(tool.name)) discovered.set(tool.name, tool);
		}
		cursor = page.nextCursor;
	} while (cursor);
	return discovered;
}

function normalizeMcpContent(result: McpCallResult): Array<{ type: "text"; text: string }> {
	const text = (result.content ?? [])
		.flatMap((item) =>
			item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item
				? [String(item.text)]
				: [],
		)
		.join("\n");
	if (text) return [{ type: "text", text }];
	return [{ type: "text", text: JSON.stringify(result.structuredContent ?? result) }];
}

function mcpErrorResult(message: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: { status: "planner_context_unavailable", message },
	};
}

function plannerMcpUnavailableMessage(reason: string): string {
	return JSON.stringify({
		status: "planner_context_unavailable",
		source: "metaclaw_planner_mcp",
		retryableNextTurn: true,
		message: reason,
	});
}

function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
	return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function abortError(): Error {
	const error = new Error("Planner MCP request aborted");
	error.name = "AbortError";
	return error;
}
