import type { GatewayCommandSuggestion } from '../../src/gateway/task-view';

/** Apply the server's UTF-16 token range, preserving text on both sides. */
export function applyCommandSuggestion(text: string, suggestion: GatewayCommandSuggestion): { text: string; cursor: number } | null {
  const { start, end, text: token } = suggestion.replacement;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length) return null;
  const suffix = text.slice(end);
  const inserted = token + (suffix.length === 0 || !/^\s/u.test(suffix) ? ' ' : '');
  return { text: text.slice(0, start) + inserted + suffix, cursor: start + inserted.length };
}
