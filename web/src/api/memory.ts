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
}

export interface MemoryStatusView {
  enabled: boolean;
  mode: 'disabled' | 'needs-model' | 'enabled' | 'degraded';
  detail?: string;
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

export interface MemoryApiClient {
  status(): Promise<MemoryStatusView>;
  listAssets(): Promise<{ items: MemoryAssetView[]; total: number }>;
  setAssetEnabled(memoryId: string, enabled: boolean): Promise<unknown>;
  deleteAsset(memoryId: string): Promise<unknown>;
}

export function createMemoryApiClient(request: (path: string, init?: RequestInit) => Promise<unknown>): MemoryApiClient {
  return {
    status: () => request('/api/memory/status') as Promise<MemoryStatusView>,
    listAssets: () => request('/api/memory/assets') as Promise<{ items: MemoryAssetView[]; total: number }>,
    setAssetEnabled: (memoryId, enabled) => request('/api/memory/assets/enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoryId, enabled }),
    }),
    deleteAsset: (memoryId) => request(`/api/memory/assets/${encodeURIComponent(memoryId)}`, { method: 'DELETE' }),
  };
}
