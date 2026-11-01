/**
 * Client for the long-term memory management view.
 *
 * The browser never sees an engine credential: the Gateway holds the account
 * scoped key and injects it into the engine request (design §9).
 */

export interface MemoryAssetView {
  memoryId: string;
  tdaiMemoryId: string;
  type: string;
  preview: string;
  source: string;
  workspaceId: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  layer: 'l1' | 'l2' | 'l3';
  title: string;
}

export interface MemoryAssetListView {
  items: MemoryAssetView[];
  total: number;
  unfilteredTotal?: number;
  mode: 'disabled' | 'needs-model' | 'enabled' | 'degraded';
  degraded: boolean;
  degradedReason?: string;
}

/**
 * Why memory cannot serve the user. "Engine not installed" and "engine without
 * FTS5" are different failures and must not share one message.
 */
export type MemoryEngineProblem =
  | 'extraction_model_required'
  | 'extraction_credential_missing'
  | 'engine_missing'
  | 'engine_unreachable'
  | 'engine_unhealthy'
  | 'fts5_unavailable';

export interface MemoryStatusView {
  enabled: boolean;
  mode: 'disabled' | 'needs-model' | 'enabled' | 'degraded';
  detail?: string;
  engineProblem?: MemoryEngineProblem;
  providerRef: string | null;
  modelRef: string | null;
  engineReady: boolean;
  ftsAvailable: boolean;
  modelName: string | null;
  modelPricing: { costInputPerMillion?: number; costOutputPerMillion?: number } | null;
  selectableProviders: Array<{
    providerRef: string;
    displayName: string;
    baseUrl: string;
    unsupportedReason?: string;
    models: Array<{
      modelRef: string;
      modelId: string;
      displayName: string;
      supportsStructuredOutput: boolean;
      enabled: boolean;
      costInputPerMillion?: number;
      costOutputPerMillion?: number;
    }>;
  }>;
}

export interface MemoryAssetQuery {
  limit: number;
  offset: number;
  query?: string;
  type?: string;
  layer?: 'l1' | 'l2' | 'l3';
  enabled?: boolean;
}

export interface MemoryAssetDetail extends MemoryAssetView { content: string }

export interface MemoryApiClient {
  status(signal?: AbortSignal): Promise<MemoryStatusView>;
  listAssets(input?: MemoryAssetQuery, signal?: AbortSignal): Promise<MemoryAssetListView>;
  getAsset(memoryId: string, signal?: AbortSignal): Promise<MemoryAssetDetail>;
  setAssetEnabled(memoryId: string, enabled: boolean): Promise<unknown>;
  deleteAsset(memoryId: string): Promise<unknown>;
}

/**
 * What the settings panel should render for the asset list.
 *
 * A degraded engine has no trustworthy asset list: rendering "no assets yet"
 * would present an outage as an empty account.
 */
export function memoryAssetViewState(view: MemoryAssetListView | null):
  | { kind: 'loading' }
  | { kind: 'degraded'; reason: string }
  | { kind: 'empty' }
  | { kind: 'list'; items: MemoryAssetListView['items'] } {
  if (!view) return { kind: 'loading' };
  if (view.degraded) {
    return { kind: 'degraded', reason: view.degradedReason ?? 'memory_engine_unavailable' };
  }
  if (view.items.length === 0) return { kind: 'empty' };
  return { kind: 'list', items: view.items };
}

export function createMemoryApiClient(request: (path: string, init?: RequestInit) => Promise<unknown>): MemoryApiClient {
  return {
    status: signal => request('/api/memory/status', signal ? { signal } : undefined) as Promise<MemoryStatusView>,
    listAssets: (input = { limit: 50, offset: 0 }, signal) => {
      const params = new URLSearchParams({ limit: String(input.limit), offset: String(input.offset) });
      if (input.query) params.set('q', input.query);
      if (input.type) params.set('type', input.type);
      if (input.layer) params.set('layer', input.layer);
      if (input.enabled !== undefined) params.set('enabled', String(input.enabled));
      return request(`/api/memory/assets?${params}`, signal ? { signal } : undefined) as Promise<MemoryAssetListView>;
    },
    getAsset: (memoryId, signal) => request(`/api/memory/assets/${encodeURIComponent(memoryId)}`,
      signal ? { signal } : undefined) as Promise<MemoryAssetDetail>,
    setAssetEnabled: (memoryId, enabled) => request('/api/memory/assets/enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoryId, enabled }),
    }),
    deleteAsset: (memoryId) => request(`/api/memory/assets/${encodeURIComponent(memoryId)}`, { method: 'DELETE' }),
  };
}
