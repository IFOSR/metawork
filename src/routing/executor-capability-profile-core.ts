import { createHash } from 'node:crypto';
import type {
  AgentClassDefinition,
  ExecutorCapabilityDisposition,
  HarnessDefinition,
  ModelCapability,
  ModelProfile,
  PlannerExecutorCapabilityManual,
  ProviderDefinition,
} from '../configuration/types.js';
import {
  knownModelCapabilities,
  mergeKnownModelCapabilities,
} from '../configuration/model-capability-catalog.js';
import { harnessDriverCatalogEntry } from '../configuration/harness-driver-catalog.js';
import {
  ROUTING_CAPABILITY_IDS,
  ROUTING_CAPABILITY_REGISTRY,
  type RoutingCapabilityId,
} from './types.js';

export interface ExecutorCapabilityProfileInput {
  agentClassRef: string;
  agentClass: AgentClassDefinition;
  models: Readonly<Record<string, ModelProfile>>;
  providers: Readonly<Record<string, Pick<ProviderDefinition, 'enabled' | 'region'>>>;
  configurationRevision: string;
  harness?: Pick<HarnessDefinition, 'driverId'>;
}

export interface EffectiveExecutorModel {
  modelRef: string;
  model: ModelProfile;
  capabilitySources: Partial<Record<
    ModelCapability,
    'model-system-known' | 'model-provider-declared' | 'model-user-confirmed'
  >>;
}

export interface ExecutorCapabilityProfileCore {
  schemaVersion: 1;
  agentClassRef: string;
  configurationRevision: string;
  sourceFingerprint: string;
  effectiveModels: EffectiveExecutorModel[];
  capabilities: PlannerExecutorCapabilityManual['capabilities'];
  routableCapabilities: RoutingCapabilityId[];
  modelCapabilities: Record<string, ModelCapability[]>;
}

const MODEL_CAPABILITY_TO_ROUTING: Partial<Record<ModelCapability, RoutingCapabilityId>> = {
  'image-editing': 'image-editing',
  'image-generation': 'image-generation',
};

export function compileExecutorCapabilityProfileCore(
  input: ExecutorCapabilityProfileInput,
): ExecutorCapabilityProfileCore {
  if (input.agentClass.kind !== 'executor') {
    throw new Error(`capability profile requires an Executor AgentClass: ${input.agentClassRef}`);
  }

  const policyModelRefs = input.agentClass.modelPolicy.mode === 'fixed'
    ? [input.agentClass.modelPolicy.modelRef]
    : input.agentClass.modelPolicy.allowedModelRefs;
  const allowedModelRefs = new Set(policyModelRefs);
  const userConfirmedByModel = collectUserConfirmedModelCapabilities(
    input.agentClass,
    allowedModelRefs,
  );
  const effectiveModels = policyModelRefs
    .map(modelRef => buildEffectiveModel(
      modelRef,
      input.models[modelRef],
      input.providers,
      userConfirmedByModel.get(modelRef) ?? new Set(),
    ))
    .filter((value): value is EffectiveExecutorModel => value !== null);
  const capabilityPolicies = collectCapabilityPolicies(input.agentClass);
  const candidateCapabilities = new Set<RoutingCapabilityId>([
    ...input.agentClass.routingCapabilities,
    ...capabilityPolicies.keys(),
  ]);
  for (const assertion of input.agentClass.executorManual?.assertions ?? []) {
    if (assertion.topic === 'model-contribution' && assertion.modelCapability) {
      const routingCapability = MODEL_CAPABILITY_TO_ROUTING[assertion.modelCapability];
      if (routingCapability) candidateCapabilities.add(routingCapability);
    }
  }

  for (const model of effectiveModels) {
    for (const modelCapability of model.model.capabilities) {
      const routingCapability = MODEL_CAPABILITY_TO_ROUTING[modelCapability];
      if (routingCapability) candidateCapabilities.add(routingCapability);
    }
  }

  const capabilities = [...candidateCapabilities]
    .sort((left, right) => left.localeCompare(right))
    .map(capabilityId => compileCapability(
      capabilityId,
      input.agentClass,
      effectiveModels,
      capabilityPolicies.get(capabilityId),
      resolveHarnessExecutionProtocols(input),
    ));
  const modelCapabilities = Object.fromEntries(effectiveModels.map(model => [
    model.modelRef,
    [...model.model.capabilities],
  ]));
  const routableCapabilities = capabilities
    .filter(capability => (
      capability.support === 'supported'
      && capability.routingDisposition !== 'disabled'
    ))
    .map(capability => capability.capabilityId)
    .sort((left, right) => left.localeCompare(right));
  const sourceFingerprint = fingerprint({
    schemaVersion: 1,
    agentClassRef: input.agentClassRef,
    agentClass: profileFingerprintAgentClass(input.agentClass),
    models: effectiveModels,
    providers: Object.fromEntries(
      policyModelRefs
        .map(modelRef => input.models[modelRef]?.providerRef)
        .filter((providerRef): providerRef is string => Boolean(providerRef))
        .sort()
        .map(providerRef => [providerRef, input.providers[providerRef] ?? null]),
    ),
    capabilities,
    modelCapabilities,
  });

  return {
    schemaVersion: 1,
    agentClassRef: input.agentClassRef,
    configurationRevision: input.configurationRevision,
    sourceFingerprint,
    effectiveModels,
    capabilities,
    routableCapabilities,
    modelCapabilities,
  };
}

function profileFingerprintAgentClass(
  agentClass: AgentClassDefinition,
): AgentClassDefinition {
  if (!agentClass.executorManual) return agentClass;
  const { semanticReceipt: _semanticReceipt, ...executorManual } =
    agentClass.executorManual;
  return {
    ...agentClass,
    executorManual,
  };
}

