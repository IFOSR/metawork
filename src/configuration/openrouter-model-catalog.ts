import type { ModelCapability, ModelPricingMetadata } from './types.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const OPENROUTER_EXCHANGE_RATE = 7 as const;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

export interface OpenRouterModelMetadata {
  modelId: string;
  displayName?: string;
  description?: string;
  contextLimit?: number;
  capabilities: ModelCapability[];
  costInputPerMillion?: number;
  costOutputPerMillion?: number;
  publicFacts?: OpenRouterPublicFacts;
  pricing: ModelPricingMetadata;
}

export interface OpenRouterPublicFacts {
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  maxCompletionTokens?: number;
  reasoning?: {
    mandatory?: boolean;
    defaultEnabled?: boolean;
    supportedEfforts?: string[];
    defaultEffort?: string;
  };
  benchmarks?: Record<string, number>;
  knowledgeCutoff?: string;
  highlights: string[];
}

export interface OpenRouterCatalogSnapshot {
  status: 'ready' | 'unavailable';
  fetchedAt?: string;
  models: Record<string, OpenRouterModelMetadata>;
  error?: string;
}

export interface OpenRouterModelCandidate {
  model: OpenRouterModelMetadata;
  score: number;
  match: 'exact-id' | 'canonical-id' | 'display-name' | 'token-overlap';
}

export function matchOpenRouterModel(
  snapshot: OpenRouterCatalogSnapshot | undefined,
  modelId: string,
): OpenRouterModelMetadata | undefined {
  const candidates = rankOpenRouterModels(snapshot, modelId);
  const best = candidates[0];
  if (!best || best.score < 94) return undefined;
  const next = candidates[1];
  if (best.match === 'token-overlap' && next && best.score - next.score < 8) return undefined;
  return best.model;
}

/**
 * Ranks public OpenRouter models against a provider's local model ID. Provider
 * prefixes and common variant suffixes are ignored for canonical matching, so
 * `gpt-6-sol` can resolve to `openai/gpt-6-sol` without changing the ID used
 * by the actual provider connection.
 */
export function rankOpenRouterModels(
  snapshot: OpenRouterCatalogSnapshot | undefined,
  modelId: string,
): OpenRouterModelCandidate[] {
  if (!snapshot || !modelId.trim()) return [];
  const raw = modelId.trim();
  const normalized = normalizeModelKey(raw);
  const localCanonical = canonicalModelKey(raw);
  const localTokens = modelTokens(raw);
  return Object.values(snapshot.models)
    .map(model => scoreOpenRouterModel(model, normalized, localCanonical, localTokens))
    .filter((candidate): candidate is OpenRouterModelCandidate => candidate !== undefined)
    .sort((left, right) => right.score - left.score || left.model.modelId.localeCompare(right.model.modelId));
}

function scoreOpenRouterModel(
  model: OpenRouterModelMetadata,
  normalized: string,
  localCanonical: string,
  localTokens: string[],
): OpenRouterModelCandidate | undefined {
  const idKey = normalizeModelKey(model.modelId);
  const canonical = canonicalModelKey(model.modelId);
  const displayKey = normalizeModelKey(model.displayName ?? '');
  const candidateTokens = modelTokens(`${model.modelId} ${model.displayName ?? ''}`);
  if (idKey === normalized) return { model, score: 100, match: 'exact-id' };
  if (canonical === localCanonical) return { model, score: 96, match: 'canonical-id' };
  if (displayKey && displayKey === normalized) return { model, score: 94, match: 'display-name' };
  const localSet = new Set(localTokens);
  const overlap = [...new Set(candidateTokens)].filter(token => localSet.has(token)).length;
  if (overlap === 0) return undefined;
  const coverage = overlap / Math.max(1, localSet.size);
  const precision = overlap / Math.max(1, new Set(candidateTokens).size);
  const score = Math.round(52 + 30 * coverage + 12 * precision);
  return score >= 58 ? { model, score, match: 'token-overlap' } : undefined;
}

function normalizeModelKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, '-')
    .replace(/[^a-z0-9]+/gu, '-');
}

