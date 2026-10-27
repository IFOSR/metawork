/**
 * Provider credential lifecycle after a configuration activation.
 *
 * Deleting a Provider is a configuration change; deleting its credential is a
 * separate follow-up that may only run once the new revision is actually the
 * active one. A failed or rolled-back activation still needs the previous
 * revision's credentials, so nothing is removed unless the activation
 * committed.
 *
 * Only Provider credentials are considered. Internal references (Span routing,
 * memory engine token, installation user key) have no Provider row and are
 * never derived from `providers`, so they cannot be swept by this module.
 */

import { assertSecretReference, type SecretReference, type SecretStore } from './secret-store.js';
import type { AnyFusionConfigurationV2 } from './types.js';

type CredentialConfiguration = Pick<AnyFusionConfigurationV2, 'providers'> & {
  routing?: AnyFusionConfigurationV2['routing'];
};

export interface ProviderCredentialCleanupInput {
  /** The revision that was active before the activation, if any. */
  previous: CredentialConfiguration | null;
  /** The revision that is active after a successful activation. */
  next: CredentialConfiguration;
}

/**
 * Credential references that belonged to a removed Provider and that the next
 * revision does not reference anywhere.
 *
 * A reference shared by two Providers survives if either one remains, and a
 * Provider that still exists keeps its credential even when it was renamed.
 */
export function orphanedProviderCredentialReferences(
  input: ProviderCredentialCleanupInput,
): SecretReference[] {
  const referenced = new Set<string>();
  for (const provider of Object.values(input.next.providers)) {
    referenced.add(provider.apiKeyRef);
  }
  const spanReference = input.next.routing?.span?.apiKeyRef;
  if (spanReference) referenced.add(spanReference);

  const orphaned = new Set<SecretReference>();
  for (const [providerRef, provider] of Object.entries(input.previous?.providers ?? {})) {
    if (input.next.providers[providerRef]) continue;
    if (referenced.has(provider.apiKeyRef)) continue;
    const reference = asSecretReference(provider.apiKeyRef);
    if (reference) orphaned.add(reference);
  }
  return [...orphaned].sort();
}

export interface ProviderCredentialCleanupOptions extends ProviderCredentialCleanupInput {
  secretStore: SecretStore;
  logger?: (message: string) => void;
}

/**
 * Delete the credentials of Providers the activated revision removed.
 *
 * Best effort: a SecretStore failure must never fail an activation that already
 * committed, and each reference is independent of the others.
 */
export async function cleanupProviderCredentials(
  options: ProviderCredentialCleanupOptions,
): Promise<SecretReference[]> {
  const removed: SecretReference[] = [];
  for (const reference of orphanedProviderCredentialReferences(options)) {
    try {
      await options.secretStore.delete(reference);
      removed.push(reference);
      options.logger?.(`removed credential of a deleted Provider: ${reference}`);
    } catch (error) {
      options.logger?.(
        `could not remove credential ${reference}: ${(error as Error).message}`,
      );
    }
  }
  return removed;
}

function asSecretReference(value: string): SecretReference | null {
  try {
    assertSecretReference(value);
    return value as SecretReference;
  } catch {
    return null;
  }
}
