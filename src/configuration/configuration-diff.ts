import { isDeepStrictEqual } from 'node:util';
import { prepareStandardAgentConfiguration, STANDARD_AGENT_PROFILES } from './standard-agent-configuration.js';
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
      && !lifecycleRefs.harnessPaths.has(entry.path)
      && !lifecycleRefs.profilePaths.has(entry.path)
      && ![...lifecycleRefs.agents].some(ref => (
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

function boundedExecutorChanges(before: unknown, after: unknown): { agents: Set<string>; harnessPaths: Set<string>; profilePaths: Set<string> } {
  const result = { agents: new Set<string>(), harnessPaths: new Set<string>(), profilePaths: new Set<string>() };
  const parse = (value: unknown) => {
    try { return AnyFusionConfigurationV2Schema.safeParse(value); } catch { return null; }
  };
  const oldParsed = parse(before);
  const nextParsed = parse(after);
  if (!oldParsed?.success || !nextParsed?.success) return result;
  const original = oldParsed.data as AnyFusionConfigurationV2;
  let old: AnyFusionConfigurationV2;
  try { old = prepareStandardAgentConfiguration(original); } catch { return result; }
  const next = nextParsed.data as AnyFusionConfigurationV2;
  let normalizedNext: AnyFusionConfigurationV2;
  try { normalizedNext = prepareStandardAgentConfiguration(next); } catch { return result; }
  for (const [ref, profile] of Object.entries(STANDARD_AGENT_PROFILES)) {
    if (!original.permissionProfiles[ref] && isDeepStrictEqual(next.permissionProfiles[ref], profile)
      && Object.values(next.agentClasses).some(agent => agent.kind === 'executor' && agent.permissionProfileRef === ref)) {
      result.profilePaths.add(`permissionProfiles.${ref}`);
    }
    if (isDeepStrictEqual(original.permissionProfiles[ref], profile) && !next.permissionProfiles[ref]
      && !Object.values(next.agentClasses).some(agent => agent.permissionProfileRef === ref)) {
      result.profilePaths.add(`permissionProfiles.${ref}`);
    }
  }
  for (const ref of new Set([...Object.keys(old.agentClasses), ...Object.keys(next.agentClasses)])) {
    const previous = old.agentClasses[ref];
    const candidate = next.agentClasses[ref];
    const definition = candidate ?? previous;
    if (definition?.kind !== 'executor' || (previous && previous.kind !== 'executor')) continue;
    const harness = old.harnesses[definition.harnessRef];
    const nextHarness = next.harnesses[definition.harnessRef];
    const enablingTool = Boolean(candidate?.enabled && harness && !harness.enabled
      && nextHarness?.enabled && stableJson({ ...harness, enabled: true }) === stableJson(nextHarness));
    if (!harness || harness.kind !== 'executor'
      || !['pi-cli', 'codex-cli'].includes(harness.driverId)
      || (!enablingTool && stableJson(harness) !== stableJson(nextHarness))) continue;
    if (!candidate) {
      result.agents.add(ref);
      continue;
    }
    try {
      const fields = {
        displayName: candidate.displayName ?? ref,
        modelPolicy: candidate.modelPolicy,
        manualSourceText: candidate.executorManual?.sourceText ?? '',
        enabled: candidate.enabled,
      };
      const expected = buildExecutorConfigurationCandidate(
        // Models and agents can be added in the same settings transaction.
        // Tool/permission templates still come from the active configuration.
        { revisionId: 'classification', contentHash: '', config: { ...old, models: next.models } },
        previous
          ? { operation: 'update', agentClassRef: ref, fields }
          : { operation: 'create', tool: harness.driverId === 'pi-cli' ? 'pi' : 'codex', fields },
        () => ref,
      ).config.agentClasses[ref]!;
      // Manual semantics and routing hints have their own existing validation path.
      const structural = (value: AgentClassDefinition) => {
        const { displayName, responsibility, modelPolicy, enabled, executorManual, primaryUseCases, avoidUseCases, ...rest } = value;
        return rest;
      };
      if (stableJson(structural(expected)) === stableJson(structural(candidate))
        || (original.agentClasses[ref] && (stableJson(structural(original.agentClasses[ref]!)) === stableJson(structural(candidate))
          || stableJson(structural(original.agentClasses[ref]!)) === stableJson(structural(normalizedNext.agentClasses[ref]!))))) {
        result.agents.add(ref);
        if (enablingTool) result.harnessPaths.add(`harnesses.${definition.harnessRef}.enabled`);
      }
    } catch {
      // Invalid or unbounded additions remain restart-required.
    }
  }
  return result;
}

function isHotPath(path: string): boolean {
  return path.startsWith('providers.')
    || path.startsWith('models.')
    // The optional Span advisor section is resolved from the current active
    // revision before each Planner turn (ADR-0033), so it is hot-safe for the
    // same reason as Provider/Model catalog changes.
    || path === 'routing'
    || path.startsWith('routing.')
    // The settings task limit is read from the active policy at admission and
    // queue promotion; attempt/backend limits still require a process restart.
    || path === 'runtimePolicy.maxConcurrentTasks'
    || /^agentClasses\.[^.]+\.modelPolicy(?:\.|$)/u.test(path)
    || /^agentClasses\.[^.]+\.enabled$/u.test(path)
    // Routing use-case hints guide AgentClass choice and are resolved from the
    // current active revision before each Planner turn, so they are hot-safe
    // (ADR-0033: a successful idle activation affects the next Planner turn).
    // A display name only labels a projection; it is resolved from the current
    // active revision at projection time and never enters compiled artifacts or
    // routing decisions, so it is hot-safe for the same reason as use-case hints.
    || /^agentClasses\.[^.]+\.displayName$/u.test(path)
    || /^agentClasses\.[^.]+\.responsibility$/u.test(path)
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
