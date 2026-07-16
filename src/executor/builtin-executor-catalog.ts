// Canonical built-in Executor definitions and their Planner-safe projection.
// Runtime health remains owned by the Kernel status projection, while concrete
// adapter factories remain wired by ExecutionRuntime until the next rollout.
import type { AgentClass } from '../core/types.js';

export const EXECUTOR_AFFORDANCE_IDS = [
  'public-web-fetch',
  'public-web-search',
  'source-citation',
  'workspace-command-validation',
  'workspace-read-write',
] as const;

export type ExecutorAffordanceId = typeof EXECUTOR_AFFORDANCE_IDS[number];

export interface RoutingCapabilityDefinition {
  deliveryContract: string;
  requiredAffordances: readonly ExecutorAffordanceId[];
}

export const ROUTING_CAPABILITY_REGISTRY = {
  'current-web-research': {
    deliveryContract: 'Research current public-web information, preserve traceable sources, and deliver source-backed findings.',
    requiredAffordances: ['public-web-search', 'public-web-fetch', 'source-citation'],
  },
  'workspace-engineering': {
    deliveryContract: 'Understand, modify, and verify code or text files in a controlled workspace and deliver the resulting changes or artifacts.',
    requiredAffordances: ['workspace-read-write', 'workspace-command-validation'],
  },
} as const satisfies Record<string, RoutingCapabilityDefinition>;

export type RoutingCapabilityId = keyof typeof ROUTING_CAPABILITY_REGISTRY;

type AgentClassDefaults = Omit<
  AgentClass,
  | 'name'
  | 'kind'
  | 'capabilities'
  | 'primaryUseCases'
  | 'avoidUseCases'
  | 'createdAt'
  | 'updatedAt'
>;

interface BuiltinExecutorDefinitionShape {
  name: string;
  routingCapabilities: readonly RoutingCapabilityId[];
  primaryUseCases: readonly string[];
  avoidUseCases: readonly string[];
  nativeAffordances: readonly ExecutorAffordanceId[];
  plannerAffordances: readonly ExecutorAffordanceId[];
  adapterBinding: {
    adapterName: string;
    commandAliases: readonly string[];
  };
  agentClassDefaults: AgentClassDefaults;
}

function defineBuiltinExecutorDefinitions<const TName extends string>(
  definitions: readonly (Omit<BuiltinExecutorDefinitionShape, 'name'> & { name: TName })[],
): readonly (Omit<BuiltinExecutorDefinitionShape, 'name'> & { name: TName })[] {
  return definitions;
}

export interface PlannerRoutingCapabilityDefinition {
  id: RoutingCapabilityId;
  deliveryContract: string;
}

export interface PlannerExecutorCatalogEntry {
  name: string;
  routingCapabilities: RoutingCapabilityId[];
  primaryUseCases: string[];
  avoidUseCases: string[];
  affordances: ExecutorAffordanceId[];
}

export interface PlannerExecutorCatalog {
  version: 2;
  capabilities: PlannerRoutingCapabilityDefinition[];
  executors: PlannerExecutorCatalogEntry[];
}

