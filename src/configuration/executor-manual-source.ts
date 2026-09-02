import { createHash } from 'node:crypto';
import type { ExecutorManualAssertion } from './types.js';

export function fingerprintExecutorManualSourceText(sourceText: string): string {
  return `sha256:${createHash('sha256').update(sourceText.trim()).digest('hex')}`;
}

export function fingerprintExecutorManualSemantics(input: {
  sourceText: string;
  assertions: readonly ExecutorManualAssertion[];
}): string {
  return `sha256:${createHash('sha256').update(stableJson({
    sourceText: input.sourceText.trim(),
    assertions: input.assertions,
  })).digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(',')}}`;
}
