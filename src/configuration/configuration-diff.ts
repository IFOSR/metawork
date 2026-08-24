import { redactSensitiveText } from '../utils/redact-sensitive-text.js';

export interface ConfigurationDiffEntry {
  path: string;
  before: unknown;
  after: unknown;
}

export type ConfigurationChangeClass = 'none' | 'hot' | 'restart_required';

export interface ConfigurationDiffClassification {
  classification: ConfigurationChangeClass;
  restartRequired: boolean;
  entries: ConfigurationDiffEntry[];
  restartPaths: string[];
}

const SENSITIVE_KEY = /(?:api.?key|auth|credential|password|secret|token|private.?key)/iu;

export function diffConfigurations(
  before: unknown,
  after: unknown,
): ConfigurationDiffEntry[] {
  const entries: ConfigurationDiffEntry[] = [];
  collectDiff(entries, '', before, after);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export function classifyConfigurationDiff(
  before: unknown,
  after: unknown,
): ConfigurationDiffClassification {
  const entries = diffConfigurations(before, after);
  const restartPaths = entries
    .filter(entry => !isHotPath(entry.path))
    .map(entry => entry.path);
  const classification: ConfigurationChangeClass = entries.length === 0
    ? 'none'
    : restartPaths.length > 0
      ? 'restart_required'
      : 'hot';
  return {
    classification,
    restartRequired: restartPaths.length > 0,
    entries,
    restartPaths,
  };
}

function isHotPath(path: string): boolean {
  return path.startsWith('providers.')
    || path.startsWith('models.')
    || /^agentClasses\.[^.]+\.modelPolicy(?:\.|$)/u.test(path)
    || /^agentClasses\.[^.]+\.enabled$/u.test(path);
}

function collectDiff(
  entries: ConfigurationDiffEntry[],
  path: string,
  before: unknown,
  after: unknown,
): void {
  if (stableJson(before) === stableJson(after)) return;

  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      collectDiff(entries, path ? `${path}.${key}` : key, before[key], after[key]);
    }
    return;
  }

  entries.push({
    path,
    before: redactDiffValue(path, before),
    after: redactDiffValue(path, after),
  });
}

function redactDiffValue(path: string, value: unknown): unknown {
  if (SENSITIVE_KEY.test(path)) return value === undefined ? undefined : '[REDACTED]';
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(item => redactDiffValue(path, item));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        redactDiffValue(path ? `${path}.${key}` : key, nested),
      ]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(',')}}`;
}