function canonicalModelKey(value: string): string {
  const segments = value.trim().toLowerCase().split('/');
  const last = segments.at(-1) ?? '';
  return normalizeModelKey(last.replace(/:(?:free|batch|nitro|exact)$/u, ''));
}

function modelTokens(value: string): string[] {
  return normalizeModelKey(value)
    .split('-')
    .filter(token => token.length > 1 && !['openai', 'anthropic', 'google', 'meta', 'mistral'].includes(token));
}

interface OpenRouterCatalogRow {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  context_length?: unknown;
  architecture?: unknown;
  pricing?: unknown;
  top_provider?: unknown;
  supported_parameters?: unknown;
  reasoning?: unknown;
  benchmarks?: unknown;
  knowledge_cutoff?: unknown;
}

export function parseOpenRouterCatalog(value: unknown, fetchedAt = new Date().toISOString()): OpenRouterCatalogSnapshot {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data)
      ? (value as { data: unknown[] }).data
      : [];
  const models: Record<string, OpenRouterModelMetadata> = {};
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const parsed = parseOpenRouterModel(row as OpenRouterCatalogRow, fetchedAt);
    if (parsed) models[parsed.modelId] = parsed;
  }
  return { status: 'ready', fetchedAt, models };
}

export function parseOpenRouterModel(
  row: OpenRouterCatalogRow,
  fetchedAt = new Date().toISOString(),
): OpenRouterModelMetadata | null {
  const modelId = stringValue(row.id);
  if (!modelId || modelId.length > 256) return null;
  const pricing = row.pricing && typeof row.pricing === 'object'
    ? row.pricing as Record<string, unknown>
    : {};
  const inputUsd = nonNegativeNumber(pricing.prompt);
  const outputUsd = nonNegativeNumber(pricing.completion);
  const contextLimit = positiveInteger(row.context_length);
  const architecture = row.architecture && typeof row.architecture === 'object'
    ? row.architecture as Record<string, unknown>
    : {};
  const modalities = Array.isArray(architecture.input_modalities)
    ? architecture.input_modalities.filter((item): item is string => typeof item === 'string')
    : [];
  const publicFacts = parsePublicFacts(row, architecture, contextLimit, stringValue(row.description));
  const capabilities = inferCapabilities({
    modelId,
    name: stringValue(row.name),
    description: stringValue(row.description),
    modalities,
    contextLimit,
    supportedParameters: stringArray(row.supported_parameters),
  });
  return {
    modelId,
    ...(stringValue(row.name) ? { displayName: stringValue(row.name) } : {}),
    ...(stringValue(row.description) ? { description: stringValue(row.description) } : {}),
    ...(contextLimit ? { contextLimit } : {}),
    capabilities,
    ...(inputUsd !== undefined ? { costInputPerMillion: usdPerTokenToCnyPerMillion(inputUsd) } : {}),
    ...(outputUsd !== undefined ? { costOutputPerMillion: usdPerTokenToCnyPerMillion(outputUsd) } : {}),
    ...(publicFacts ? { publicFacts } : {}),
    pricing: {
      source: 'openrouter',
      ...(inputUsd !== undefined ? { usdInputPerToken: inputUsd } : {}),
      ...(outputUsd !== undefined ? { usdOutputPerToken: outputUsd } : {}),
      exchangeRate: OPENROUTER_EXCHANGE_RATE,
      fetchedAt,
      catalogModelId: modelId,
    },
  };
}

