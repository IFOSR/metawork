import {
  AnyFusionConfigurationV2Schema,
  buildKernelConfigurationView,
  buildPlannerConfigurationView,
  compileConfigurationRevision,
  type ConfigurationSnapshot,
  type KernelConfigurationView,
  type PlannerConfigurationView,
} from './index.js';
import type { RevisionedAgentBinding } from '../core/authorized-executor-binding.js';
import { authorizedExecutorBindingFingerprint } from '../core/authorized-executor-binding.js';
import { AutoModelResolver } from '../routing/auto-model-resolver.js';
import { projectConfigurationCandidates } from '../routing/configuration-candidate-projection.js';

export interface StagedLegacyConfiguration {
  snapshot: ConfigurationSnapshot;
  planner: PlannerConfigurationView;
  kernel: KernelConfigurationView;
  plannerBinding: RevisionedAgentBinding;
  plannerBindingFingerprint: string;
}

export function buildStagedLegacyConfiguration(input: {
  migratedSnapshot?: ConfigurationSnapshot;
  testMode?: boolean;
} = {}): StagedLegacyConfiguration {
  const testMode = input.testMode ?? process.env.NODE_ENV === 'test';
  const snapshot = input.migratedSnapshot
    ? validateMigratedSnapshot(input.migratedSnapshot)
    : testMode
      ? buildTestSnapshot()
      : failMissingMigratedSnapshot();
  const planner = snapshot.config.agentClasses.planner;
  if (!planner || planner.kind !== 'planner') {
    throw new Error('staged configuration requires the Planner AgentClass');
  }
  const modelCandidates = projectConfigurationCandidates(snapshot.config, 'planner');
  const modelRef = AutoModelResolver.resolve({
    configurationRevision: snapshot.revisionId,
    agentClassRef: 'planner',
    harnessRef: planner.harnessRef,
    permissionProfileRef: planner.permissionProfileRef ?? 'planner-none',
    policy: planner.modelPolicy,
    candidates: modelCandidates,
    requirements: {
      preferredCapabilities: ['planning', 'structured-output'],
      contextTokens: 1_024,
      requiresStructuredOutput: true,
    },
  }).binding?.modelRef;
  if (!modelRef) throw new Error('staged Planner fixed policy did not resolve a Model');
  const model = snapshot.config.models[modelRef];
  if (!model) throw new Error(`staged Planner references missing Model: ${modelRef}`);
  if (!snapshot.config.providers[model.providerRef]) {
    throw new Error(`staged Planner Model references missing Provider: ${model.providerRef}`);
  }
  if (!snapshot.config.harnesses[planner.harnessRef]) {
    throw new Error(`staged Planner references missing Harness: ${planner.harnessRef}`);
  }
  const plannerBinding: RevisionedAgentBinding = {
    agentClassRef: 'planner',
    harnessRef: planner.harnessRef,
    providerRef: model.providerRef,
    modelRef,
    permissionProfileRef: planner.permissionProfileRef ?? null,
    configurationRevision: snapshot.revisionId,
  };
  const plannerFingerprintBinding = {
    ...plannerBinding,
    permissionProfileRef: plannerBinding.permissionProfileRef ?? 'planner-none',
  };
  return {
    snapshot,
    planner: buildPlannerConfigurationView(snapshot),
    kernel: buildKernelConfigurationView(snapshot),
    plannerBinding,
    plannerBindingFingerprint: authorizedExecutorBindingFingerprint(
      plannerFingerprintBinding,
    ),
  };
}

