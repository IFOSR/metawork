import { buildConfigurationCatalog } from '../routing/configuration-catalog.js';
import { compileExecutorCapabilityProfile } from '../routing/executor-capability-profile.js';
import { mergeKnownModelCapabilities } from './model-capability-catalog.js';
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
      providerRef: model.providerRef,
      capabilities: mergeKnownModelCapabilities(model.modelId, model.capabilities),
      reasoning: model.reasoning,
      routingNotes: model.routingNotes
        ? cloneModelRoutingNotes(model.routingNotes)
        : undefined,
      region: snapshot.config.providers[model.providerRef]!.region,
      contextLimit: model.contextLimit,
      costTier: model.costTier,
      latencyTier: model.latencyTier,
      qualityTier: model.qualityTier,
      costInputPerMillion: model.costInputPerMillion,
      costOutputPerMillion: model.costOutputPerMillion,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const planner = snapshot.config.agentClasses.planner;
  const executorCapabilityProfiles = new Map(Object.entries(snapshot.config.agentClasses)
    .filter(([, agentClass]) => agentClass.kind === 'executor' && agentClass.enabled)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([agentClassRef, agentClass]) => [
      agentClassRef,
      compileExecutorCapabilityProfile({
        agentClassRef,
        agentClass,
        models: snapshot.config.models,
        providers: snapshot.config.providers,
        harness: snapshot.config.harnesses[agentClass.harnessRef],
        configurationRevision: snapshot.revisionId,
      }),
    ]));
  const executorCapabilityManuals = [...executorCapabilityProfiles.values()]
    .map(profile => profile.manual);

  return deepFreeze({
    revisionId: snapshot.revisionId,
    contentHash: snapshot.contentHash,
    models,
    // The schema guarantees Planner is fixed-only; executor Auto policies do
    // not leak into the Planner projection.
    ...(planner?.kind === 'planner' ? {
      planner: {
        harnessRef: planner.harnessRef,
        modelPolicy: cloneModelPolicy(planner.modelPolicy),
      },
    } : {}),
    routingCatalog: buildConfigurationCatalog(snapshot, executorCapabilityProfiles),
    executorCapabilityManuals,
  });
}

export function buildKernelConfigurationView(
  snapshot: ConfigurationSnapshot,
): KernelConfigurationView {
  const executorCapabilityProfiles = new Map(Object.entries(snapshot.config.agentClasses)
    .filter(([, agentClass]) => agentClass.kind === 'executor' && agentClass.enabled)
    .map(([agentClassRef, agentClass]) => [
      agentClassRef,
      compileExecutorCapabilityProfile({
        agentClassRef,
        agentClass,
        models: snapshot.config.models,
        providers: snapshot.config.providers,
        harness: snapshot.config.harnesses[agentClass.harnessRef],
        configurationRevision: snapshot.revisionId,
      }),
    ]));
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
          routingCapabilities: agentClass.kind === 'executor'
            ? executorCapabilityProfiles.get(id)?.routableCapabilities ?? []
            : [],
          modelCapabilities: agentClass.kind === 'executor'
            ? executorCapabilityProfiles.get(id)?.modelCapabilities ?? {}
            : {},
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
        modelId: model.modelId,
        capabilities: mergeKnownModelCapabilities(model.modelId, model.capabilities),
        reasoning: model.reasoning,
        contextLimit: model.contextLimit,
        costTier: model.costTier,
        latencyTier: model.latencyTier,
        qualityTier: model.qualityTier,
        costInputPerMillion: model.costInputPerMillion,
        costOutputPerMillion: model.costOutputPerMillion,
        enabled: model.enabled,
      }]),
  );
  const permissionProfiles = Object.fromEntries(
    Object.entries(snapshot.config.permissionProfiles)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, profile]) => [id, clonePermissionProfile(profile)]),
  );
  const providers = Object.fromEntries(
    Object.entries(snapshot.config.providers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, provider]) => [id, { enabled: provider.enabled }]),
  );

  return deepFreeze({
    revisionId: snapshot.revisionId,
    contentHash: snapshot.contentHash,
    agentClasses,
    models,
    providers,
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

function cloneModelRoutingNotes(
  notes: NonNullable<import('./types.js').ModelRoutingNotes>,
): NonNullable<import('./types.js').ModelRoutingNotes> {
  return {
    ...notes,
    strengths: notes.strengths ? [...notes.strengths] : undefined,
    limitations: notes.limitations ? [...notes.limitations] : undefined,
    preferredTaskTypes: notes.preferredTaskTypes ? [...notes.preferredTaskTypes] : undefined,
    avoidTaskTypes: notes.avoidTaskTypes ? [...notes.avoidTaskTypes] : undefined,
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
