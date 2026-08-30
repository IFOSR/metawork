import { posix as posixPath } from "node:path";
import type { ToolDefinition } from "../core/extensions/types.ts";
import {
	createPlannerMcpExtensionFactory,
	type PlannerMcpConnection,
	type PlannerMcpExtensionOptions,
	type PlannerMcpLaunchConfig,
} from "./planner-mcp-extension.ts";
import { PLANNER_ACTIVE_TOOL_NAMES } from "./planner-policy.ts";
import { createPlannerProposalGate } from "./planner-proposal-gate.ts";
import { createPlanningProposalTool } from "./planner-proposal-tool.ts";
import { buildAnyFusionPlannerSystemPrompt } from "./planner-system-prompt.ts";
import { createPlannerWebTools } from "./planner-web-tools.ts";

export interface AnyFusionPlannerBootstrapOptions {
	cwd?: string;
	schemaPath?: string;
	skillPath?: string;
	connectionFactory?: (
		config: PlannerMcpLaunchConfig,
		onFailure: (error: Error) => void,
	) => Promise<PlannerMcpConnection>;
}

export function createAnyFusionPlannerBootstrap(options: AnyFusionPlannerBootstrapOptions = {}) {
	const cwd = options.cwd ?? process.cwd();
	const authorizedWorkspace = posixPath.resolve(process.env.ANYFUSION_PLANNER_WORKSPACE ?? "/workspace");
	const normalizedCwd = posixPath.resolve(cwd);
	const workspaceRelativePath = posixPath.relative(authorizedWorkspace, normalizedCwd);
	if (workspaceRelativePath.startsWith("..") || posixPath.isAbsolute(workspaceRelativePath)) {
		throw new Error(
			`AnyFusion Planner cwd must be inside the Runtime-authorized workspace ${authorizedWorkspace}; received ${cwd}`,
		);
	}
	const proposalGate = createPlannerProposalGate();
	const extensionOptions: PlannerMcpExtensionOptions = {
		proposalGate,
		connectionFactory: options.connectionFactory,
	};
	return {
		systemPrompt: buildAnyFusionPlannerSystemPrompt(options.skillPath),
		activeToolNames: [...PLANNER_ACTIVE_TOOL_NAMES],
		extensionFactories: [createPlannerMcpExtensionFactory(extensionOptions)],
		customTools: [
			...createPlannerWebTools(),
			createPlanningProposalTool(options.schemaPath, proposalGate),
		] as ToolDefinition[],
	};
}