const BUILTIN_EXECUTOR_DEFINITIONS = defineBuiltinExecutorDefinitions([
  {
    name: 'codex-cli',
    routingCapabilities: ['workspace-engineering'],
    primaryUseCases: ['repository implementation', 'tests', 'engineering documentation', 'local artifacts'],
    avoidUseCases: ['current public-web research requiring source-backed delivery'],
    nativeAffordances: ['workspace-read-write', 'workspace-command-validation'],
    plannerAffordances: ['workspace-read-write', 'workspace-command-validation'],
    adapterBinding: {
      adapterName: 'codex-cli',
      commandAliases: ['codex'],
    },
    agentClassDefaults: {
      domains: ['software', 'repo', 'terminal', 'code_review'],
      inputTypes: ['text', 'files'],
      outputTypes: ['code', 'patch', 'markdown', 'review'],
      strengths: ['local repository editing', 'test execution', 'bug fixing', 'code review'],
      weaknesses: ['broad business workflow orchestration'],
      intentAffinity: { repo_execution: 1, technical_reasoning: 0.45, research_workflow: 0.15, general: 0.35 },
      riskLevel: 'medium',
      harness: 'cli',
      model: null,
      skills: [],
      mcpServers: [],
      plugins: [],
      runtimeCommand: null,
      runtimeArgs: [],
      runtimeCheckCommand: null,
      projectUrl: null,
    },
  },
  {
    name: 'pi-agent',
    routingCapabilities: ['current-web-research'],
    primaryUseCases: ['current public-web research', 'source verification', 'citation handoff'],
    avoidUseCases: ['repository modification and engineering verification'],
    nativeAffordances: [
      'public-web-search',
      'public-web-fetch',
      'source-citation',
      'workspace-read-write',
      'workspace-command-validation',
    ],
    plannerAffordances: ['public-web-search', 'public-web-fetch', 'source-citation'],
    adapterBinding: {
      adapterName: 'pi-agent',
      commandAliases: ['pi'],
    },
    agentClassDefaults: {
      domains: ['research', 'web'],
      inputTypes: ['text', 'files'],
      outputTypes: ['code', 'patch', 'markdown', 'review'],
      strengths: ['current public-web research', 'source verification', 'citation handoff'],
      weaknesses: ['repository engineering delivery'],
      intentAffinity: { repo_execution: 0.1, technical_reasoning: 0.35, research_workflow: 1, general: 0.25 },
      riskLevel: 'medium',
      harness: 'cli',
      model: null,
      skills: [],
      mcpServers: [],
      plugins: [],
      runtimeCommand: null,
      runtimeArgs: [],
      runtimeCheckCommand: null,
      projectUrl: null,
    },
  },
]);

export type BuiltinExecutorName = typeof BUILTIN_EXECUTOR_DEFINITIONS[number]['name'];

export type BuiltinExecutorDefinition = Omit<BuiltinExecutorDefinitionShape, 'name'> & {
  name: BuiltinExecutorName;
};

export function validateBuiltinExecutorDefinitions(
  definitions: readonly BuiltinExecutorDefinition[],
): string[] {
  const errors: string[] = [];
  const executorNames = new Set<string>();
  const bindingOwners = new Map<string, string>();

  for (const definition of definitions) {
    if (executorNames.has(definition.name)) {
      errors.push(`duplicate Executor name: ${definition.name}`);
    }
    executorNames.add(definition.name);

    if (definition.routingCapabilities.length === 0) {
      errors.push(`Executor ${definition.name} must declare at least one Routing Capability`);
    }

    collectDuplicateValues(errors, definition.name, 'Routing Capability', definition.routingCapabilities);
    collectDuplicateValues(errors, definition.name, 'native affordance', definition.nativeAffordances);
    collectDuplicateValues(errors, definition.name, 'Planner affordance', definition.plannerAffordances);

    const nativeAffordances = new Set<ExecutorAffordanceId>(definition.nativeAffordances);
    const plannerAffordances = new Set<ExecutorAffordanceId>(definition.plannerAffordances);
    for (const affordance of plannerAffordances) {
      if (!nativeAffordances.has(affordance)) {
        errors.push(`Executor ${definition.name} exposes non-native Planner affordance: ${affordance}`);
      }
    }

    for (const capabilityId of definition.routingCapabilities) {
      const capability = ROUTING_CAPABILITY_REGISTRY[capabilityId as RoutingCapabilityId];
      if (!capability) {
        errors.push(`Executor ${definition.name} references unregistered Routing Capability: ${String(capabilityId)}`);
        continue;
      }
      for (const affordance of capability.requiredAffordances) {
        if (!nativeAffordances.has(affordance)) {
          errors.push(`Executor ${definition.name} capability ${capabilityId} lacks native affordance: ${affordance}`);
        }
        if (!plannerAffordances.has(affordance)) {
          errors.push(`Executor ${definition.name} capability ${capabilityId} lacks Planner affordance: ${affordance}`);
        }
      }
    }

    const bindingKeys = [definition.adapterBinding.adapterName, ...definition.adapterBinding.commandAliases];
    if (definition.adapterBinding.commandAliases.length === 0) {
      errors.push(`Executor ${definition.name} must declare at least one command alias`);
    }
    for (const bindingKey of bindingKeys) {
      if (!bindingKey.trim()) {
        errors.push(`Executor ${definition.name} contains an empty Adapter binding`);
        continue;
      }
      const owner = bindingOwners.get(bindingKey);
      if (owner) {
        errors.push(`duplicate Adapter binding ${bindingKey}: ${owner}, ${definition.name}`);
      } else {
        bindingOwners.set(bindingKey, definition.name);
      }
    }
  }

  return errors.sort((left, right) => left.localeCompare(right));
}

