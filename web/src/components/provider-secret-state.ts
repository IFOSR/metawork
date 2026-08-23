export type ProviderSecretState = 'unknown' | 'missing' | 'configured';

export function deriveSecretStates(
  agentClassRefs: readonly string[],
  providerRefs: Record<string, string>,
  configured: Record<string, boolean>,
): Record<string, ProviderSecretState> {
  const states: Record<string, ProviderSecretState> = {};
  for (const agentClassRef of agentClassRefs) {
    const providerRef = providerRefs[agentClassRef];
    if (!providerRef) {
      states[agentClassRef] = 'unknown';
      continue;
    }
    states[agentClassRef] = configured[providerRef] ? 'configured' : 'missing';
  }
  return states;
}

export function resolveProviderSecretReference(
  providerRef: string,
  baseUrl: string,
  existingProviders: Record<string, { baseUrl?: string; apiKeyRef?: string }>,
  writtenReferences: Record<string, string>,
  knownReferences: readonly string[],
): string {
  const written = writtenReferences[providerRef];
  if (isSecretReference(written)) return written;

  const exact = existingProviders[providerRef]?.apiKeyRef;
  if (isSecretReference(exact)) return exact;

  const sameProvider = Object.values(existingProviders).find(provider => (
    normalizeUrl(provider.baseUrl ?? '') === normalizeUrl(baseUrl)
    && isSecretReference(provider.apiKeyRef)
  ));
  if (sameProvider?.apiKeyRef) return sameProvider.apiKeyRef;

  const scheme = knownReferences.some(reference => reference.startsWith('keychain:'))
    ? 'keychain'
    : 'file-secret';
  return `${scheme}:anyfusion/providers/${providerRef}`;
}

function isSecretReference(value: string | undefined): value is string {
  return Boolean(value && /^(?:keychain|file-secret):[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(value));
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/u, '').toLowerCase();
}
