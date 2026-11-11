import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { compileConfigurationRevision } from './configuration-service.js';
import { FileConfigurationRepository } from './file-configuration-repository.js';
import { FileSecretStore } from './file-secret-store.js';
import { AgentRuntimeRenderer } from './agent-runtime-renderer.js';
import { readLegacyProviderEnvironment } from './legacy-configuration-reader.js';
import { AnyFusionConfigurationV2Schema } from './schema.js';
import type { AnyFusionConfigurationV2, ModelProfile } from './types.js';
import { resolveAccountPaths } from '../account/account-paths.js';
import { LOCAL_DEFAULT_ACCOUNT_ID } from '../account/account-id.js';

interface ProviderInput {
  readonly ref: string;
  readonly baseUrl: string;
  readonly apiKey: string;
}

interface ModelInput {
  readonly ref: string;
  readonly providerRef: string;
  readonly modelId: string;
  readonly reasoning: 'low' | 'medium' | 'high';
}

export interface PrepareSmokeConfigurationInput {
  readonly installRoot: string;
  readonly configHome: string;
  readonly executorCommand: string;
  readonly executorTimeoutSeconds: number;
  readonly executorMaxDurationSeconds: number;
}

export async function prepareSmokeConfiguration(
  input: PrepareSmokeConfigurationInput,
): Promise<{ revisionId: string }> {
  const configHome = resolve(input.configHome);
  if (input.executorCommand !== 'pi') {
    throw new Error('Native smoke supports only the packaged Pi Executor');
  }
  const env = await readLegacyProviderEnvironment(configHome);
  const plannerSource = await readPiConfiguration(join(configHome, 'planner'), 'manager', env);
  const executorSource = await readPiConfiguration(join(configHome, 'pi-home', '.pi', 'agent'), 'executor', env);
  const provider = executorSource.provider;
  const planner = plannerSource.provider;
  const models = { planner: plannerSource.model, executor: executorSource.model };
  const configuration = AnyFusionConfigurationV2Schema.parse(
    buildSmokeConfiguration({
      provider,
      planner,
      models,
      executorCommand: input.executorCommand,
      executorTimeoutSeconds: input.executorTimeoutSeconds,
    }),
  );
  const compiled = compileConfigurationRevision(
    `smoke-${createHash('sha256').update(JSON.stringify(configuration)).digest('hex').slice(0, 24)}`,
    configuration,
  );
  const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, input.installRoot);
  const repository = new FileConfigurationRepository(accountPaths.config);
  await repository.initialize();
  const secretStore = new FileSecretStore(accountPaths.secrets);
  await secretStore.initialize();
  await secretStore.put(`file-secret:anyfusion/providers/${provider.ref}`, provider.apiKey);
  await secretStore.put(`file-secret:anyfusion/providers/${planner.ref}`, planner.apiKey);
  await repository.writeRevision({
    revisionId: compiledRevisionId(compiled, configuration),
    contentHash: compiled.contentHash,
    files: compiled.files,
  });
  const revisionId = compiledRevisionId(compiled, configuration);
  const snapshot = await repository.readSnapshot(revisionId);
  await new AgentRuntimeRenderer(resolve(accountPaths.generated, 'agent-runtime'))
    .render(snapshot);
  await repository.activateRevision(revisionId, null, 'smoke-activation');
  return { revisionId };
}

