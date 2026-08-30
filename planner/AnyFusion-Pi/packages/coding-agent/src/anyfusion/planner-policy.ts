/**
 * AnyFusion Planner runtime policy.
 *
 * This fork is a private MetaClaw component, not a general-purpose coding
 * agent. The policy is deliberately kept at the application boundary so the
 * upstream agent/session implementation remains easy to rebase.
 */

export const ANYFUSION_PLANNER_NAME = "AnyFusion Planner";
export const ANYFUSION_PLANNER_PROTOCOL_VERSION = 1;

/** Built-in tools that are safe for Planner read/query behavior. */
export const PLANNER_ALLOWED_BUILTIN_TOOLS = ["read", "grep", "find", "ls"] as const;
export const PLANNER_WEB_TOOL_NAMES = ["web_fetch", "web_search"] as const;
export const PLANNER_PROPOSAL_TOOL_NAME = "submit_planning_proposal";
export const PLANNER_MCP_TOOL_NAMES = [
	"search_tasks",
	"get_task_context",
	"get_current_session_context",
	"get_planning_context",
	"get_runtime_state",
	"list_executor_status",
	"get_executor_diagnostics",
] as const;
export const PLANNER_ACTIVE_TOOL_NAMES = [
	...PLANNER_ALLOWED_BUILTIN_TOOLS,
	...PLANNER_WEB_TOOL_NAMES,
	PLANNER_PROPOSAL_TOOL_NAME,
	...PLANNER_MCP_TOOL_NAMES,
] as const;

const DENIED_COMMANDS = new Set(["config", "install", "uninstall", "remove", "update", "list"]);
const DENIED_FLAGS = new Set([
	"--api-key",
	"--model",
	"--models",
	"--provider",
	"--extension",
	"--skill",
	"--prompt-template",
	"--theme",
	"--tools",
	"--exclude-tools",
	"--no-tools",
	"--no-builtin-tools",
	"--system-prompt",
	"--append-system-prompt",
	"--approve",
	"--no-approve",
]);

export function buildPlannerProviderTimeoutOverrides(outerTimeoutValue: string | undefined): {
	httpIdleTimeoutMs: number;
	websocketConnectTimeoutMs: number;
	retry: {
		enabled: false;
		maxRetries: 0;
		provider: {
			timeoutMs: number;
			maxRetries: 0;
			maxRetryDelayMs: number;
		};
	};
} | undefined {
	const parsedTimeout = Number(outerTimeoutValue);
	if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) return undefined;

	const outerTimeoutMs = Math.floor(parsedTimeout);
	const reserveMs = Math.min(30_000, Math.max(250, Math.floor(outerTimeoutMs / 6)));
	const providerTimeoutMs = Math.max(1, Math.min(150_000, outerTimeoutMs - reserveMs));
	return {
		httpIdleTimeoutMs: providerTimeoutMs,
		websocketConnectTimeoutMs: Math.min(30_000, providerTimeoutMs),
		retry: {
			enabled: false,
			maxRetries: 0,
			provider: {
				timeoutMs: providerTimeoutMs,
				maxRetries: 0,
				maxRetryDelayMs: 1_000,
			},
		},
	};
}

/**
 * Validate the public CLI boundary before Pi handles package/config commands.
 * AnyFusion owns provider credentials, model selection, and package lifecycle.
 */
export function validatePlannerInvocation(args: readonly string[]): string[] {
	const errors: string[] = [];
	const command = args[0];
	if (command && DENIED_COMMANDS.has(command)) {
		errors.push(`The ${ANYFUSION_PLANNER_NAME} runtime does not expose the "${command}" command.`);
	}

	for (const arg of args) {
		const flag = arg.split("=", 1)[0];
		if (DENIED_FLAGS.has(flag)) {
			errors.push(`${flag} is managed by AnyFusion and cannot be supplied by the Planner client.`);
		}
	}

	return errors;
}

/** Apply the non-negotiable Planner resource policy to parsed CLI options. */
export function applyPlannerResourcePolicy(parsed: {
	noTools?: boolean;
	noBuiltinTools?: boolean;
	tools?: string[];
	excludeTools?: string[];
	noExtensions?: boolean;
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
}, options: {
	semanticRpc?: boolean;
} = {}): void {
	const activeTools = options.semanticRpc
		? [...PLANNER_WEB_TOOL_NAMES, PLANNER_PROPOSAL_TOOL_NAME, ...PLANNER_MCP_TOOL_NAMES]
		: PLANNER_ACTIVE_TOOL_NAMES;
	parsed.noTools = false;
	parsed.noBuiltinTools = options.semanticRpc === true;
	parsed.tools = [...activeTools];
	parsed.excludeTools = ["bash", "edit", "write"];
	parsed.noExtensions = true;
	parsed.noSkills = true;
	parsed.noPromptTemplates = true;
	parsed.noThemes = true;
}

const ALLOWED_SLASH_COMMANDS = new Set([
	"settings",
	"copy",
	"name",
	"session",
	"hotkeys",
	"fork",
	"clone",
	"tree",
	"new",
	"compact",
	"resume",
	"quit",
]);

/** MetaClaw-owned deterministic command roots exposed by the Planner shell. */
export const METACLAW_SLASH_COMMANDS = [
	{ name: "permission", description: "Runtime permission decisions" },
	{ name: "task", description: "Task inspection and control" },
	{ name: "executor", description: "Executor registration, inspection, and feedback" },
	{ name: "memory", description: "Memory and review policy" },
	{ name: "profile", description: "User, project, and Executor profiles" },
	{ name: "learning", description: "Learning candidates and Skill governance" },
	{ name: "config", description: "Show the active MetaClaw configuration" },
	{ name: "help", description: "Show the MetaClaw command tree" },
	{ name: "exit", description: "Exit the MetaClaw session" },
] as const;

const METACLAW_SLASH_COMMAND_NAMES = new Set<string>(METACLAW_SLASH_COMMANDS.map((command) => command.name));

export function isMetaClawSlashCommand(name: string): boolean {
	return METACLAW_SLASH_COMMAND_NAMES.has(name);
}

/** Return whether an interactive slash command is safe for Planner sessions. */
export function isPlannerSlashCommandAllowed(name: string): boolean {
	return ALLOWED_SLASH_COMMANDS.has(name);
}

const DENIED_RPC_COMMANDS = new Set([
	"bash",
	"abort_bash",
	"set_model",
	"cycle_model",
	"get_available_models",
	"export_html",
]);

/** Validate RPC commands because some RPC controls bypass the LLM tool allowlist. */
export function plannerRpcCommandError(command: unknown): string | undefined {
	if (!command || typeof command !== "object" || Array.isArray(command)) return "Invalid Planner RPC command.";
	const type = (command as { type?: unknown }).type;
	if (typeof type !== "string") return "Planner RPC command requires a type.";
	if (DENIED_RPC_COMMANDS.has(type)) {
		return `Planner RPC command "${type}" is disabled by the AnyFusion read-only policy.`;
	}
	if (type === "prompt" || type === "steer" || type === "follow_up") {
		const message = (command as { message?: unknown }).message;
		if (
			typeof message === "string" &&
			(/^\s*!/.test(message) ||
				/^\s*\/(?:login|logout|model|scoped-models|bash|share|export|import|reload|trust)\b/.test(message))
		) {
			return "This Planner session accepts conversation and read-only queries, not shell, account, model, export, or extension commands.";
		}
	}
	return undefined;
}