function buildTestSnapshot(): ConfigurationSnapshot {
  const providerRef = 'test-provider';
  const modelRef = 'test-model';
  const config = AnyFusionConfigurationV2Schema.parse({
    schemaVersion: 2,
    providers: {
      [providerRef]: {
        protocol: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKeyRef: `keychain:anyfusion/imported/${providerRef}`,
        region: 'international',
        enabled: true,
      },
    },
    models: {
      [modelRef]: {
        providerRef,
        modelId: modelRef,
        capabilities: ['coding', 'planning', 'structured-output', 'tools'],
        reasoning: 'high',
        enabled: true,
      },
    },
    harnesses: {
      'anyfusion-planner': {
        kind: 'planner',
        transport: 'local-process',
        commandRef: 'release:planner',
        args: [],
        driverId: 'anyfusion-planner-host-v2',
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
        enabled: true,
      },
      'codex-cli': {
        kind: 'executor',
        transport: 'local-cli',
        command: 'codex',
        args: [],
        driverId: 'codex-cli',
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
        enabled: true,
      },
      'pi-cli': {
        kind: 'executor',
        transport: 'local-cli',
        command: 'pi',
        args: [],
        driverId: 'pi-cli',
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
        enabled: true,
      },
    },
    agentClasses: {
      planner: {
        kind: 'planner',
        harnessRef: 'anyfusion-planner',
        modelPolicy: { mode: 'fixed', modelRef },
        routingCapabilities: [],
        primaryUseCases: [],
        avoidUseCases: [],
        plannerAffordances: [],
        skills: ['metaclaw-planner'],
        mcpServers: ['metaclaw-planner'],
        plugins: [],
        generatedRuntimeRef: 'planner',
        enabled: true,
      },
      'codex-cli': {
        kind: 'executor',
        harnessRef: 'codex-cli',
        modelPolicy: { mode: 'fixed', modelRef },
        permissionProfileRef: 'workspace-engineering',
        routingCapabilities: ['workspace-engineering'],
        primaryUseCases: ['repository implementation', 'tests', 'engineering documentation', 'image generation', 'image editing'],
        avoidUseCases: ['current public-web research requiring source-backed delivery'],
        plannerAffordances: ['workspace-read-write', 'workspace-command-validation'],
        skills: [],
        mcpServers: [],
        plugins: [],
        generatedRuntimeRef: 'codex-cli',
        enabled: true,
      },
      'pi-agent': {
        kind: 'executor',
        harnessRef: 'pi-cli',
        modelPolicy: { mode: 'fixed', modelRef },
        permissionProfileRef: 'public-web-research',
        routingCapabilities: ['current-web-research'],
        primaryUseCases: ['current public-web research', 'source verification'],
        avoidUseCases: ['repository modification and engineering verification'],
        plannerAffordances: ['public-web-search', 'public-web-fetch', 'source-citation'],
        skills: [],
        mcpServers: [],
        plugins: [],
        generatedRuntimeRef: 'pi-agent',
        enabled: true,
      },
    },
    permissionProfiles: {
      'workspace-engineering': {
        profileId: 'workspace-engineering',
        version: 1,
        parameters: { maxAdditionalReadPartitions: 8 },
      },
      'public-web-research': {
        profileId: 'public-web-research',
        version: 1,
        parameters: {},
      },
    },
    runtimePolicy: {},
    gateway: {},
  });
  const compiled = compileConfigurationRevision('revision-test', config);
  return {
    revisionId: 'revision-test',
    contentHash: compiled.contentHash,
    config,
  };
}

function validateMigratedSnapshot(
  snapshot: ConfigurationSnapshot,
): ConfigurationSnapshot {
  const config = AnyFusionConfigurationV2Schema.parse(snapshot.config);
  const compiled = compileConfigurationRevision(snapshot.revisionId, config);
  if (compiled.contentHash === snapshot.contentHash) return snapshot;
  if (legacyRuntimePolicyContentHash(snapshot.revisionId, config) !== snapshot.contentHash) {
    throw new Error(
      `migrated configuration snapshot content hash mismatch: ${snapshot.revisionId}`,
    );
  }
  return { ...snapshot, config };
}

function legacyRuntimePolicyContentHash(
  revisionId: string,
  config: ConfigurationSnapshot['config'],
): string {
  const {
    maxConcurrentTasks: _maxConcurrentTasks,
    maxConcurrentAttempts: _maxConcurrentAttempts,
    maxConcurrentAttemptsPerTask: _maxConcurrentAttemptsPerTask,
    schedulingAgingMs: _schedulingAgingMs,
    sameConversationQueueLimit: _sameConversationQueueLimit,
    ...legacyRuntimePolicy
  } = config.runtimePolicy;
  return compileConfigurationRevision(revisionId, {
    ...config,
    runtimePolicy: legacyRuntimePolicy,
  }).contentHash;
}

function failMissingMigratedSnapshot(): never {
  throw new Error(
    'production startup requires an explicit migrated configuration snapshot',
  );
}
