import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

export interface StagedLegacyConfiguration {
  snapshot: ConfigurationSnapshot;
  planner: PlannerConfigurationView;
  kernel: KernelConfigurationView;
  plannerBinding: RevisionedAgentBinding;
  plannerBindingFingerprint: string;
}

export function buildStagedLegacyConfiguration(input: {
  env?: NodeJS.ProcessEnv;
  userHome?: string;
  testMode?: boolean;
} = {}): StagedLegacyConfiguration {
  const env = input.env ?? process.env;
  const testMode = input.testMode ?? env.NODE_ENV === 'test';
  const legacy = testMode
    ? {
        providerRef: 'test-provider',
        baseUrl: env.OPENAI_BASE_URL ?? 'http://127.0.0.1:1/v1',
        modelRef: 'test-model',
      }
    : readLegacyProviderAndModel(input.userHome ?? homedir(), env);
  const providerRef = testMode
    ? legacy.providerRef
    : normalizedLegacyReference('provider', legacy.providerRef);
  const modelRef = testMode
    ? legacy.modelRef
    : normalizedLegacyReference('model', legacy.modelRef);
  const config = AnyFusionConfigurationV2Schema.parse({
    schemaVersion: 2,
    providers: {
      [providerRef]: {
        protocol: 'openai-compatible',
        baseUrl: legacy.baseUrl,
        apiKeyRef: `keychain:anyfusion/imported/${providerRef}`,
        region: 'international',
        enabled: true,
      },
    },
    models: {
      [modelRef]: {
        providerRef,
        modelId: legacy.modelRef,
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
        primaryUseCases: ['repository implementation', 'tests', 'engineering documentation'],
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
  const compiled = compileConfigurationRevision('staged-legacy', config);
  const revisionId = testMode
    ? 'revision-test'
    : `import-${compiled.contentHash.slice(0, 24)}`;
  const snapshot = {
    revisionId,
    contentHash: compiled.contentHash,
    config,
  } satisfies ConfigurationSnapshot;
  const plannerBinding: RevisionedAgentBinding = {
    agentClassRef: 'planner',
    harnessRef: 'anyfusion-planner',
    providerRef,
    modelRef,
    permissionProfileRef: null,
    configurationRevision: revisionId,
  };
  const plannerFingerprintBinding = {
    ...plannerBinding,
    permissionProfileRef: 'planner-none',
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

function readLegacyProviderAndModel(
  userHome: string,
  env: NodeJS.ProcessEnv,
): {
  providerRef: string;
  baseUrl: string;
  modelRef: string;
} {
  const root = env.ANYFUSION_CONFIG_HOME?.trim()
    || join(userHome, '.config', 'anyfusion');
  const providerEnvironment = parseEnvironmentFile(
    readFileSync(join(root, 'provider.env'), 'utf8'),
  );
  const settings = JSON.parse(
    readFileSync(join(root, 'planner', 'settings.json'), 'utf8'),
  ) as Record<string, unknown>;
  const providerRef = nonEmpty(settings.defaultProvider, 'legacy Planner defaultProvider');
  const modelRef = nonEmpty(settings.defaultModel, 'legacy Planner defaultModel');
  const baseUrl = nonEmpty(
    env.OPENAI_BASE_URL ?? providerEnvironment.OPENAI_BASE_URL,
    'legacy Provider base URL',
  );
  return { providerRef, baseUrl, modelRef };
}

function parseEnvironmentFile(source: string): Record<string, string> {
  return Object.fromEntries(source
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
    .map(line => {
      const separator = line.indexOf('=');
      if (separator <= 0) throw new Error('legacy provider.env contains a malformed assignment');
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }));
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is missing`);
  }
  return value.trim();
}

function normalizedLegacyReference(kind: string, value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  const base = /^[a-z]/u.test(normalized)
    ? normalized
    : `${kind}-${normalized || 'legacy'}`;
  const digest = authorizedExecutorBindingFingerprint({
    agentClassRef: kind,
    harnessRef: kind,
    providerRef: kind,
    modelRef: value,
    permissionProfileRef: kind,
    configurationRevision: kind,
  }).slice(0, 8);
  return `${base.slice(0, 54).replace(/-+$/u, '')}-${digest}`;
}
