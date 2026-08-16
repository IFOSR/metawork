import type { AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { MetaClawCommandAutocompleteProvider } from "../src/anyfusion/metaclaw-command-autocomplete.ts";
import type { AnyFusionPlannerHostClient, CommandCompletion } from "../src/anyfusion/planner-host-client.ts";

function baseProvider(suggestions: AutocompleteSuggestions | null = null): AutocompleteProvider {
	return {
		async getSuggestions() {
			return suggestions;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const next = [...lines];
			next[cursorLine] = `${next[cursorLine]!.slice(0, cursorCol - prefix.length)}${item.value}`;
			return { lines: next, cursorLine, cursorCol: cursorCol - prefix.length + item.value.length };
		},
	};
}

function clientWith(completion: CommandCompletion) {
	return {
		completeCommand: vi.fn(async () => completion),
	} as unknown as AnyFusionPlannerHostClient;
}

describe("MetaClaw command autocomplete adapter", () => {
	describe("exact incomplete command paths", () => {
		it("automatically expands /task to its child suggestions without requiring a typed space", async () => {
			const completeCommand = vi.fn(async (text: string): Promise<CommandCompletion> => {
				if (text === "/task ") {
					return {
						state: "incomplete",
						suggestions: [
							{
								value: "dashboard",
								label: "dashboard",
								description: "Show task dashboard",
								replacement: { start: 6, end: 6, text: "dashboard" },
							},
							{
								value: "list",
								label: "list",
								description: "List tasks",
								replacement: { start: 6, end: 6, text: "list" },
							},
						],
						hint: "/task <dashboard|list>",
						error: null,
					};
				}
				return {
					state: "incomplete",
					suggestions: [
						{
							value: "task",
							label: "/task",
							description: "Task commands",
							replacement: { start: 0, end: 5, text: "/task" },
						},
					],
					hint: null,
					error: null,
				};
			});
			const client = { completeCommand } as unknown as AnyFusionPlannerHostClient;
			const provider = new MetaClawCommandAutocompleteProvider(baseProvider(), () => client);
			const signal = new AbortController().signal;

			const suggestions = await provider.getSuggestions(["/task"], 0, 5, { signal });

			expect(completeCommand).toHaveBeenNthCalledWith(1, "/task", 5, signal);
			expect(completeCommand).toHaveBeenNthCalledWith(2, "/task ", 6, signal);
			expect(suggestions?.items.map((item) => item.label)).toEqual(["dashboard", "list"]);
			const applied = provider.applyCompletion(["/task"], 0, 5, suggestions!.items[0]!, "");
			expect(applied.lines).toEqual(["/task dashboard "]);
		});

		it("automatically expands an exact argument-taking path such as /task show", async () => {
			const completeCommand = vi.fn(
				async (text: string): Promise<CommandCompletion> => ({
					state: "incomplete",
					suggestions:
						text === "/task show "
							? [
									{
										value: "task_123",
										label: "task_123",
										description: "Current task",
										replacement: { start: 11, end: 11, text: "task_123" },
									},
								]
							: [],
					hint: "/task show <task-id>",
					error: null,
				}),
			);
			const client = { completeCommand } as unknown as AnyFusionPlannerHostClient;
			const provider = new MetaClawCommandAutocompleteProvider(baseProvider(), () => client);
			const signal = new AbortController().signal;

			const suggestions = await provider.getSuggestions(["/task show"], 0, 10, { signal });

			expect(completeCommand).toHaveBeenNthCalledWith(1, "/task show", 10, signal);
			expect(completeCommand).toHaveBeenNthCalledWith(2, "/task show ", 11, signal);
			expect(suggestions?.items.map((item) => item.label)).toEqual(["task_123"]);
			expect(provider.applyCompletion(["/task show"], 0, 10, suggestions!.items[0]!, "").lines).toEqual([
				"/task show task_123 ",
			]);
		});
	});

	it("uses host-owned nested and dynamic replacements without changing the Pi editor", async () => {
		const client = clientWith({
			state: "incomplete",
			suggestions: [
				{
					value: "task_123",
					label: "task_123",
					description: "Current task",
					replacement: { start: 11, end: 13, text: "task_123" },
				},
			],
			hint: "/task show <task-id>",
			error: null,
		});
		const provider = new MetaClawCommandAutocompleteProvider(baseProvider(), () => client);
		const controller = new AbortController();
		const suggestions = await provider.getSuggestions(["/task show ta"], 0, 13, { signal: controller.signal });
		expect(client.completeCommand).toHaveBeenCalledWith("/task show ta", 13, controller.signal);
		expect(suggestions).toEqual({
			prefix: "ta",
			items: [expect.objectContaining({ value: "task_123", label: "task_123" })],
		});
		const applied = provider.applyCompletion(["/task show ta --json"], 0, 13, suggestions!.items[0]!, "ta");
		expect(applied).toEqual({
			lines: ["/task show task_123 --json"],
			cursorLine: 0,
			cursorCol: 19,
		});
	});

	it("merges host and Planner-local roots and falls back when the host is unavailable", async () => {
		const base = baseProvider({ items: [{ value: "model", label: "model" }], prefix: "/ta" });
		const client = clientWith({
			state: "incomplete",
			suggestions: [
				{
					value: "task",
					label: "/task",
					description: "Task commands",
					replacement: { start: 0, end: 3, text: "/task" },
				},
			],
			hint: null,
			error: null,
		});
		const provider = new MetaClawCommandAutocompleteProvider(base, () => client);
		const suggestions = await provider.getSuggestions(["/ta"], 0, 3, { signal: new AbortController().signal });
		expect(suggestions?.items.map((item) => item.label)).toEqual(["/task", "model"]);
		const applied = provider.applyCompletion(["/ta"], 0, 3, suggestions!.items[0]!, "/ta");
		expect(provider.shouldContinueCompletion(suggestions!.items[0]!, applied)).toBe(true);
		expect(provider.shouldContinueCompletion(suggestions!.items[1]!, applied)).toBe(false);

		const fallback = new MetaClawCommandAutocompleteProvider(base, () => undefined);
		expect(await fallback.getSuggestions(["/ta"], 0, 3, { signal: new AbortController().signal })).toEqual({
			items: [{ value: "model", label: "model" }],
			prefix: "/ta",
		});
	});
});
