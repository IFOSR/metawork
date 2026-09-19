import { redactSensitiveText } from '../utils/redact-sensitive-text.js';
import { AnyFusionConfigurationV2Schema } from './schema.js';
import { buildExecutorConfigurationCandidate } from './executor-configuration.js';
import type { AnyFusionConfigurationV2, AgentClassDefinition } from './types.js';

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
  const lifecycleRefs = boundedExecutorChanges(before, after);
  const restartPaths = entries
    .filter(entry => !isHotPath(entry.path)
      && ![...lifecycleRefs].some(ref => (
        entry.path === `agentClasses.${ref}` || entry.path.startsWith(`agentClasses.${ref}.`)
      )))
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

function boundedExecutorChanges(before: unknown, after: unknown): Set<string> {
  const result = new Set<string>();
  const parse = (value: unknown) => {
    try { return AnyFusionConfigurationV2Schema.safeParse(value); } catch { return null; }
  };
  const oldParsed = parse(before);
  const nextParsed = parse(after);
  if (!oldParsed?.success || !nextParsed?.success) return result;
  const old = oldParsed.data as AnyFusionConfigurationV2;
  const next = nextParsed.data as AnyFusionConfigurationV2;
  for (const ref of new Set([...Object.keys(old.agentClasses), ...Object.keys(next.agentClasses)])) {
    const previous = old.agentClasses[ref];
    const candidate = next.agentClasses[ref];
    const definition = candidate ?? previous;
    if (definition?.kind !== 'executor' || (previous && previous.kind !== 'executor')) continue;
    const harness = old.harnesses[definition.harnessRef];
    if (!harness || harness.kind !== 'executor'
      || !['pi-cli', 'codex-cli'].includes(harness.driverId)
      || stableJson(harness) !== stableJson(next.harnesses[definition.harnessRef])) continue;
    if (!candidate) {
      result.add(ref);
      continue;
    }
    try {
      const fields = {
        displayName: candidate.displayName ?? ref,
        modelPolicy: candidate.modelPolicy,
        permissionProfileRef: candidate.permissionProfileRef!,
        manualSourceText: candidate.executorManual?.sourceText ?? '',
        enabled: candidate.enabled,
      };
      const expected = buildExecutorConfigurationCandidate(
        { revisionId: 'classification', contentHash: '', config: old },
        previous
          ? { operation: 'update', agentClassRef: ref, fields }
          : { operation: 'create', tool: harness.driverId === 'pi-cli' ? 'pi' : 'codex', fields },
        () => ref,
      ).config.agentClasses[ref]!;
      // Manual semantics and routing hints have their own existing validation path.
      const structural = (value: AgentClassDefinition) => {
        const { displayName, modelPolicy, enabled, executorManual, primaryUseCases, avoidUseCases, ...rest } = value;
        return rest;
      };
      if (stableJson(structural(expected)) === stableJson(structural(candidate))) result.add(ref);
    } catch {
      // Invalid or unbounded additions remain restart-required.
    }
  }
  return result;
}

function isHotPath(path: string): boolean {
  return path.startsWith('providers.')
    || path.startsWith('models.')
    || /^agentClasses\.[^.]+\.modelPolicy(?:\.|$)/u.test(path)
    || /^agentClasses\.[^.]+\.enabled$/u.test(path)
    // Routing use-case hints guide AgentClass choice and are resolved from the
    // current active revision before each Planner turn, so they are hot-safe
    // (ADR-0033: a successful idle activation affects the next Planner turn).
    // A display name only labels a projection; it is resolved from the current
    // active revision at projection time and never enters compiled artifacts or
    // routing decisions, so it is hot-safe for the same reason as use-case hints.
    || /^agentClasses\.[^.]+\.displayName$/u.test(path)
    || /^agentClasses\.[^.]+\.primaryUseCases$/u.test(path)
    || /^agentClasses\.[^.]+\.avoidUseCases$/u.test(path)
    || /^agentClasses\.[^.]+\.executorManual(?:\.|$)/u.test(path);
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
