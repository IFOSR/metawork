import { isDeepStrictEqual } from 'node:util';
import type { AnyFusionConfigurationV2, PermissionProfile } from './types.js';
import type { ExecutorAffordanceId } from '../routing/types.js';

/** Available CLI operations, not duties or permission inferred from prose. */
export const STANDARD_CLI_AFFORDANCES: ExecutorAffordanceId[] = [
  'workspace-read-write', 'workspace-command-validation',
  'public-web-search', 'public-web-fetch', 'source-citation',
];

export const STANDARD_AGENT_PROFILES: Readonly<Record<string, PermissionProfile>> = {
  'standard-agent': { profileId: 'standard-agent', version: 1, parameters: {} },
  'standard-agent-read-8': { profileId: 'standard-agent', version: 1, parameters: { maxAdditionalReadPartitions: 8 } },
};

export function standardProfileRef(profile: PermissionProfile | undefined): string | null {
  if (!profile || profile.version !== 1) return null;
  if (!['workspace-engineering', 'public-web-research', 'standard-agent'].includes(profile.profileId)) return null;
  if (isDeepStrictEqual(profile.parameters, {})) return 'standard-agent';
  if (profile.profileId !== 'public-web-research'
    && isDeepStrictEqual(profile.parameters, { maxAdditionalReadPartitions: 8 })) return 'standard-agent-read-8';
  return null;
}

export function ensureStandardAgentProfile(config: AnyFusionConfigurationV2, ref = 'standard-agent'): string {
  const expected = STANDARD_AGENT_PROFILES[ref];
  if (!expected) throw new Error('Unknown system baseline profile');
  if (config.permissionProfiles[ref] && !isDeepStrictEqual(config.permissionProfiles[ref], expected)) {
    throw new Error(`系统基础操作配置标识冲突：${ref}；未覆盖已有权限限制。`);
  }
  config.permissionProfiles[ref] = structuredClone(expected);
  return ref;
}

const OLD_TEMPLATES = [
  { routingCapabilities: ['current-web-research'],
    plannerAffordances: ['public-web-search', 'public-web-fetch', 'source-citation'],
    primaryUseCases: ['current public-web research', 'source verification'],
    avoidUseCases: ['repository modification and engineering verification'] },
  { routingCapabilities: ['workspace-engineering', 'document-processing'],
    plannerAffordances: ['workspace-read-write', 'workspace-command-validation'],
    primaryUseCases: ['repository implementation', 'tests', 'engineering documentation'], avoidUseCases: [] },
  { routingCapabilities: ['workspace-engineering', 'document-processing'],
    plannerAffordances: ['workspace-read-write', 'workspace-command-validation'],
    primaryUseCases: ['repository implementation', 'tests', 'engineering documentation', 'image generation', 'image editing'],
    avoidUseCases: ['current public-web research requiring source-backed delivery'] },
];

/** Pure draft preparation. Never called when loading a pinned historical revision. */
export function prepareStandardAgentConfiguration(input: AnyFusionConfigurationV2, refs?: readonly string[]): AnyFusionConfigurationV2 {
  const config = structuredClone(input);
  for (const [ref, agent] of Object.entries(config.agentClasses)) {
    if (refs && !refs.includes(ref)) continue;
    const driver = config.harnesses[agent.harnessRef]?.driverId;
    if (agent.kind !== 'executor' || !['pi-cli', 'codex-cli'].includes(driver ?? '')) continue;
    const profile = config.permissionProfiles[agent.permissionProfileRef ?? ''];
    const target = standardProfileRef(profile);
    if (!target || profile?.profileId === 'standard-agent') continue;
    agent.permissionProfileRef = ensureStandardAgentProfile(config, target);
    // Recognize the complete code-owned template, never a keyword in user text.
    const template = OLD_TEMPLATES.find(template =>
      isDeepStrictEqual(agent.routingCapabilities, template.routingCapabilities)
      && isDeepStrictEqual(agent.plannerAffordances, template.plannerAffordances));
    if (template) {
      const generatedHints = OLD_TEMPLATES.some(known =>
        isDeepStrictEqual(agent.primaryUseCases, known.primaryUseCases)
        && isDeepStrictEqual(agent.avoidUseCases, known.avoidUseCases));
      agent.routingCapabilities = [];
      agent.plannerAffordances = [...STANDARD_CLI_AFFORDANCES];
      if (generatedHints) { agent.primaryUseCases = []; agent.avoidUseCases = []; }
    }
  }
  return isDeepStrictEqual(config, input) ? input : config;
}
