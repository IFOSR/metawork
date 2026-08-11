import type { ConfigurationSnapshot, ModelPolicy } from '../configuration/types.js';
import {
  ROUTING_CAPABILITY_REGISTRY,
  type ConfigurationCatalogAgentClass,
  type ConfigurationRoutingCatalog,
  type RoutingCapabilityId,
} from './types.js';

export function validateRoutingCapabilityReferences(
  capabilityRefs: readonly string[],
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const capabilityRef of capabilityRefs) {
    if (seen.has(capabilityRef)) {
      errors.push(`duplicate Routing Capability reference: ${capabilityRef}`);
    }
    seen.add(capabilityRef);

    if (!(capabilityRef in ROUTING_CAPABILITY_REGISTRY)) {
      errors.push(`unregistered Routing Capability: ${capabilityRef}`);
    }
  }

  return errors.sort((left, right) => left.localeCompare(right));
}

export function buildConfigurationCatalog(
  snapshot: ConfigurationSnapshot,
): ConfigurationRoutingCatalog {
  const capabilities = Object.entries(ROUTING_CAPABILITY_REGISTRY)
    .map(([id, definition]) => ({
      id: id as RoutingCapabilityId,
      deliveryContract: definition.deliveryContract,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const agentClasses = Object.entries(snapshot.config.agentClasses)
    .filter(([, agentClass]) => agentClass.kind === 'executor' && agentClass.enabled)
    .map(([id, agentClass]): ConfigurationCatalogAgentClass => ({
      id,
      routingCapabilities: [...agentClass.routingCapabilities].sort(),
      primaryUseCases: [...agentClass.primaryUseCases].sort(),
      avoidUseCases: [...agentClass.avoidUseCases].sort(),
      affordances: [...agentClass.plannerAffordances].sort(),
      modelPolicy: cloneModelPolicy(agentClass.modelPolicy),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return deepFreeze({
    version: 2,
    configurationRevision: snapshot.revisionId,
    capabilities,
    agentClasses,
  });
}

export const buildConfigurationRoutingCatalog = buildConfigurationCatalog;
export const buildPlannerRoutingCatalog = buildConfigurationCatalog;

function cloneModelPolicy(modelPolicy: ModelPolicy): ModelPolicy {
  if (modelPolicy.mode === 'fixed') {
    return { ...modelPolicy };
  }

  return {
    ...modelPolicy,
    allowedModelRefs: [...modelPolicy.allowedModelRefs],
    fallback: modelPolicy.fallback
      ? {
          ...modelPolicy.fallback,
          order: [...modelPolicy.fallback.order],
        }
      : undefined,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}
