/**
 * MetaWork TUI 补全 provider 与客户端偏好测试（统一 TUI 设计 §8.4、§12）。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	GatewayCompletionProvider,
	offsetAt,
	positionAt,
	tokenPrefixAt,
} from "../src/modes/metawork-tui/completion-provider.ts";
import type { MetaWorkCompletionState } from "../src/modes/metawork-tui/model.ts";
import {
	createFilePreferencesStore,
	resolvePreferencesPath,
	sanitizePreferences,
} from "../src/modes/metawork-tui/preferences.ts";

function completion(overrides: Partial<MetaWorkCompletionState> = {}): MetaWorkCompletionState {
	return {
		requestId: "req_1",
		targetConversationId: "conv_1",
		state: "incomplete",
		suggestions: [{
			value: "/task list",
			label: "/task list",
			description: "列出任务",
			replacement: { start: 0, end: 5, text: "/task list" },
		}],
		hint: null,
		error: null,
		inputVersion: 1,
		...overrides,
	};
}

describe("metawork-tui completion provider", () => {
	it("computes offsets and positions for multi-line input", () => {
		const lines = ["/task", "show x"];
		expect(offsetAt(lines, 0, 5)).toBe(5);
		expect(offsetAt(lines, 1, 4)).toBe(10);
		expect(positionAt("ab\ncde", 5)).toEqual({ cursorLine: 1, cursorCol: 2 });
		expect(positionAt("ab\ncde", 6)).toEqual({ cursorLine: 1, cursorCol: 3 });
		expect(positionAt("abc", 99)).toEqual({ cursorLine: 0, cursorCol: 3 });
		expect(tokenPrefixAt("/task li", 5)).toBe("/task");
		expect(tokenPrefixAt("/task li", 8)).toBe("li");
	});

	it("returns suggestions and applies the server replacement range", async () => {
		const provider = new GatewayCompletionProvider(
			{ requestCompletion: async () => completion() },
			() => "conv_1",
		);
		const suggestions = await provider.getSuggestions(["/tas"], 0, 4, {
			signal: new AbortController().signal,
		});
		expect(suggestions?.items).toHaveLength(1);
		expect(suggestions?.prefix).toBe("/tas");

		const applied = provider.applyCompletion(["/tas"], 0, 4, suggestions!.items[0]!, suggestions!.prefix);
		expect(applied.lines).toEqual(["/task list"]);
		expect(applied.cursorLine).toBe(0);
		expect(applied.cursorCol).toBe("/task list".length);
	});

	it("drops completions whose scope does not match the editor scope", async () => {
		const provider = new GatewayCompletionProvider(
			// Workspace 补全的 targetConversationId 必须是 null。
			{ requestCompletion: async () => completion({ targetConversationId: "conv_1" }) },
			() => "workspace",
		);
		await expect(provider.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal }))
			.resolves.toBeNull();

		const conversationProvider = new GatewayCompletionProvider(
			{ requestCompletion: async () => completion({ targetConversationId: null }) },
			() => "conv_1",
		);
		await expect(conversationProvider.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal }))
			.resolves.toBeNull();
	});

	it("returns null for inactive completions and aborted requests", async () => {
		const inactive = new GatewayCompletionProvider(
			{ requestCompletion: async () => completion({ state: "inactive", suggestions: [] }) },
			() => "conv_1",
		);
		await expect(inactive.getSuggestions(["hello"], 0, 5, { signal: new AbortController().signal }))
			.resolves.toBeNull();

		const controller = new AbortController();
		controller.abort();
		const aborted = new GatewayCompletionProvider(
			{ requestCompletion: async () => completion() },
			() => "conv_1",
		);
		await expect(aborted.getSuggestions(["/tas"], 0, 4, { signal: controller.signal }))
			.resolves.toBeNull();
	});

	it("falls back to replacing the current token when no server range is present", async () => {
		const provider = new GatewayCompletionProvider(
			{ requestCompletion: async () => completion() },
			() => "conv_1",
		);
		const applied = provider.applyCompletion(["/ta"], 0, 3, {
			value: "/task",
			label: "/task",
		}, "/ta");
		expect(applied.lines).toEqual(["/task"]);
		expect(applied.cursorCol).toBe(5);
	});
});

describe("metawork-tui preferences", () => {
	it("whitelists only UI preference keys", () => {
		expect(sanitizePreferences({
			theme: "light",
			draft: "secret draft",
			conversationHistory: [{ id: "turn_1" }],
			__proto__: { polluted: true },
		})).toEqual({ theme: "light" });
		expect(sanitizePreferences(null)).toEqual({});
		expect(sanitizePreferences({ theme: 42 })).toEqual({});
		expect(sanitizePreferences({ theme: "  " })).toEqual({});
	});

	it("resolves the preference path from the MetaWork config home only", () => {
		expect(resolvePreferencesPath({ METAWORK_TUI_PREFERENCES: "/tmp/prefs.json" }))
			.toBe("/tmp/prefs.json");
		expect(resolvePreferencesPath({ METAWORK_CONFIG_HOME: "/tmp/mw" }))
			.toBe(join("/tmp/mw", "tui-preferences.json"));
		// 不读取 ~/.pi 或 Planner home。
		expect(resolvePreferencesPath({})).not.toContain(".pi");
	});

	it("round-trips preferences and tolerates invalid files", () => {
		const dir = mkdtempSync(join(tmpdir(), "metawork-tui-prefs-"));
		try {
			const path = join(dir, "tui-preferences.json");
			const store = createFilePreferencesStore(path);
			expect(store.load()).toEqual({});
			store.save({ theme: "dark" });
			expect(store.load()).toEqual({ theme: "dark" });

			writeFileSync(path, "{not json", "utf8");
			expect(store.load()).toEqual({});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
