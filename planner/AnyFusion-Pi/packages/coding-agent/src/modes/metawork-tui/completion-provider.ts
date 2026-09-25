/**
 * MetaWork TUI 补全 provider（统一 TUI 设计 §8.4、§9.3）。
 *
 * 桥接 pi-tui AutocompleteProvider 与 Gateway 只读补全：
 * - 约 150 ms 去抖与单待应用请求由控制器负责；
 * - 只应用 Server 返回的替换区间，不在客户端自建 Task 名称解析或命令授权；
 * - 旧响应（版本/scope 不匹配）不得覆盖新草稿。
 */

import type {
	AutocompleteItem,
	AutocompleteProvider,
	AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import type { MetaWorkCompletionState } from "./model.ts";

export interface MetaWorkCompletionSource {
	requestCompletion(
		text: string,
		cursor: number,
		debounceMs?: number,
	): Promise<MetaWorkCompletionState | null>;
}

export interface CompletionReplacement {
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

export class GatewayCompletionProvider implements AutocompleteProvider {
	triggerCharacters = ["/"];
	private readonly replacements = new Map<string, CompletionReplacement>();
	private readonly source: MetaWorkCompletionSource;
	private readonly scopeKey: () => string;

	constructor(
		source: MetaWorkCompletionSource,
		scopeKey: () => string,
	) {
		this.source = source;
		this.scopeKey = scopeKey;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const text = lines.join("\n");
		const cursor = offsetAt(lines, cursorLine, cursorCol);
		const completion = await this.source.requestCompletion(text, cursor);
		if (options.signal.aborted) return null;
		if (!completion) return null;
		if (completion.state === "inactive" || completion.suggestions.length === 0) return null;
		// scope 校验：Workspace 补全的 targetConversationId 必须为 null，
		// Conversation 补全必须回显当前 scope，避免串 Conversation。
		const expectedConversationId = this.scopeKey() === "workspace" ? null : this.scopeKey();
		if (completion.targetConversationId !== expectedConversationId) return null;

		const items: AutocompleteItem[] = [];
		this.replacements.clear();
		for (const suggestion of completion.suggestions) {
			this.replacements.set(suggestion.value, suggestion.replacement);
			items.push({
				value: suggestion.value,
				label: suggestion.label,
				description: suggestion.description,
			});
		}
		return { items, prefix: tokenPrefixAt(text, cursor) };
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const text = lines.join("\n");
		const cursor = offsetAt(lines, cursorLine, cursorCol);
		// 只应用 Server 返回的替换区间；无对应区间时退化为替换当前 token。
		const replacement = this.replacements.get(item.value) ?? {
			start: Math.max(0, cursor - prefix.length),
			end: cursor,
			text: item.value,
		};
		const applied = applyRange(text, replacement);
		const nextCursor = Math.max(0, Math.min(replacement.start, text.length))
			+ replacement.text.length;
		return { lines: applied.split("\n"), ...positionAt(applied, nextCursor) };
	}
}

/** UTF-16 偏移：由 (line, col) 计算。 */
export function offsetAt(lines: readonly string[], cursorLine: number, cursorCol: number): number {
	let offset = 0;
	for (let index = 0; index < cursorLine && index < lines.length; index += 1) {
		offset += (lines[index] ?? "").length + 1;
	}
	return offset + cursorCol;
}

/** UTF-16 偏移：转换为 (line, col)。 */
export function positionAt(text: string, offset: number): { cursorLine: number; cursorCol: number } {
	const clamped = Math.max(0, Math.min(offset, text.length));
	const before = text.slice(0, clamped);
	const lines = before.split("\n");
	return {
		cursorLine: lines.length - 1,
		cursorCol: lines[lines.length - 1]?.length ?? 0,
	};
}

/** 光标所在 token 的前缀（补全匹配用），无 token 时为 ""。 */
export function tokenPrefixAt(text: string, cursor: number): string {
	const clamped = Math.max(0, Math.min(cursor, text.length));
	let start = clamped;
	while (start > 0) {
		const char = text[start - 1]!;
		if (char === " " || char === "\t" || char === "\n") break;
		start -= 1;
	}
	return text.slice(start, clamped);
}

function applyRange(text: string, replacement: CompletionReplacement): string {
	const start = Math.max(0, Math.min(replacement.start, text.length));
	const end = Math.max(start, Math.min(replacement.end, text.length));
	return `${text.slice(0, start)}${replacement.text}${text.slice(end)}`;
}
