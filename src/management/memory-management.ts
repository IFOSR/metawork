/**
 * Management view of the long-term memory capability.
 *
 * The management plane is a thin view over MetaWork's own state plus the
 * memory engine's asset list (design §9). Identity and login stay with
 * MetaWork's account system (ADR-0031); the frontend never sees an engine
 * credential.
 */

import type { MemoryRuntime } from '../memory/memory-runtime.js';
import type { MemoryAssetSummary } from '../memory/memory-types.js';

export interface MemoryStatusView {
  /** The product switch. */
  enabled: boolean;
  /** `disabled`, `needs-model` or `enabled`. */
  mode: 'disabled' | 'needs-model' | 'enabled' | 'degraded';
  detail?: string;
  providerRef: string | null;
  modelRef: string | null;
  engineReady: boolean;
  ftsAvailable: boolean;
  /** Extraction Model display name, resolved from the configuration. */
  modelName: string | null;
  /** Extraction Model price, so the user sees whose quota is spent. */
  modelPricing: {
    costInputPerMillion?: number;
    costOutputPerMillion?: number;
  } | null;
  /** Providers that can be used for extraction, with their models. */
  selectableProviders: Array<{
    providerRef: string;
    displayName: string;
    baseUrl: string;
    models: Array<{
      modelRef: string;
      modelId: string;
      displayName: string;
      supportsStructuredOutput: boolean;
      enabled: boolean;
      costInputPerMillion?: number;
      costOutputPerMillion?: number;
    }>;
    /** Why this provider cannot be used, when it cannot. */
    unsupportedReason?: string;
  }>;
}

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

export interface MemoryAssetListView {
  items: MemoryAssetView[];
  total: number;
  /** Runtime mode that produced this list. */
  mode: MemoryStatusView['mode'];
  /** True when the engine is unavailable, so an empty list is not "no assets". */
  degraded: boolean;
  degradedReason?: string;
}

export interface MemoryManagementQuery {
  status(): Promise<MemoryStatusView>;
  listAssets(input: { limit: number; offset: number }): Promise<MemoryAssetListView>;
  setEnabled(input: { memoryId: string; enabled: boolean }): Promise<MemoryAssetSummary | null>;
  deleteAsset(input: { memoryId: string }): Promise<boolean>;
}

export interface MemoryManagementOptions {
  /**
   * Resolves the live runtime. A getter keeps the management view correct
   * across configuration activations, which rebuild the runtime (review P1-1).
   */
  resolveRuntime: () => MemoryRuntime | null;
  accountId: string;
  /** Resolves the current configuration for the selectable provider list. */
  readConfiguration(): Promise<{
    providers: Record<string, { protocol: string; baseUrl: string; enabled: boolean; displayName?: string }>;
    models: Record<string, {
      providerRef: string;
      modelId: string;
      description?: string;
      capabilities: readonly string[];
      enabled: boolean;
      costInputPerMillion?: number;
      costOutputPerMillion?: number;
    }>;
  }>;
}

/** Build the management view over the memory runtime. */
export function createMemoryManagementQuery(options: MemoryManagementOptions): MemoryManagementQuery {
  const { accountId } = options;
  const currentRuntime = (): MemoryRuntime | null => options.resolveRuntime();
  return {
    async status(): Promise<MemoryStatusView> {
      const configuration = await options.readConfiguration();
      const runtime = currentRuntime();
      const runtimeStatus = runtime?.status ?? {
        mode: 'disabled' as const,
        engineReady: false,
        ftsAvailable: false,
        providerRef: null,
        modelRef: null,
      };
      const providerRef = runtimeStatus.providerRef;
      const modelRef = runtimeStatus.modelRef;
      const model = modelRef ? configuration.models[modelRef] : undefined;
      const selectableProviders = Object.entries(configuration.providers).map(([ref, provider]) => {
        const models = Object.entries(configuration.models)
          .filter(([, candidate]) => candidate.providerRef === ref)
          .map(([candidateRef, candidate]) => ({
            modelRef: candidateRef,
            modelId: candidate.modelId,
            displayName: candidate.description?.split('\n')[0]?.slice(0, 120) || candidate.modelId,
            supportsStructuredOutput: candidate.capabilities.includes('structured-output'),
            enabled: candidate.enabled,
            ...(candidate.costInputPerMillion !== undefined ? { costInputPerMillion: candidate.costInputPerMillion } : {}),
            ...(candidate.costOutputPerMillion !== undefined ? { costOutputPerMillion: candidate.costOutputPerMillion } : {}),
          }));
        const unsupportedReason = provider.protocol !== 'openai-compatible'
          ? `provider_protocol_${provider.protocol}_unsupported`
          : !provider.enabled
            ? 'provider_disabled'
            : undefined;
        return {
          providerRef: ref,
          displayName: provider.displayName ?? ref,
          baseUrl: provider.baseUrl,
          models,
          ...(unsupportedReason ? { unsupportedReason } : {}),
        };
      });
      return {
        enabled: runtimeStatus.mode === 'enabled',
        mode: runtimeStatus.mode,
        ...(runtimeStatus.detail ? { detail: runtimeStatus.detail } : {}),
        providerRef,
        modelRef,
        engineReady: runtimeStatus.engineReady,
        ftsAvailable: runtimeStatus.ftsAvailable,
        modelName: model?.description?.split('\n')[0]?.slice(0, 120) || model?.modelId || null,
        modelPricing: model
          ? {
            ...(model.costInputPerMillion !== undefined ? { costInputPerMillion: model.costInputPerMillion } : {}),
            ...(model.costOutputPerMillion !== undefined ? { costOutputPerMillion: model.costOutputPerMillion } : {}),
          }
          : null,
        selectableProviders,
      };
    },

    async listAssets(input: { limit: number; offset: number }) {
      const runtime = currentRuntime();
      const service = runtime?.service ?? null;
      if (!service) {
        const mode = runtime?.status.mode ?? 'disabled';
        // Disabled and needs-model legitimately have no assets. A degraded
        // engine must not be rendered as "no assets yet".
        return mode === 'degraded'
          ? {
            items: [],
            total: 0,
            mode,
            degraded: true,
            degradedReason: runtime?.status.detail ?? 'memory_engine_unavailable',
          }
          : { items: [], total: 0, mode, degraded: false };
      }
      const page = await service.listAssets({
        accountId,
        limit: input.limit,
        offset: input.offset,
        includeDisabled: true,
      });
      return {
        items: page.items.map(asset => ({
          memoryId: asset.memoryId,
          tdaiMemoryId: asset.id,
          type: asset.type,
          preview: asset.content.slice(0, 240),
          source: asset.source,
          workspaceId: asset.workspaceId,
          enabled: asset.enabled,
          createdAt: asset.createdAt,
          updatedAt: asset.updatedAt,
        })),
        total: page.total,
        mode: 'enabled',
        degraded: false,
      };
    },

    async setEnabled(input: { memoryId: string; enabled: boolean }) {
      const service = currentRuntime()?.service ?? null;
      if (!service) return null;
      return service.setEnabled({
        accountId,
        memoryId: input.memoryId,
        enabled: input.enabled,
      });
    },

    async deleteAsset(input: { memoryId: string }) {
      const service = currentRuntime()?.service ?? null;
      if (!service) return false;
      return service.deleteAsset({ accountId, memoryId: input.memoryId });
    },
  };
}
