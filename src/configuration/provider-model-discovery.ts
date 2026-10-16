import { createHash } from 'node:crypto';
import type { ProviderProtocol } from './types.js';

export type ProviderModelDiscoveryResult =
  | { status: 'discovered'; modelIds: string[] }
  | { status: 'unavailable'; modelIds: [] };

interface ProviderDefinition {
  protocol?: ProviderProtocol;
  baseUrl: string;
  apiKeyRef: string;
}

interface ModelDefinition {
  providerRef: string;
  modelId: string;
}

export interface ProviderCompletionCatalogEntry {
  providerRef: string;
  baseUrl: string;
  credentialAvailable: boolean;
  /** One-way identity used to merge duplicate Provider entries in the UI. */
  credentialFingerprint?: string;
  modelIds: string[];
}

const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_MODEL_COUNT = 512;
const MAX_MODEL_ID_LENGTH = 256;

export function providerModelListRequest(baseUrl: string, apiKey: string, protocol?: ProviderProtocol): { url: string; headers: Record<string, string> } {
  const base = baseUrl.replace(/\/+$/u, '');
  return protocol === 'anthropic'
    ? { url: `${base}/v1/models`, headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } }
    : { url: `${base}/models`, headers: { Authorization: `Bearer ${apiKey}` } };
}

export async function discoverOpenAiCompatibleModels(input: {
  protocol?: ProviderProtocol;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ProviderModelDiscoveryResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 8_000);
  try {
    const request = providerModelListRequest(input.baseUrl, input.apiKey, input.protocol);
    const response = await (input.fetchImpl ?? fetch)(
      request.url,
      {
        headers: request.headers,
        signal: controller.signal,
      },
    );
    if (!response.ok) return { status: 'unavailable', modelIds: [] };
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      return { status: 'unavailable', modelIds: [] };
    }
    const source = await response.text();
    if (Buffer.byteLength(source, 'utf8') > MAX_RESPONSE_BYTES) {
      return { status: 'unavailable', modelIds: [] };
    }
    const parsed = JSON.parse(source) as unknown;
    const rows = modelRows(parsed);
    const modelIds = [...new Set(rows
      .map(modelIdFromRow)
      .filter((value): value is string => value !== null))]
      .sort((left, right) => left.localeCompare(right))
      .slice(0, MAX_MODEL_COUNT);
    return modelIds.length > 0
      ? { status: 'discovered', modelIds }
      : { status: 'unavailable', modelIds: [] };
  } catch {
    return { status: 'unavailable', modelIds: [] };
  } finally {
    clearTimeout(timer);
  }
}

export async function buildProviderCompletionCatalog(input: {
  providers: Record<string, ProviderDefinition>;
  models: Record<string, ModelDefinition>;
  readSecret(reference: string): Promise<string>;
  fetchImpl?: typeof fetch;
}): Promise<ProviderCompletionCatalogEntry[]> {
  return Promise.all(Object.entries(input.providers).map(async ([providerRef, provider]) => {
    const configuredModelIds = Object.values(input.models)
      .filter(model => model.providerRef === providerRef)
      .map(model => model.modelId);
    let apiKey = '';
    try {
      apiKey = (await input.readSecret(provider.apiKeyRef)).trim();
    } catch {
      apiKey = '';
    }
    const discovery = apiKey
      ? await discoverOpenAiCompatibleModels({
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        apiKey,
        fetchImpl: input.fetchImpl,
      })
      : { status: 'unavailable' as const, modelIds: [] };
    return {
      providerRef,
      baseUrl: provider.baseUrl,
      credentialAvailable: apiKey.length > 0,
      ...(apiKey ? { credentialFingerprint: fingerprintProviderCredential(apiKey) } : {}),
      modelIds: [...new Set([...configuredModelIds, ...discovery.modelIds])]
        .sort((left, right) => left.localeCompare(right)),
    };
  }));
}

export function fingerprintProviderCredential(apiKey: string): string | undefined {
  const normalized = apiKey.trim();
  if (!normalized) return undefined;
  return `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}

function modelRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.data)) return record.data;
  if (Array.isArray(record.models)) return record.models;
  return [];
}

function modelIdFromRow(value: unknown): string | null {
  const candidate = typeof value === 'string'
    ? value
    : value && typeof value === 'object'
      ? (value as Record<string, unknown>).id
        ?? (value as Record<string, unknown>).model
        ?? (value as Record<string, unknown>).name
      : null;
  if (typeof candidate !== 'string') return null;
  const normalized = candidate.trim();
  return normalized.length > 0 && normalized.length <= MAX_MODEL_ID_LENGTH
    ? normalized
    : null;
}
