/**
 * One-line Markdown preview.
 *
 * Executor and Manager text is Markdown. Compact surfaces (DAG node step, table
 * cell, collapsed summary row) cannot host block Markdown, so they must never
 * print the syntax itself — they show a flattened sentence instead. Full
 * Markdown rendering belongs to expanded surfaces (`MarkdownContent`).
 */
export function markdownPreview(value: string, limit = 180): string {
  let text = value
    // fenced code: keep the body, drop the fence
    .replace(/```[^\n]*\n([\s\S]*?)```/gu, (_match, body: string) => body)
    // html tags the trace may carry through
    .replace(/<\/?[a-z][^>]*>/giu, '')
    .replace(/^#{1,6}\s+/gmu, '')
    .replace(/^\s*>\s?/gmu, '')
    .replace(/^\s*[-*+]\s+/gmu, '')
    .replace(/^\s*\d+[.)]\s+/gmu, '')
    .replace(/^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*$/gmu, '')
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/__([^_]+)__/gu, '$1')
    .replace(/(^|[^\w*])\*([^*\n]+)\*/gu, '$1$2')
    .replace(/(^|[^\w_])_([^_\n]+)_/gu, '$1$2')
    .replace(/~~([^~]+)~~/gu, '$1')
    .replace(/`([^`]*)`/gu, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/\|/gu, ' · ')
    .replace(/\s+/gu, ' ')
    .trim()
    // Table rows leave empty separators at both ends; keep one clean separator.
    .split(/\s*·\s*/u).filter(Boolean).join(' · ');
  if (text.length > limit) text = `${text.slice(0, limit - 1).trimEnd()}…`;
  return text;
}
