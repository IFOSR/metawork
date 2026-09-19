import { createHash } from 'node:crypto';
import type { ExecutorManualAssertion } from './types.js';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';

export function validateExecutorManualSourceText(sourceText: string): void {
  if (sourceText.length > 8_000 || Buffer.byteLength(sourceText, 'utf8') > 8_000) {
    throw new Error('Executor manual sourceText exceeds 8000 UTF-8 bytes');
  }
  if (redactSensitiveText(sourceText) !== sourceText) {
    throw new Error('Executor manual guidance must not contain credential-like content');
  }
}

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