function parsePublicFacts(
  row: OpenRouterCatalogRow,
  architecture: Record<string, unknown>,
  contextLimit: number | undefined,
  description: string | undefined,
): OpenRouterPublicFacts | undefined {
  const inputModalities = stringArray(architecture.input_modalities);
  const outputModalities = stringArray(architecture.output_modalities);
  const supportedParameters = stringArray(row.supported_parameters);
  const topProvider = row.top_provider && typeof row.top_provider === 'object'
    ? row.top_provider as Record<string, unknown> : {};
  const maxCompletionTokens = positiveInteger(topProvider.max_completion_tokens);
  const reasoning = row.reasoning && typeof row.reasoning === 'object'
    ? row.reasoning as Record<string, unknown> : undefined;
  const reasoningFacts = reasoning ? {
    ...(typeof reasoning.mandatory === 'boolean' ? { mandatory: reasoning.mandatory } : {}),
    ...(typeof reasoning.default_enabled === 'boolean' ? { defaultEnabled: reasoning.default_enabled } : {}),
    ...(stringArray(reasoning.supported_efforts).length > 0 ? { supportedEfforts: stringArray(reasoning.supported_efforts) } : {}),
    ...(typeof reasoning.default_effort === 'string' ? { defaultEffort: reasoning.default_effort } : {}),
  } : undefined;
  const rawBenchmarks = row.benchmarks && typeof row.benchmarks === 'object'
    ? row.benchmarks as Record<string, unknown> : {};
  const benchmarks = flattenNumericRecord(rawBenchmarks);
  const knowledgeCutoff = stringValue(row.knowledge_cutoff);
  const highlights = buildHighlights({
    description,
    inputModalities,
    outputModalities,
    supportedParameters,
    contextLimit,
    maxCompletionTokens,
    reasoning: reasoningFacts,
    benchmarks,
  });
  if (inputModalities.length === 0 && outputModalities.length === 0
    && supportedParameters.length === 0 && !maxCompletionTokens
    && !reasoningFacts && Object.keys(benchmarks).length === 0 && !knowledgeCutoff
    && highlights.length === 0) return undefined;
  return {
    inputModalities,
    outputModalities,
    supportedParameters,
    ...(maxCompletionTokens ? { maxCompletionTokens } : {}),
    ...(reasoningFacts && Object.keys(reasoningFacts).length > 0 ? { reasoning: reasoningFacts } : {}),
    ...(Object.keys(benchmarks).length > 0 ? { benchmarks } : {}),
    ...(knowledgeCutoff ? { knowledgeCutoff } : {}),
    highlights,
  };
}

function buildHighlights(input: {
  description?: string;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  contextLimit?: number;
  maxCompletionTokens?: number;
  reasoning?: OpenRouterPublicFacts['reasoning'];
  benchmarks: Record<string, number>;
}): string[] {
  const highlights: string[] = [];
  const description = input.description?.replace(/\.\.\.$/u, '').trim();
  if (description) {
    const clauses = description.split(/(?<=[.!?])\s+/u).filter(Boolean);
    highlights.push(...clauses.slice(0, 3));
  }
  if (input.contextLimit && input.contextLimit >= 200_000) highlights.push('支持超长上下文，适合处理大型资料与长流程任务');
  if (input.inputModalities.includes('image')) highlights.push('支持图片输入');
  if (input.inputModalities.includes('file')) highlights.push('支持文件输入');
  if (input.supportedParameters.includes('tools')) highlights.push('支持工具调用');
  if (input.supportedParameters.includes('structured_outputs') || input.supportedParameters.includes('response_format')) {
    highlights.push('支持结构化输出');
  }
  if (input.reasoning?.mandatory || input.reasoning?.defaultEnabled) highlights.push('支持推理模式，可调节推理强度');
  if (input.maxCompletionTokens) highlights.push(`最大输出约 ${(input.maxCompletionTokens / 1000).toLocaleString()}K tokens`);
  return [...new Set(highlights)].slice(0, 8);
}

function flattenNumericRecord(value: Record<string, unknown>): Record<string, number> {
  const output: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'number' && Number.isFinite(item)) output[key] = item;
    else if (item && typeof item === 'object') {
      for (const [nestedKey, nested] of Object.entries(item as Record<string, unknown>)) {
        if (typeof nested === 'number' && Number.isFinite(nested)) output[`${key}.${nestedKey}`] = nested;
      }
    }
  }
  return output;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

export function usdPerTokenToCnyPerMillion(value: number): number {
  return value * 1_000_000 * OPENROUTER_EXCHANGE_RATE;
}