function buildSmokeConfiguration(input: {
  provider: ProviderInput;
  planner: ProviderInput;
  models: { planner: ModelInput; executor: ModelInput };
  executorCommand: string;
  executorTimeoutSeconds: number;
}): AnyFusionConfigurationV2 {
  return {
    schemaVersion: 2,
    providers: {
      [input.planner.ref]: providerDefinition(input.planner),
      [input.provider.ref]: providerDefinition(input.provider),
    },
    models: {
      [input.models.planner.ref]: modelDefinition(input.models.planner, ['planning', 'structured-output', 'tools']),
      [input.models.executor.ref]: modelDefinition(input.models.executor, ['coding', 'structured-output', 'tools']),
    },
    harnesses: {
      'anyfusion-planner': {
        kind: 'planner',
        transport: 'local-process',
        commandRef: 'release:pi',
        args: [],
        driverId: 'anyfusion-planner-host-v2',
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
      planner: agentClass('planner', 'anyfusion-planner', input.models.planner.ref, undefined),
      'pi-engineering': agentClass('executor', 'pi-cli', input.models.executor.ref, 'workspace-engineering'),
      'pi-research': agentClass('executor', 'pi-cli', input.models.executor.ref, 'public-web-research'),
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
    runtimePolicy: {
      executorIdleTimeoutMs: input.executorTimeoutSeconds * 1_000,
    },
    gateway: {},
  };
}

function agentClass(
  kind: 'planner' | 'executor',
  harnessRef: string,
  modelRef: string,
  permissionProfileRef: string | undefined,
): AnyFusionConfigurationV2['agentClasses'][string] {
  return {
    kind,
    harnessRef,
    modelPolicy: { mode: 'fixed', modelRef },
    ...(permissionProfileRef ? { permissionProfileRef } : {}),
    routingCapabilities: kind === 'planner'
      ? []
      : permissionProfileRef === 'public-web-research'
        ? ['current-web-research']
        : ['workspace-engineering', 'document-processing'],
    primaryUseCases: kind === 'planner'
      ? []
      : permissionProfileRef === 'public-web-research'
        ? ['current public-web research', 'source verification']
        : ['repository implementation', 'tests', 'engineering documentation', 'image generation', 'image editing'],
    avoidUseCases: [],
    plannerAffordances: kind === 'planner'
      ? []
      : permissionProfileRef === 'public-web-research'
        ? ['public-web-search', 'public-web-fetch', 'source-citation']
        : ['workspace-read-write', 'workspace-command-validation'],
    skills: kind === 'planner' ? ['metaclaw-planner'] : [],
    mcpServers: kind === 'planner' ? ['metaclaw-planner'] : [],
    plugins: [],
    generatedRuntimeRef: harnessRef,
    enabled: true,
  };
}

function providerDefinition(input: ProviderInput): AnyFusionConfigurationV2['providers'][string] {
  return {
    protocol: 'openai-compatible',
    baseUrl: input.baseUrl,
    apiKeyRef: `file-secret:anyfusion/providers/${input.ref}`,
    region: 'international',
    enabled: true,
  };
}

function modelDefinition(input: ModelInput, capabilities: ModelProfile['capabilities']): ModelProfile {
  return {
    providerRef: input.providerRef,
    modelId: input.modelId,
    capabilities,
    reasoning: input.reasoning,
    enabled: true,
  };
}

async function readPiConfiguration(
  home: string,
  role: 'manager' | 'executor',
  env: Record<string, string>,
): Promise<{ provider: ProviderInput; model: ModelInput }> {
  const catalog = JSON.parse(await readFile(join(home, 'models.json'), 'utf8')) as {
    providers?: Record<string, { baseUrl?: string; apiKey?: string; models?: Array<{ id?: string }> }>;
  };
  const settings = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8')) as {
    defaultProvider?: string; defaultModel?: string;
  };
  const selected = settings.defaultProvider;
  const entry = selected ? catalog.providers?.[selected] : undefined;
  const modelId = settings.defaultModel;
  const apiKey = entry?.apiKey ? env[entry.apiKey] ?? entry.apiKey : undefined;
  if (!entry?.baseUrl || !apiKey?.trim() || !modelId
    || !entry.models?.some(model => model.id === modelId)) {
    throw new Error(`Smoke configuration requires a selected ${role} Pi provider/model with baseUrl and apiKey`);
  }
  const providerRef = `smoke-${role}`;
  return {
    provider: { ref: providerRef, baseUrl: normalizeUrl(entry.baseUrl), apiKey: apiKey.trim() },
    model: { ref: `${role}-${slug(modelId)}`, providerRef, modelId, reasoning: 'high' },
  };
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/u, '');
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/gu, '-').replace(/-+/gu, '-').replace(/^-|-$/gu, '');
}

function compiledRevisionId(
  compiled: { contentHash: string },
  _configuration: AnyFusionConfigurationV2,
): string {
  return `smoke-${compiled.contentHash.slice(0, 24)}`;
}
