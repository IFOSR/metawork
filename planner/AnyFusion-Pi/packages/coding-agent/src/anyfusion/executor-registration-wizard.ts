export type ExecutorRegistrationProfileId = "codex" | "pi" | "hermes" | "cli-session";

export interface ExecutorDiscovery {
	profileId: string;
	binaryPath: string | null;
	version: string | null;
}

export interface ExecutorRegistrationDraft {
	id: string;
	profileId: ExecutorRegistrationProfileId;
	binaryPath: string;
	runtimeHome: string;
	description: string;
	capabilities: string[];
	primaryUseCases: string[];
	environmentFiles: string[];
	cliSession?: {
		versionArgs: string[];
		versionPattern: string;
		initialArgs: string[];
		resumeArgs: string[];
		sessionIdPattern: string;
		finalOutputPattern: string | null;
		timeoutMs: number;
		terminateSignal: "SIGTERM" | "SIGINT";
		permissionProfile: "workspace-engineering" | "public-web-research" | "restricted-custom";
	};
}

export function parseExecutorDiscoverOutput(lines: string[]): ExecutorDiscovery[] {
	const discoveries: ExecutorDiscovery[] = [];
	for (const line of lines) {
		const missing = /^([a-z][a-z0-9-]*):\s+not found$/u.exec(line.trim());
		if (missing) {
			discoveries.push({ profileId: missing[1]!, binaryPath: null, version: null });
			continue;
		}
		const match = /^([a-z][a-z0-9-]*):\s+(\S+)(?:\s+\((.*)\))?$/u.exec(line.trim());
		if (!match) continue;
		discoveries.push({
			profileId: match[1]!,
			binaryPath: match[2]!,
			version: match[3] ?? null,
		});
	}
	return discoveries;
}

export function buildExecutorRegisterCommand(draft: ExecutorRegistrationDraft): string {
	const args = [
		"/executor",
		"register",
		quote(draft.id),
		draft.profileId === "cli-session" ? "--driver" : "--profile",
		quote(draft.profileId),
		"--binary",
		quote(draft.binaryPath),
		"--home",
		quote(draft.runtimeHome),
		"--description",
		quote(draft.description),
		"--capabilities",
		quote(draft.capabilities.join(",")),
		"--use-cases",
		quote(draft.primaryUseCases.join(",")),
	];
	if (draft.environmentFiles.length > 0) {
		args.push("--env-files", quote(draft.environmentFiles.join(",")));
	}
	if (draft.profileId === "cli-session") {
		const protocol = draft.cliSession;
		if (!protocol) throw new Error("Generic CLI registration requires the complete cli-session protocol");
		args.push(
			"--version-args-json",
			quote(JSON.stringify(protocol.versionArgs)),
			"--version-pattern",
			quote(protocol.versionPattern),
			"--initial-args-json",
			quote(JSON.stringify(protocol.initialArgs)),
			"--resume-args-json",
			quote(JSON.stringify(protocol.resumeArgs)),
			"--session-id-pattern",
			quote(protocol.sessionIdPattern),
			"--final-output-pattern",
			quote(protocol.finalOutputPattern ?? ""),
			"--timeout-ms",
			String(protocol.timeoutMs),
			"--terminate-signal",
			protocol.terminateSignal,
			"--permission-profile",
			protocol.permissionProfile,
		);
	}
	return args.join(" ");
}

function quote(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
