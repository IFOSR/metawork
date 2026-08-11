import { buildConfigurationCatalog } from '../routing/configuration-catalog.js';
import type {
  ConfigurationSnapshot,
  KernelConfigurationView,
  ModelPolicy,
  PermissionProfile,
  PlannerConfigurationView,
  RuntimeConfigurationView,
} from './types.js';

export function buildPlannerConfigurationView(
  snapshot: ConfigurationSnapshot,
): PlannerConfigurationView {
  const models = Object.entries(snapshot.config.models)
    .filter(([, model]) => model.enabled)
    .map(([id, model]) => ({
      id,
      capabilities: [...model.capabilities].sort(),
      reasoning: model.reasoning,
      region: snapshot.config.providers[model.providerRef]!.region,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return deepFreeze({
    revisionId: snapshot.revisionId,
    contentHash: snapshot.contentHash,
    models,
    routingCatalog: buildConfigurationCatalog(snapshot),
  });
}

export function buildKernelConfigurationView(
  snapshot: ConfigurationSnapshot,
): KernelConfigurationView {
  const agentClasses = Object.fromEntries(
    Object.entries(snapshot.config.agentClasses)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, agentClass]) => {
        const harness = snapshot.config.harnesses[agentClass.harnessRef]!;
        return [id, {
          kind: agentClass.kind,
          harnessRef: agentClass.harnessRef,
          modelPolicy: cloneModelPolicy(agentClass.modelPolicy),
          permissionProfileRef: agentClass.permissionProfileRef ?? null,
          routingCapabilities: [...agentClass.routingCapabilities].sort(),
          enabled: agentClass.enabled,
          transport: harness.transport,
          supportsProbe: harness.supportsProbe,
          supportsAbort: harness.supportsAbort,
          supportsContinuation: harness.supportsContinuation,
        }];
      }),
  );
  const models = Object.fromEntries(
    Object.entries(snapshot.config.models)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, model]) => [id, {
        providerRef: model.providerRef,
        capabilities: [...model.capabilities].sort(),
        reasoning: model.reasoning,
        enabled: model.enabled,
      }]),
  );
  const permissionProfiles = Object.fromEntries(
    Object.entries(snapshot.config.permissionProfiles)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, profile]) => [id, clonePermissionProfile(profile)]),
  );

  return deepFreeze({
    revisionId: snapshot.revisionId,
    contentHash: snapshot.contentHash,
    agentClasses,
    models,
    permissionProfiles,
    runtimePolicy: { ...snapshot.config.runtimePolicy },
  });
}

export function buildRuntimeConfigurationView(
  snapshot: ConfigurationSnapshot,
): RuntimeConfigurationView {
  return deepFreeze({
    revisionId: snapshot.revisionId,
    contentHash: snapshot.contentHash,
    ...structuredClone(snapshot.config),
  });
}

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

function clonePermissionProfile(profile: PermissionProfile): PermissionProfile {
  return {
    ...profile,
    parameters: {
      ...profile.parameters,
      allowedPublicDomains: profile.parameters.allowedPublicDomains
        ? [...profile.parameters.allowedPublicDomains]
        : undefined,
    },
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