const DEFINITION_ERRORS = validateBuiltinExecutorDefinitions(BUILTIN_EXECUTOR_DEFINITIONS);
if (DEFINITION_ERRORS.length > 0) {
  throw new Error(`Invalid built-in Executor definitions: ${DEFINITION_ERRORS.join('; ')}`);
}

export function getBuiltinExecutorDefinitions(): BuiltinExecutorDefinition[] {
  return BUILTIN_EXECUTOR_DEFINITIONS
    .map(cloneBuiltinExecutorDefinition)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function getBuiltinExecutorDefinition(name: string): BuiltinExecutorDefinition | null {
  const definition = BUILTIN_EXECUTOR_DEFINITIONS.find(candidate => candidate.name === name);
  return definition ? cloneBuiltinExecutorDefinition(definition) : null;
}

export function getBuiltinExecutorAgentClasses(): AgentClass[] {
  return getBuiltinExecutorDefinitions().map(definition => ({
    name: definition.name,
    kind: 'executor',
    ...definition.agentClassDefaults,
    capabilities: [...definition.routingCapabilities],
    primaryUseCases: [...definition.primaryUseCases],
    avoidUseCases: [...definition.avoidUseCases],
  }));
}

export function isBuiltinExecutorName(name: string): name is BuiltinExecutorName {
  return BUILTIN_EXECUTOR_DEFINITIONS.some(definition => definition.name === name);
}

export function getPlannerExecutorCatalog(): PlannerExecutorCatalog {
  const capabilities = (Object.entries(ROUTING_CAPABILITY_REGISTRY) as Array<[
    RoutingCapabilityId,
    RoutingCapabilityDefinition,
  ]>)
    .map(([id, capability]) => ({ id, deliveryContract: capability.deliveryContract }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const executors = BUILTIN_EXECUTOR_DEFINITIONS
    .map(definition => ({
      name: definition.name,
      routingCapabilities: [...definition.routingCapabilities].sort(),
      primaryUseCases: [...definition.primaryUseCases].sort(),
      avoidUseCases: [...definition.avoidUseCases].sort(),
      affordances: [...definition.plannerAffordances].sort(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return { version: 2, capabilities, executors };
}

function collectDuplicateValues(
  errors: string[],
  executorName: string,
  label: string,
  values: readonly string[],
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) errors.push(`Executor ${executorName} contains duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function cloneBuiltinExecutorDefinition(definition: BuiltinExecutorDefinition): BuiltinExecutorDefinition {
  return {
    ...definition,
    routingCapabilities: [...definition.routingCapabilities],
    primaryUseCases: [...definition.primaryUseCases],
    avoidUseCases: [...definition.avoidUseCases],
    nativeAffordances: [...definition.nativeAffordances],
    plannerAffordances: [...definition.plannerAffordances],
    adapterBinding: {
      ...definition.adapterBinding,
      commandAliases: [...definition.adapterBinding.commandAliases],
    },
    agentClassDefaults: {
      ...definition.agentClassDefaults,
      domains: [...definition.agentClassDefaults.domains],
      inputTypes: [...definition.agentClassDefaults.inputTypes],
      outputTypes: [...definition.agentClassDefaults.outputTypes],
      strengths: [...definition.agentClassDefaults.strengths],
      weaknesses: [...definition.agentClassDefaults.weaknesses],
      intentAffinity: { ...definition.agentClassDefaults.intentAffinity },
      skills: [...definition.agentClassDefaults.skills],
      mcpServers: [...definition.agentClassDefaults.mcpServers],
      plugins: [...definition.agentClassDefaults.plugins],
      runtimeArgs: [...definition.agentClassDefaults.runtimeArgs],
    },
  };
}