function buildEffectiveModel(
  modelRef: string,
  configured: ModelProfile | undefined,
  providers: ExecutorCapabilityProfileInput['providers'],
  userConfirmed: ReadonlySet<ModelCapability>,
): EffectiveExecutorModel | null {
  if (
    !configured
    || !configured.enabled
    || providers[configured.providerRef]?.enabled === false
  ) {
    return null;
  }

  const known = new Set(knownModelCapabilities(configured.modelId) as ModelCapability[]);
  const declared = new Set(configured.capabilities);
  const capabilities = [...new Set([
    ...mergeKnownModelCapabilities(configured.modelId, configured.capabilities),
    ...userConfirmed,
  ])].sort((left, right) => left.localeCompare(right));
  const capabilitySources: EffectiveExecutorModel['capabilitySources'] = {};
  for (const capability of capabilities) {
    capabilitySources[capability] = known.has(capability)
      ? 'model-system-known'
      : declared.has(capability)
        ? 'model-provider-declared'
        : 'model-user-confirmed';
  }

  return {
    modelRef,
    model: {
      ...configured,
      capabilities,
    },
    capabilitySources,
  };
}

function collectUserConfirmedModelCapabilities(
  agentClass: AgentClassDefinition,
  allowedModelRefs: ReadonlySet<string>,
): Map<string, Set<ModelCapability>> {
  const result = new Map<string, Set<ModelCapability>>();
  for (const assertion of agentClass.executorManual?.assertions ?? []) {
    if (
      assertion.topic !== 'model-contribution'
      || !assertion.modelRef
      || !assertion.modelCapability
      || !allowedModelRefs.has(assertion.modelRef)
    ) {
      continue;
    }
    const capabilities = result.get(assertion.modelRef) ?? new Set<ModelCapability>();
    capabilities.add(assertion.modelCapability);
    result.set(assertion.modelRef, capabilities);
  }
  return result;
}

function collectCapabilityPolicies(
  agentClass: AgentClassDefinition,
): Map<RoutingCapabilityId, ExecutorCapabilityDisposition> {
  const result = new Map<RoutingCapabilityId, ExecutorCapabilityDisposition>();
  for (const assertion of agentClass.executorManual?.assertions ?? []) {
    if (
      assertion.topic === 'capability-policy'
      && assertion.routingCapability
      && assertion.disposition
    ) {
      result.set(assertion.routingCapability, assertion.disposition);
    }
  }
  return result;
}

function compileCapability(
  capabilityId: RoutingCapabilityId,
  agentClass: AgentClassDefinition,
  models: readonly EffectiveExecutorModel[],
  disposition: ExecutorCapabilityDisposition | undefined,
  harnessExecutionProtocols: readonly string[],
): PlannerExecutorCapabilityManual['capabilities'][number] {
  const definition = ROUTING_CAPABILITY_REGISTRY[capabilityId];
  const evidence: PlannerExecutorCapabilityManual['capabilities'][number]['evidence'] = [];
  const unresolvedReasons: string[] = [];

  if (agentClass.routingCapabilities.includes(capabilityId)) {
    evidence.push({
      kind: 'executor-declaration',
      detail: `Executor 配置声明 ${capabilityId}`,
    });
  }

  for (const affordance of definition.requiredAffordances) {
    if (agentClass.plannerAffordances.includes(affordance)) {
      evidence.push({
        kind: 'executor-affordance',
        detail: `Executor 提供 ${affordance}`,
      });
    } else {
      unresolvedReasons.push(`Executor 缺少受控能力 ${affordance}`);
    }
  }

  for (const requiredProtocol of definition.requiredHarnessProtocols) {
    if (harnessExecutionProtocols.includes(requiredProtocol)) {
      evidence.push({
        kind: 'harness-support',
        detail: `Harness 支持执行与产物协议 ${requiredProtocol}`,
      });
    } else {
      unresolvedReasons.push(
        `当前 Harness 缺少 ${capabilityId} 所需的执行与产物协议 ${requiredProtocol}`,
      );
    }
  }

  for (const requiredModelCapability of definition.requiredModelCapabilities) {
    const supportingModels = models.filter(model => (
      model.model.capabilities.includes(requiredModelCapability as ModelCapability)
    ));
    if (supportingModels.length === 0) {
      unresolvedReasons.push(
        `当前模型池没有可用模型提供 ${requiredModelCapability} 能力`,
      );
      continue;
    }
    for (const supportingModel of supportingModels) {
      const capability = requiredModelCapability as ModelCapability;
      evidence.push({
        kind: supportingModel.capabilitySources[capability] ?? 'model-provider-declared',
        modelRef: supportingModel.modelRef,
        detail: `模型 ${supportingModel.modelRef} 提供 ${requiredModelCapability}`,
      });
    }
  }

  return {
    capabilityId,
    support: unresolvedReasons.length === 0 ? 'supported' : 'unsupported',
    routingDisposition: disposition ?? 'allowed',
    evidence,
    unresolvedReasons,
  };
}

function resolveHarnessExecutionProtocols(
  input: ExecutorCapabilityProfileInput,
): readonly string[] {
  if (!input.harness) return [];
  return harnessDriverCatalogEntry(input.harness.driverId)?.executionProtocols ?? [];
}

export function routingCapabilityForModelCapability(
  capability: ModelCapability,
): RoutingCapabilityId | undefined {
  return MODEL_CAPABILITY_TO_ROUTING[capability];
}

export function isRoutingCapabilityId(value: string): value is RoutingCapabilityId {
  return ROUTING_CAPABILITY_IDS.includes(value as RoutingCapabilityId);
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(',')}}`;
}
