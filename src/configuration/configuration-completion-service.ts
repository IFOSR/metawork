import { publicProviderDisplayName } from './public-provider-catalog.js';

export type CompletionFieldState =
  | '已自动发现'
  | '已从 Provider 补全'
  | '已从本机 Agent 导入'
  | '需要确认'
  | '缺失';

export interface ConfigurationCompletionProviderSource {
  providerRef: string;
  baseUrl?: string;
  credentialAvailable?: boolean;
  modelIds?: string[];
}

export interface ConfigurationCompletionPreset {
  providerRef: string;
  displayName?: string;
  baseUrl: string;
  modelIds: string[];
}

export interface ConfigurationCompletionModel {
  providerRef: string;
  modelId: string;
  capabilities: string[];
  capabilityState: CompletionFieldState;
  contextLimit?: number;
  costInputPerMillion?: number;
  costOutputPerMillion?: number;
  latencyTier?: string;
  qualityTier?: string;
}

export interface ConfigurationCompletionResult {
  providers: Record<string, {
    displayName: string;
    baseUrl: string | null;
    credentialState: CompletionFieldState;
    modelIds: string[];
  }>;
  providerPresets: Array<{
    providerRef: string;
    displayName: string;
    baseUrl: string;
    modelIds: string[];
  }>;
  models: Record<string, ConfigurationCompletionModel>;
  requiredFields: string[];
}

export interface ConfigurationCompletionInput {
  providers?: Record<string, Record<string, unknown>>;
  models?: Record<string, Record<string, unknown>>;
  agentClasses?: Record<string, Record<string, unknown>>;
}

/**
 * Completes only safe, structural configuration facts. It does not read
 * arbitrary files and never returns credential material.
 */
export class ConfigurationCompletionService {
  constructor(private readonly deps: {
    localProviders?: readonly ConfigurationCompletionProviderSource[];
    presets?: readonly ConfigurationCompletionPreset[];
    providerCatalog?: readonly ConfigurationCompletionProviderSource[];
    modelCapabilities?: Readonly<Record<string, readonly string[]>>;
  } = {}) {}

  complete(input: ConfigurationCompletionInput): ConfigurationCompletionResult {
    const providers: ConfigurationCompletionResult['providers'] = {};
    const models: ConfigurationCompletionResult['models'] = {};
    const requiredFields: string[] = [];
    const local = new Map((this.deps.localProviders ?? []).map(item => [item.providerRef, item]));
    const catalog = new Map((this.deps.providerCatalog ?? []).map(item => [item.providerRef, item]));
    const presets = new Map((this.deps.presets ?? []).map(item => [item.providerRef, item]));

    const providerRefs = new Set([
      ...Object.keys(input.providers ?? {}),
      ...local.keys(),
      ...catalog.keys(),
      ...presets.keys(),
    ]);
    for (const providerRef of [...providerRefs].sort()) {
      const configured = input.providers?.[providerRef] ?? {};
      const localProvider = local.get(providerRef);
      const providerCatalog = catalog.get(providerRef);
      const preset = presets.get(providerRef);
      const baseUrl = text(configured.baseUrl)
        ?? localProvider?.baseUrl
        ?? providerCatalog?.baseUrl
        ?? preset?.baseUrl
        ?? null;
      const credentialAvailable = configured.credentialAvailable === true
        || localProvider?.credentialAvailable === true;
      const credentialState: CompletionFieldState = configured.credentialAvailable === true
        ? '已自动发现'
        : localProvider?.credentialAvailable === true
          ? '已从本机 Agent 导入'
          : providerCatalog?.credentialAvailable === true
            ? '已从 Provider 补全'
            : '缺失';
      providers[providerRef] = {
        displayName: preset?.displayName ?? publicProviderDisplayName(providerRef, baseUrl ?? undefined),
        baseUrl,
        credentialState,
        modelIds: unique([
          ...listOfStrings(configured.modelIds),
          ...(localProvider?.modelIds ?? []),
          ...(providerCatalog?.modelIds ?? []),
          ...(preset?.modelIds ?? []),
        ]),
      };
      if (!credentialAvailable) requiredFields.push(`providers.${providerRef}.credential`);
      if (!baseUrl) requiredFields.push(`providers.${providerRef}.baseUrl`);
    }

    for (const [modelRef, configured] of Object.entries(input.models ?? {}).sort()) {
      const providerRef = text(configured.providerRef) ?? '';
      const modelId = text(configured.modelId) ?? modelRef;
      const explicitCapabilities = listOfStrings(configured.capabilities);
      const providerModels = providers[providerRef]?.modelIds ?? [];
      const inferredModelId = providerModels.includes(modelId)
        ? modelId
        : undefined;
      const catalogCapabilities = (this.deps.modelCapabilities?.[modelId] ?? [])
        .filter((value): value is string => Boolean(value));
      const capabilities = explicitCapabilities.length > 0
        ? explicitCapabilities
        : [...catalogCapabilities];
      const hasResolvedCapabilities = capabilities.length > 0;
      models[modelRef] = {
        providerRef,
        modelId,
        capabilities,
        capabilityState: hasResolvedCapabilities
          ? (inferredModelId ? '已从 Provider 补全' : '已自动发现')
          : '需要确认',
        ...(numberValue(configured.contextLimit) !== undefined
          ? { contextLimit: numberValue(configured.contextLimit) }
          : {}),
        ...(numberValue(configured.costInputPerMillion) !== undefined
          ? { costInputPerMillion: numberValue(configured.costInputPerMillion) }
          : {}),
        ...(numberValue(configured.costOutputPerMillion) !== undefined
          ? { costOutputPerMillion: numberValue(configured.costOutputPerMillion) }
          : {}),
        ...(text(configured.latencyTier) ? { latencyTier: text(configured.latencyTier)! } : {}),
        ...(text(configured.qualityTier) ? { qualityTier: text(configured.qualityTier)! } : {}),
      };
      if (!hasResolvedCapabilities) requiredFields.push(`models.${modelRef}.capabilities`);
    }

    return {
      providers,
      providerPresets: [...presets.values()]
        .map(preset => ({
          providerRef: preset.providerRef,
          displayName: preset.displayName
            ?? publicProviderDisplayName(preset.providerRef, preset.baseUrl),
          baseUrl: preset.baseUrl,
          modelIds: unique(preset.modelIds),
        }))
        .sort((left, right) => left.providerRef.localeCompare(right.providerRef)),
      models,
      requiredFields: [...new Set(requiredFields)].sort(),
    };
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function listOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? unique(value.filter((item): item is string => (
      typeof item === 'string' && Boolean(item.trim())
    )).map(item => item.trim()))
    : [];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
