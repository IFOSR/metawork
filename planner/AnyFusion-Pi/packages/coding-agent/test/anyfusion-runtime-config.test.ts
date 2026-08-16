import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR, getAgentDir } from "../src/config.ts";

describe("AnyFusion Planner runtime configuration", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("uses the AnyFusion-owned config namespace", () => {
		expect(CONFIG_DIR_NAME).toBe(".anyfusion");
		expect(ENV_AGENT_DIR).toBe("ANYFUSION_PLANNER_HOME");
		expect(getAgentDir()).toBe(join(homedir(), ".anyfusion", "agent"));
	});

	it("honors the fixed Planner home override", () => {
		vi.stubEnv(ENV_AGENT_DIR, "/tmp/anyfusion-planner-home");
		expect(getAgentDir()).toBe("/tmp/anyfusion-planner-home");
	});
});
