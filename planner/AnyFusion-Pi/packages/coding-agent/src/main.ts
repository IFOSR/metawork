/**
 * Mode dispatch only. Runtime dependencies are loaded exclusively in the
 * non-Gateway branch; the terminal client has its own presentation module graph.
 */
import { validatePlannerInvocation } from "./anyfusion/planner-policy.ts";

export interface MainOptions {
	/** External factories are ignored by this Planner fork. */
	extensionFactories?: unknown[];
}

export async function main(args: string[], _options?: MainOptions): Promise<void> {
	const errors = validatePlannerInvocation(args);
	if (errors.length > 0) {
		for (const message of errors) console.error(`Error: ${message}`);
		process.exitCode = 1;
		return;
	}
	// Avoid the runtime CLI parser's extension/model type dependencies.
	const option = (name: string): string | undefined => {
		const index = args.indexOf(name);
		const value = index >= 0 ? args[index + 1] : undefined;
		return value && !value.startsWith("--") ? value : undefined;
	};
	const socketPath = option("--gateway-socket");
	if (args.includes("--gateway-socket")) {
		if (!socketPath) throw new Error("--gateway-socket requires a path");
		const { runMetaWorkTui } = await import("./modes/metawork-tui/index.ts");
		await runMetaWorkTui({
			socketPath,
			conversationId: option("--conversation-id")?.trim(),
			workspaceHint: option("--workspace-hint")?.trim(),
		});
		return;
	}
	const runtime = await import("./main-runtime.ts");
	await runtime.main(args);
}
