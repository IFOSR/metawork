import { describe, expect, it } from "vitest";
import {
	buildExecutorRegisterCommand,
	parseExecutorDiscoverOutput,
} from "../src/anyfusion/executor-registration-wizard.ts";

describe("AnyFusion Executor registration wizard", () => {
	it("parses host discovery output", () => {
		expect(parseExecutorDiscoverOutput(["codex: /usr/bin/codex (codex-cli 1.2.3)", "pi: not found"])).toEqual([
			{ profileId: "codex", binaryPath: "/usr/bin/codex", version: "codex-cli 1.2.3" },
			{ profileId: "pi", binaryPath: null, version: null },
		]);
	});

	it("builds a quoted known-profile registration command", () => {
		expect(
			buildExecutorRegisterCommand({
				id: "repo-codex",
				profileId: "codex",
				binaryPath: "/usr/bin/codex",
				runtimeHome: "/home/user/.codex",
				description: "Repository implementation and review",
				capabilities: ["workspace-engineering"],
				primaryUseCases: ["implementation", "review"],
				environmentFiles: ["/home/user/.config/anyfusion/codex.env"],
			}),
		).toContain('/executor register "repo-codex" --profile "codex" --binary "/usr/bin/codex"');
	});

	it("requires and serializes the complete generic CLI session protocol", () => {
		const command = buildExecutorRegisterCommand({
			id: "custom-cli",
			profileId: "cli-session",
			binaryPath: "/opt/custom/bin/agent",
			runtimeHome: "/home/user/.custom-agent",
			description: "Custom session CLI",
			capabilities: ["workspace-engineering"],
			primaryUseCases: ["implementation"],
			environmentFiles: [],
			cliSession: {
				versionArgs: ["--version"],
				versionPattern: "^custom ",
				initialArgs: ["run", "--prompt", "{prompt}"],
				resumeArgs: ["resume", "{sessionId}", "--prompt", "{prompt}"],
				sessionIdPattern: "session=(?<sessionId>[a-z0-9-]+)",
				finalOutputPattern: "final=(?<output>.*)",
				timeoutMs: 120000,
				terminateSignal: "SIGTERM",
				permissionProfile: "restricted-custom",
			},
		});
		expect(command).toContain('--driver "cli-session"');
		expect(command).toContain("--initial-args-json");
		expect(command).toContain("--session-id-pattern");
	});
});
