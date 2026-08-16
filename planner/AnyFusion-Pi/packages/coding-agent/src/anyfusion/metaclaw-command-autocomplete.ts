import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import type {
	AnyFusionPlannerHostClient,
	CommandCompletion,
	CommandCompletionSuggestion,
} from "./planner-host-client.ts";

interface MetaClawAutocompleteItem extends AutocompleteItem {
	metaClawReplacement: {
		start: number;
		end: number;
		text: string;
	};
	metaClawContinueCompletion: boolean;
}

function isMetaClawItem(item: AutocompleteItem): item is MetaClawAutocompleteItem {
	return "metaClawReplacement" in item;
}

function mergeRootSuggestions(
	base: AutocompleteSuggestions | null,
	hostItems: MetaClawAutocompleteItem[],
	prefix: string,
): AutocompleteSuggestions | null {
	const items: AutocompleteItem[] = [];
	const seen = new Set<string>();
	for (const item of [...hostItems, ...(base?.items ?? [])]) {
		const key = item.label.replace(/^\//, "");
		if (seen.has(key)) continue;
		seen.add(key);
		items.push(item);
	}
	return items.length > 0 ? { items, prefix } : null;
}

function suggestionLeavesTextUnchanged(text: string, suggestion: CommandCompletionSuggestion): boolean {
	const replacement = suggestion.replacement;
	return `${text.slice(0, replacement.start)}${replacement.text}${text.slice(replacement.end)}` === text;
}

function shouldExpandExactIncompletePath(text: string, cursor: number, completion: CommandCompletion): boolean {
	if (completion.state !== "incomplete" || cursor !== text.length || /\s$/u.test(text)) return false;
	return (
		completion.suggestions.length === 0 ||
		completion.suggestions.some((suggestion) => suggestionLeavesTextUnchanged(text, suggestion))
	);
}

function collapseVirtualTrailingSpace(
	suggestion: CommandCompletionSuggestion,
	originalLength: number,
): CommandCompletionSuggestion {
	const replacement = suggestion.replacement;
	if (replacement.start < originalLength + 1) return suggestion;
	return {
		...suggestion,
		replacement: {
			start: replacement.start - 1,
			end: replacement.end - 1,
			text: ` ${replacement.text}`,
		},
	};
}

function toAutocompleteItem(
	suggestion: CommandCompletionSuggestion,
	lineOffset: number,
	continueCompletion: boolean,
): MetaClawAutocompleteItem {
	return {
		value: suggestion.replacement.text,
		label: suggestion.label,
		description: suggestion.description || undefined,
		metaClawReplacement: {
			start: lineOffset + suggestion.replacement.start,
			end: lineOffset + suggestion.replacement.end,
			text: suggestion.replacement.text,
		},
		metaClawContinueCompletion: continueCompletion,
	};
}

export class MetaClawCommandAutocompleteProvider implements AutocompleteProvider {
	readonly triggerCharacters?: string[];
	private readonly base: AutocompleteProvider;
	private readonly getClient: () => AnyFusionPlannerHostClient | undefined;
	private readonly onCompletion?: (completion: CommandCompletion | null) => void;

	constructor(
		base: AutocompleteProvider,
		getClient: () => AnyFusionPlannerHostClient | undefined,
		onCompletion?: (completion: CommandCompletion | null) => void,
	) {
		this.base = base;
		this.getClient = getClient;
		this.onCompletion = onCompletion;
		this.triggerCharacters = base.triggerCharacters;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const basePromise = this.base.getSuggestions(lines, cursorLine, cursorCol, options);
		const currentLine = lines[cursorLine] ?? "";
		const trimmedLine = currentLine.trimStart();
		const lineOffset = currentLine.length - trimmedLine.length;
		if (cursorLine !== 0 || cursorCol < lineOffset || !trimmedLine.startsWith("/")) {
			this.onCompletion?.(null);
			return basePromise;
		}

		const client = this.getClient();
		if (!client) {
			this.onCompletion?.(null);
			return basePromise;
		}

		const commandCursor = cursorCol - lineOffset;
		try {
			const [baseSuggestions, initialCompletion] = await Promise.all([
				basePromise,
				client.completeCommand(trimmedLine, commandCursor, options.signal),
			]);
			if (options.signal.aborted) return null;

			const expandExactPath = shouldExpandExactIncompletePath(trimmedLine, commandCursor, initialCompletion);
			const completion = expandExactPath
				? await client.completeCommand(`${trimmedLine} `, commandCursor + 1, options.signal)
				: initialCompletion;
			if (options.signal.aborted) return null;
			this.onCompletion?.(completion);

			const suggestions = expandExactPath
				? completion.suggestions.map((suggestion) => collapseVirtualTrailingSpace(suggestion, trimmedLine.length))
				: completion.suggestions;
			const hostItems = suggestions.map((suggestion) =>
				toAutocompleteItem(suggestion, lineOffset, completion.state === "incomplete"),
			);
			if (hostItems.length === 0) return expandExactPath ? null : baseSuggestions;

			const firstReplacement = suggestions[0]!.replacement;
			const prefix = trimmedLine.slice(firstReplacement.start, commandCursor);
			const isRootCompletion = !expandExactPath && !trimmedLine.slice(0, commandCursor).includes(" ");
			return isRootCompletion
				? mergeRootSuggestions(baseSuggestions, hostItems, prefix)
				: { items: hostItems, prefix };
		} catch (error) {
			if (options.signal.aborted || (error instanceof Error && error.name === "AbortError")) return null;
			this.onCompletion?.(null);
			return basePromise;
		}
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		if (!isMetaClawItem(item)) return this.base.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		const currentLine = lines[cursorLine] ?? "";
		const replacement = item.metaClawReplacement;
		const before = currentLine.slice(0, replacement.start);
		const after = currentLine.slice(replacement.end);
		const inserted = `${replacement.text}${after.length === 0 ? " " : ""}`;
		const nextLines = [...lines];
		nextLines[cursorLine] = `${before}${inserted}${after}`;
		return {
			lines: nextLines,
			cursorLine,
			cursorCol: before.length + inserted.length,
		};
	}

	shouldContinueCompletion(
		item: AutocompleteItem,
		result: { lines: string[]; cursorLine: number; cursorCol: number },
	): boolean {
		if (isMetaClawItem(item)) return item.metaClawContinueCompletion;
		return this.base.shouldContinueCompletion?.(item, result) ?? false;
	}

	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		return this.base.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
	}
}
