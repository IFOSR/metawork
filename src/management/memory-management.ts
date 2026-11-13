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

/**
 * Why memory cannot serve the user, as a stable code the client can render.
 *
 * "The engine is not installed" and "the engine's SQLite has no FTS5" are
 * different failures with different fixes; collapsing them into one
 * "BM25 检索不可用" message sent users looking for the wrong problem.
 */
export type MemoryEngineProblem =
  | 'extraction_model_required'
  | 'extraction_credential_missing'
  | 'engine_missing'
  | 'engine_unreachable'
  | 'engine_unhealthy'
  | 'fts5_unavailable';

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
  /** Actionable reason the engine cannot serve memory; absent when it can. */
  engineProblem?: MemoryEngineProblem;
  /** Extraction Model display name, resolved from the configuration. */
  modelName: string | null;
  /** Extraction Model price, so the user sees whose quota is spent. */

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

    }>;
    /** Why this provider cannot be used, when it cannot. */
    unsupportedReason?: string;
  }>;
}

export interface MemoryAssetView {
  memoryId: string;
  tdaiMemoryId: string;
  type: string;
  layer: 'l1' | 'l2' | 'l3';
  title: string;
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
  unfilteredTotal?: number;
  /** Runtime mode that produced this list. */
  mode: MemoryStatusView['mode'];
  /** True when the engine is unavailable, so an empty list is not "no assets". */
  degraded: boolean;
  degradedReason?: string;
}

/** Portable, credential-free account memory package. */
export interface MemoryPackage {
  format: 'metawork-memory';
  version: 1;
  exportedAt: string;
  accountId: string;
  total: number;
  items: Array<MemoryAssetView & { content: string; background: string | null; revision: string | null }>;
}

export interface MemoryManagementQuery {
  status(): Promise<MemoryStatusView>;
  exportAssets(signal?: AbortSignal): Promise<MemoryPackage>;
  listAssets(input: { limit: number; offset: number; query?: string; type?: string; layer?: 'l1' | 'l2' | 'l3'; enabled?: boolean }): Promise<MemoryAssetListView>;
  getAsset(input: { memoryId: string }): Promise<(MemoryAssetView & { content: string }) | null>;
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

    }>;
  }>;
}

/**
 * Classify one runtime state into the reason the user has to act on.
 *
 * `disabled` is a product decision, not a problem, and an operational runtime
 * has no problem. Everything else is one of the fixes the settings page can
 * describe: choose a model, provide a credential, install the engine, start it,
 * repair it, or rebuild it with FTS5.
 */
export function classifyMemoryEngineProblem(input: {
  mode: 'disabled' | 'needs-model' | 'enabled' | 'degraded';
  engineReady: boolean;
  ftsAvailable: boolean;
  detail?: string | undefined;
}): MemoryEngineProblem | undefined {
  if (input.mode === 'disabled' || input.mode === 'enabled') return undefined;
  if (input.mode === 'needs-model') return 'extraction_model_required';
  const detail = input.detail ?? '';
  if (detail === 'memory_extraction_credential_missing') return 'extraction_credential_missing';
  if (!input.engineReady && detail.startsWith('memory sidecar installation')) return 'engine_missing';
  if (detail === 'fts5_unavailable') return 'fts5_unavailable';
  if (!input.ftsAvailable && input.engineReady) return 'fts5_unavailable';
  if (detail.startsWith('health_unreachable') || detail.startsWith('health_http_')) {
    return 'engine_unreachable';
  }
  if (detail.startsWith('engine_status_') || detail === 'memory_bm25_unavailable') {
    return 'engine_unhealthy';
  }
  if (detail.startsWith('memory_engine_')) return 'engine_unreachable';
  return input.ftsAvailable ? 'engine_unreachable' : 'engine_unhealthy';
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
      const engineProblem = classifyMemoryEngineProblem({
        mode: runtimeStatus.mode,
        engineReady: runtimeStatus.engineReady,
        ftsAvailable: runtimeStatus.ftsAvailable,
        detail: runtimeStatus.detail,
      });
      return {
        enabled: runtimeStatus.mode === 'enabled',
        mode: runtimeStatus.mode,
        ...(runtimeStatus.detail ? { detail: runtimeStatus.detail } : {}),
        ...(engineProblem ? { engineProblem } : {}),
        providerRef,
        modelRef,
        engineReady: runtimeStatus.engineReady,
        ftsAvailable: runtimeStatus.ftsAvailable,
        modelName: model?.description?.split('\n')[0]?.slice(0, 120) || model?.modelId || null,

        selectableProviders,
      };
    },

    async exportAssets(signal?: AbortSignal): Promise<MemoryPackage> {
      const service = currentRuntime()?.service;
      if (!service) throw new Error('memory_engine_unavailable');
      const assets = await service.exportAssets({ accountId, ...(signal ? { signal } : {}) });
      signal?.throwIfAborted();
      const result: MemoryPackage = {
        format: 'metawork-memory', version: 1, exportedAt: new Date().toISOString(), accountId,
        total: assets.length,
        items: assets.map(asset => ({
          memoryId: asset.memoryId, tdaiMemoryId: asset.id, type: asset.type,
          layer: asset.layer ?? 'l1', title: asset.title ?? asset.type,
          preview: asset.content.slice(0, 240), content: asset.content,
          background: asset.background, revision: asset.revision ?? null,
          source: asset.source, workspaceId: asset.workspaceId, enabled: asset.enabled,
          createdAt: asset.createdAt, updatedAt: asset.updatedAt,
        })),
      };
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 32 * 1024 * 1024) throw new Error('memory_export_too_large');
      return result;
    },

    async listAssets(input: { limit: number; offset: number; query?: string; type?: string; layer?: 'l1' | 'l2' | 'l3'; enabled?: boolean }) {
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
        ...input,
        includeDisabled: true,
      });
      return {
        items: page.items.map(asset => ({
          memoryId: asset.memoryId,
          tdaiMemoryId: asset.id,
          type: asset.type,
          layer: asset.layer ?? 'l1',
          title: asset.title ?? asset.type,
          preview: asset.content.slice(0, 240),
          source: asset.source,
          workspaceId: asset.workspaceId,
          enabled: asset.enabled,
          createdAt: asset.createdAt,
          updatedAt: asset.updatedAt,
        })),
        total: page.total,
        unfilteredTotal: page.unfilteredTotal,
        mode: 'enabled',
        degraded: false,
      };
    },

    async getAsset(input: { memoryId: string }) {
      const service = currentRuntime()?.service;
      if (!service) throw new Error('memory_engine_unavailable');
      const asset = await service.getAsset({ accountId, memoryId: input.memoryId });
      if (!asset) return null;
      return {
        memoryId: asset.memoryId, tdaiMemoryId: asset.id, type: asset.type,
        layer: asset.layer ?? 'l1', title: asset.title ?? asset.type,
        content: asset.content, preview: asset.content.slice(0, 240),
        source: asset.source, workspaceId: asset.workspaceId, enabled: asset.enabled,
        createdAt: asset.createdAt, updatedAt: asset.updatedAt,
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
