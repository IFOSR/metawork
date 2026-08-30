export type ProviderModelDiscoveryResult =
  | { status: 'discovered'; modelIds: string[] }
  | { status: 'unavailable'; modelIds: [] };

interface ProviderDefinition {
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
  modelIds: string[];
}

const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_MODEL_COUNT = 512;
const MAX_MODEL_ID_LENGTH = 256;

export async function discoverOpenAiCompatibleModels(input: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ProviderModelDiscoveryResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 8_000);
  try {
    const response = await (input.fetchImpl ?? fetch)(
      `${input.baseUrl.replace(/\/+$/u, '')}/models`,
      {
        headers: { Authorization: `Bearer ${input.apiKey}` },
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
        baseUrl: provider.baseUrl,
        apiKey,
        fetchImpl: input.fetchImpl,
      })
      : { status: 'unavailable' as const, modelIds: [] };
    return {
      providerRef,
      baseUrl: provider.baseUrl,
      credentialAvailable: apiKey.length > 0,
      modelIds: [...new Set([...configuredModelIds, ...discovery.modelIds])]
        .sort((left, right) => left.localeCompare(right)),
    };
  }));
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
