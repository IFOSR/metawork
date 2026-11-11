/** Server-verified ownership of a model call; unknown never counts as Included. */
export const PAYERS = ['platform', 'user_direct', 'system', 'unknown'] as const;
export type Payer = (typeof PAYERS)[number];

export function isPayer(value: string): value is Payer {
  return (PAYERS as readonly string[]).includes(value);
}

import type { RuntimeConfigurationView } from '../configuration/types.js';

/** Resolve ownership from the call's pinned facts, never the active settings. */
export type UsagePayerResolver = (
  providerRef: string | null | undefined,
  configurationRevision: string,
) => Payer;

export function createUsagePayerResolver(
  getConfiguration: (revision: string) => Pick<RuntimeConfigurationView, 'revisionId' | 'providers'> | null,
): UsagePayerResolver {
  return (providerRef, revision) => {
    if (!providerRef) return 'unknown';
    const configuration = getConfiguration(revision);
    if (configuration?.revisionId !== revision) return 'unknown';
    if (!Object.hasOwn(configuration.providers, providerRef)) return 'unknown';
    const provider = configuration.providers[providerRef];
    if (!provider) return 'unknown';
    return provider.systemManaged ? 'platform' : 'user_direct';
  };
}
