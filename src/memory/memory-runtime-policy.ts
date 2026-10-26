/**
 * Effective memory policy for one configuration revision.
 *
 * Resolves the design §7 tri-state:
 *   - disabled: no sidecar, no request, no model cost, no index.
 *   - enabled without a model: the settings page asks for an extraction model;
 *     nothing is extracted.
 *   - enabled with a model: fully operational.
 *
 * Pure module: reads a configuration snapshot, never mutates one.
 */

import type { AnyFusionConfigurationV2, MemoryConfiguration } from '../configuration/types.js';
import { MEMORY_DEFAULTS } from '../configuration/types.js';

export type MemoryMode = 'disabled' | 'needs-model' | 'enabled';

export interface MemoryRuntimePolicy {
  mode: MemoryMode;
  enabled: boolean;
  providerRef: string | null;
  modelRef: string | null;
  /** Base URL of the extraction Provider. */
  baseUrl: string | null;
  /** Secret reference holding the extraction Provider credential. */
  apiKeyRef: string | null;
  modelId: string | null;
  maxResults: number;
  maxChars: number;
  port: number;
  dataDir: string | null;
  autoStart: boolean;
}

export function resolveMemoryRuntimePolicy(
  configuration: AnyFusionConfigurationV2,
): MemoryRuntimePolicy {
  const memory: MemoryConfiguration | undefined = configuration.memory;
  const retrieval = memory?.retrieval ?? {};
  const sidecar = memory?.sidecar ?? {};
  const enabled = memory?.enabled === true;
  const providerRef = memory?.providerRef ?? null;
  const modelRef = memory?.modelRef ?? null;

  const policy: MemoryRuntimePolicy = {
    mode: enabled ? (providerRef && modelRef ? 'enabled' : 'needs-model') : 'disabled',
    enabled,
    providerRef,
    modelRef,
    baseUrl: null,
    apiKeyRef: null,
    modelId: null,
    maxResults: retrieval.maxResults ?? MEMORY_DEFAULTS.retrieval.maxResults,
    maxChars: retrieval.maxChars ?? MEMORY_DEFAULTS.retrieval.maxChars,
    port: sidecar.port ?? MEMORY_DEFAULTS.sidecar.port,
    dataDir: sidecar.dataDir ?? null,
    autoStart: sidecar.autoStart ?? MEMORY_DEFAULTS.sidecar.autoStart,
  };

  if (!enabled || !providerRef || !modelRef) return policy;
  const provider = configuration.providers[providerRef];
  const model = configuration.models[modelRef];
  if (!provider || !model) return policy;
  return {
    ...policy,
    baseUrl: provider.baseUrl.replace(/\/+$/u, ''),
    apiKeyRef: provider.apiKeyRef,
    modelId: model.modelId,
  };
}
