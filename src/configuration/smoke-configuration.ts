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
  const provider = await readExecutorProvider(configHome);
  const planner = await readPlannerProvider(configHome);
  const models = await readModels(configHome, planner, provider);
  const configuration = AnyFusionConfigurationV2Schema.parse(
    buildSmokeConfiguration({
      provider,
      planner,
      models,
      executorCommand: input.executorCommand,
      executorTimeoutSeconds: input.executorTimeoutSeconds,
      executorMaxDurationSeconds: input.executorMaxDurationSeconds,
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
  await secretStore.put('file-secret:anyfusion/providers/deepseek', provider.apiKey);
  await secretStore.put('file-secret:anyfusion/providers/kimi', planner.apiKey);
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
  executorMaxDurationSeconds: number;
}): AnyFusionConfigurationV2 {
  const executorHarness = input.executorCommand === 'pi'
    ? 'pi-cli'
    : 'codex-cli';
  const executorClass = input.executorCommand === 'pi'
    ? 'pi-agent'
    : 'codex-cli';
  const executorProfile = input.executorCommand === 'pi'
    ? 'public-web-research'
    : 'workspace-engineering';
  return {
    schemaVersion: 2,
    providers: {
      [input.planner.ref]: providerDefinition(input.planner),
      [input.provider.ref]: providerDefinition(input.provider),
    },
    models: {
      [input.models.planner.ref]: modelDefinition(input.models.planner, ['planning', 'structured-output', 'tools']),
      [input.models.executor.ref]: modelDefinition(input.models.executor, ['coding', 'structured-output', 'tools']),
      [`pi-${input.models.planner.modelId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')]:
        modelDefinition({
          ...input.models.planner,
          ref: `pi-${input.models.planner.modelId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        }, ['coding', 'planning', 'structured-output', 'tools']),
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
      planner: agentClass('planner', 'anyfusion-planner', input.models.planner.ref, undefined),
      'codex-cli': agentClass(
        'executor',
        'codex-cli',
        input.models.executor.ref,
        'workspace-engineering',
      ),
      'pi-agent': agentClass(
        'executor',
        'pi-cli',
        `pi-${input.models.planner.modelId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        'public-web-research',
      ),
      [executorClass]: agentClass(
        'executor',
        executorHarness,
        input.models.executor.ref,
        executorProfile,
      ),
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
      attemptTimeoutMs: Math.max(
        input.executorTimeoutSeconds,
        input.executorMaxDurationSeconds,
      ) * 1_000,
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
        : ['workspace-engineering'],
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

async function readExecutorProvider(configHome: string): Promise<ProviderInput> {
  const env = await readLegacyProviderEnvironment(configHome);
  const codex = await readFile(join(configHome, 'codex', 'config.toml'), 'utf8');
  const baseUrl = readTomlValue(codex, 'base_url') ?? env.OPENAI_BASE_URL;
  const modelId = readTomlValue(codex, 'model') ?? 'executor-model';
  const apiKey = env.OPENAI_API_KEY ?? '';
  if (!baseUrl || !apiKey) {
    throw new Error('Smoke configuration requires OPENAI_BASE_URL and OPENAI_API_KEY');
  }
  return { ref: 'deepseek', baseUrl: normalizeUrl(baseUrl), apiKey: apiKey.trim() };
}

async function readPlannerProvider(configHome: string): Promise<ProviderInput> {
  const models = JSON.parse(await readFile(join(configHome, 'planner', 'models.json'), 'utf8')) as {
    providers?: Record<string, { baseUrl?: string; apiKey?: string; models?: Array<{ id?: string }> }>;
  };
  const settings = JSON.parse(await readFile(join(configHome, 'planner', 'settings.json'), 'utf8')) as {
    defaultProvider?: string;
  };
  const ref = settings.defaultProvider ?? Object.keys(models.providers ?? {})[0];
  const provider = ref ? models.providers?.[ref] : undefined;
  if (!ref || !provider?.baseUrl || !provider.apiKey) {
    throw new Error('Smoke configuration requires a Planner provider with baseUrl and apiKey');
  }
  return { ref: 'kimi', baseUrl: normalizeUrl(provider.baseUrl), apiKey: provider.apiKey.trim() };
}

async function readModels(
  configHome: string,
  planner: ProviderInput,
  executor: ProviderInput,
): Promise<{ planner: ModelInput; executor: ModelInput }> {
  const plannerSettings = JSON.parse(await readFile(
    join(configHome, 'planner', 'settings.json'),
    'utf8',
  )) as { defaultModel?: string };
  const plannerModels = JSON.parse(await readFile(
    join(configHome, 'planner', 'models.json'),
    'utf8',
  )) as { providers?: Record<string, { models?: Array<{ id?: string }> }> };
  const plannerModelId = plannerSettings.defaultModel
    ?? plannerModels.providers?.kimi?.models?.[0]?.id
    ?? 'planner-model';
  const codex = await readFile(join(configHome, 'codex', 'config.toml'), 'utf8');
  const executorModelId = readTomlValue(codex, 'model') ?? 'executor-model';
  return {
    planner: {
      ref: `planner-${slug(plannerModelId)}`,
      providerRef: planner.ref,
      modelId: plannerModelId,
      reasoning: 'high',
    },
    executor: {
      ref: `codex-${slug(executorModelId)}`,
      providerRef: executor.ref,
      modelId: executorModelId,
      reasoning: 'high',
    },
  };
}

function readTomlValue(source: string, key: string): string | null {
  const match = new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'mu').exec(source);
  return match?.[1] ?? null;
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
