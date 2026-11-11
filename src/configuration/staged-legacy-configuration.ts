import {
  AnyFusionConfigurationV2Schema,
  buildControlConfigurationView,
  buildPlannerConfigurationView,
  compileConfigurationRevision,
  type ConfigurationSnapshot,
  type ControlConfigurationView,
  type PlannerConfigurationView,
} from './index.js';
import { configurationContentHash } from './configuration-service.js';
import { RETIRED_SPAN_ROUTING_MODELS } from './schema.js';
import type { RevisionedAgentBinding } from '../core/authorized-executor-binding.js';
import { authorizedExecutorBindingFingerprint } from '../core/authorized-executor-binding.js';
import { AutoModelResolver } from '../routing/auto-model-resolver.js';
import { projectConfigurationCandidates } from '../routing/configuration-candidate-projection.js';

export interface StagedLegacyConfiguration {
  snapshot: ConfigurationSnapshot;
  planner: PlannerConfigurationView;
  kernel: ControlConfigurationView;
  plannerBinding: RevisionedAgentBinding | null;
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
  if (planner?.kind === 'planner' && !planner.enabled) {
    return {
      snapshot, planner: buildPlannerConfigurationView(snapshot),
      kernel: buildControlConfigurationView(snapshot),
      plannerBinding: null, plannerBindingFingerprint: '',
    };
  }
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
    kernel: buildControlConfigurationView(snapshot),
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
      'pi-engineering-fixture': {
        kind: 'executor',
        transport: 'local-cli',
        // Test fixtures keep the historical AgentClass identity so persisted
        // graph assertions remain readable, but execute through the only
        // supported runtime. Production configuration never creates this
        // compatibility-shaped entry.
        command: 'pi',
        args: [],
        driverId: 'pi-cli',
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
        enabled: true,
      },
      'pi-engineering-cli': {
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
      'pi-engineering-fixture': {
        displayName: '智能体 2',
        kind: 'executor',
        harnessRef: 'pi-engineering-fixture',
        modelPolicy: { mode: 'fixed', modelRef },
        permissionProfileRef: 'workspace-engineering',
        routingCapabilities: ['workspace-engineering', 'document-processing'],
        primaryUseCases: ['repository implementation', 'tests', 'engineering documentation', 'image generation', 'image editing'],
        avoidUseCases: ['current public-web research requiring source-backed delivery'],
        plannerAffordances: ['workspace-read-write', 'workspace-command-validation'],
        skills: [],
        mcpServers: [],
        plugins: [],
        generatedRuntimeRef: 'pi-engineering-fixture',
        enabled: true,
      },
      // Engineering Executor on the packaged Pi (ADR-0055 D6). Its own harness so
      // enabling or disabling it never changes another Executor's tool.
      'pi-engineering': {
        // Same user-facing name as the engineering Executor it replaces, so a
        // migrated suite reads the same 「智能体 2」 projection.
        displayName: '智能体 2',
        kind: 'executor',
        harnessRef: 'pi-engineering-cli',
        modelPolicy: { mode: 'fixed', modelRef },
        permissionProfileRef: 'workspace-engineering',
        routingCapabilities: ['workspace-engineering', 'document-processing'],
        primaryUseCases: ['repository implementation', 'tests', 'engineering documentation'],
        avoidUseCases: [],
        plannerAffordances: [
          'workspace-read-write', 'workspace-command-validation',
          'public-web-search', 'public-web-fetch', 'source-citation',
        ],
        skills: [],
        mcpServers: [],
        plugins: [],
        generatedRuntimeRef: 'pi-engineering',
        enabled: true,
      },
      'pi-agent': {
        displayName: '智能体 1',
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
  if (
    legacyRuntimePolicyContentHash(snapshot.revisionId, config) !== snapshot.contentHash
    && previousRuntimePolicySchemaContentHash(snapshot.revisionId, config) !== snapshot.contentHash
    && !matchesRetiredSpanContentHash(config, snapshot.contentHash)
  ) {
    throw new Error(
      `migrated configuration snapshot content hash mismatch: ${snapshot.revisionId}`,
    );
  }
  return { ...snapshot, config };
}

/** Undo only the known read-time model substitution for integrity checking. */
function matchesRetiredSpanContentHash(
  config: ConfigurationSnapshot['config'],
  contentHash: string,
): boolean {
  const span = config.routing?.span;
  if (!span) return false;
  return RETIRED_SPAN_ROUTING_MODELS.some(model => configurationContentHash({
    ...config,
    routing: {
      ...config.routing,
      span: { ...span, model },
    },
  }) === contentHash);
}

/**
 * Rebuild the policy the previous schema version would have parsed.
 *
 * A snapshot written before the Workspace-scoped capacity change was hashed
 * with the retired account-wide defaults present and without the new key, so
 * reproducing that exact shape is what makes an existing activation still
 * verify. Everything outside the policy block keeps its full integrity check.
 */
function previousRuntimePolicySchemaContentHash(
  revisionId: string,
  config: ConfigurationSnapshot['config'],
): string {
  const policy = config.runtimePolicy;
  const {
    maxConcurrentConversationsPerWorkspace: _maxConcurrentConversationsPerWorkspace,
    ...rest
  } = policy;
  return compileConfigurationRevision(revisionId, {
    ...config,
    runtimePolicy: {
      ...rest,
      maxConcurrentTasks: policy.maxConcurrentTasks ?? 2,
      maxConcurrentAttempts: policy.maxConcurrentAttempts ?? 4,
      maxConcurrentAttemptsPerTask: policy.maxConcurrentAttemptsPerTask ?? 2,
      schedulingAgingMs: policy.schedulingAgingMs ?? 300_000,
      sameConversationQueueLimit: policy.sameConversationQueueLimit ?? 8,
    },
  }).contentHash;
}

/**
 * Hash compatibility for snapshots written before RuntimePolicy had defaults
 * at all: compare with the whole block removed.
 */
function legacyRuntimePolicyContentHash(
  revisionId: string,
  config: ConfigurationSnapshot['config'],
): string {
  const { runtimePolicy: _runtimePolicy, ...rest } = config;
  return compileConfigurationRevision(revisionId, {
    ...rest,
    runtimePolicy: {},
  } as ConfigurationSnapshot['config']).contentHash;
}

function failMissingMigratedSnapshot(): never {
  throw new Error(
    'production startup requires an explicit migrated configuration snapshot',
  );
}