export class OpenRouterModelCatalog {
  private snapshot: OpenRouterCatalogSnapshot | undefined;
  private inFlight: Promise<OpenRouterCatalogSnapshot> | undefined;
  private cacheLoaded = false;

  constructor(private readonly options: {
    fetchImpl?: typeof fetch;
    now?: () => number;
    cacheTtlMs?: number;
    cachePath?: string;
  } = {}) {}

  async getSnapshot(options: { forceRefresh?: boolean } = {}): Promise<OpenRouterCatalogSnapshot> {
    await this.loadDiskCache();
    const now = this.options.now?.() ?? Date.now();
    const fetchedAtMs = this.snapshot?.fetchedAt ? Date.parse(this.snapshot.fetchedAt) : NaN;
    const ttl = this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    if (!options.forceRefresh && this.snapshot && Number.isFinite(fetchedAtMs) && now - fetchedAtMs < ttl) {
      return this.snapshot;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchSnapshot().finally(() => { this.inFlight = undefined; });
    const result = await this.inFlight;
    if (result.status === 'ready') {
      this.snapshot = result;
      await this.persistDiskCache(result);
    } else if (!this.snapshot) {
      this.snapshot = result;
    }
    return this.snapshot ?? result;
  }

  private async loadDiskCache(): Promise<void> {
    if (this.cacheLoaded) return;
    this.cacheLoaded = true;
    const cachePath = this.options.cachePath;
    if (!cachePath || this.snapshot) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(cachePath, 'utf8'));
      if (parsed && typeof parsed === 'object'
        && (parsed as { status?: unknown }).status === 'ready'
        && (parsed as { models?: unknown }).models
        && typeof (parsed as { models?: unknown }).models === 'object') {
        this.snapshot = parsed as OpenRouterCatalogSnapshot;
      }
    } catch {
      // A missing or corrupt metadata cache is equivalent to no cache.
    }
  }

  private async persistDiskCache(snapshot: OpenRouterCatalogSnapshot): Promise<void> {
    const cachePath = this.options.cachePath;
    if (!cachePath) return;
    try {
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    } catch {
      // Metadata caching is best effort and never blocks settings activation.
    }
  }

  private async fetchSnapshot(): Promise<OpenRouterCatalogSnapshot> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await (this.options.fetchImpl ?? fetch)(OPENROUTER_MODELS_URL, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        return { status: 'unavailable', models: {}, error: `OpenRouter returned HTTP ${response.status}` };
      }
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        return { status: 'unavailable', models: {}, error: 'OpenRouter response exceeds the size limit' };
      }
      const body = await response.text();
      if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
        return { status: 'unavailable', models: {}, error: 'OpenRouter response exceeds the size limit' };
      }
      return parseOpenRouterCatalog(JSON.parse(body));
    } catch (error) {
      return {
        status: 'unavailable',
        models: {},
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function inferCapabilities(input: {
  modelId: string;
  name?: string;
  description?: string;
  modalities: string[];
  contextLimit?: number;
  supportedParameters: string[];
}): ModelCapability[] {
  const text = `${input.modelId} ${input.name ?? ''} ${input.description ?? ''}`.toLowerCase();
  const capabilities = new Set<ModelCapability>(['tools', 'structured-output']);
  if (input.modalities.some(modality => ['image', 'file'].includes(modality.toLowerCase()))) capabilities.add('vision');
  if (/vision|image|multimodal|vl\b/u.test(text)) capabilities.add('vision');
  if (/reason|thinking|r1\b|planner|planning|analysis|research|long[- ]horizon/u.test(text)
    || input.supportedParameters.some(parameter => parameter === 'reasoning' || parameter === 'reasoning_effort')) {
    capabilities.add('planning');
  }
  if (/code|coder|coding|dev|software[ -]engineering|software[ -]development/u.test(text)) capabilities.add('coding');
  if ((input.contextLimit ?? 0) >= 200_000 || /long.?context|context.?window|long[- ]horizon|1m|million/u.test(text)) {
    capabilities.add('long-context');
  }
  return [...capabilities].sort();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 1_024 ? numeric : undefined;
}
