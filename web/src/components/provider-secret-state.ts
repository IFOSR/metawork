import type { ProviderCredentialStatus } from '../api/types';

export type ProviderSecretState = 'unknown' | 'missing' | 'configured';

export function deriveSecretStates(
  agentClassRefs: readonly string[],
  providerRefs: Record<string, string>,
  configured: Record<string, ProviderCredentialStatus | boolean>,
): Record<string, ProviderSecretState> {
  const states: Record<string, ProviderSecretState> = {};
  for (const agentClassRef of agentClassRefs) {
    const providerRef = providerRefs[agentClassRef];
    if (!providerRef) {
      states[agentClassRef] = 'unknown';
      continue;
    }
    const status = configured[providerRef];
    states[agentClassRef] = typeof status === 'boolean'
      ? (status ? 'configured' : 'missing')
      : status?.configured ? 'configured' : 'missing';
  }
  return states;
}

export function maskApiKey(value: string): string {
  return `••••••••${value.slice(-4)}`;
}

export function normalizeProviderBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
    return url.toString().replace(/\/$/u, '');
  } catch {
    return trimmed.replace(/\/+$/u, '').toLowerCase();
  }
}

export function providerIdentityKey(provider: {
  baseUrl: string;
  apiKey: string;
  credentialFingerprint?: string;
}): string | undefined {
  const baseUrl = normalizeProviderBaseUrl(provider.baseUrl);
  // Missing credentials are unknown identities, never a shared "empty key".
  // Pending edits take precedence over the last saved credential fingerprint.
  const credential = provider.apiKey.trim()
    ? `raw:${provider.apiKey.trim()}` : provider.credentialFingerprint;
  return baseUrl && credential ? `${baseUrl}|${credential}` : undefined;
}

export async function currentProviderIdentityKey(provider: {
  baseUrl: string;
  apiKey: string;
  credentialFingerprint?: string;
}): Promise<string | undefined> {
  if (!provider.apiKey.trim()) return providerIdentityKey(provider);
  const credentialFingerprint = await fingerprintProviderCredential(provider.apiKey);
  return providerIdentityKey({ ...provider, apiKey: credentialFingerprint ? '' : provider.apiKey, credentialFingerprint });
}

export async function fingerprintProviderCredential(value: string): Promise<string | undefined> {
  const normalized = value.trim();
  if (!normalized || typeof crypto === 'undefined' || !crypto.subtle) return undefined;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function resolveProviderSecretReference(
  providerRef: string,
  _baseUrl: string,
  existingProviders: Record<string, { baseUrl?: string; apiKeyRef?: string }>,
  writtenReferences: Record<string, string>,
  knownReferences: readonly string[],
): string {
  const written = writtenReferences[providerRef];
  if (isSecretReference(written)) return written;

  const exact = existingProviders[providerRef]?.apiKeyRef;
  if (isSecretReference(exact)) {
    const referenceOwner = Object.entries(existingProviders).find(([ref, provider]) => (
      ref !== providerRef && provider.apiKeyRef === exact
    ));
    if (!referenceOwner) return exact;
  }

  const scheme = knownReferences.some(reference => reference.startsWith('keychain:'))
    ? 'keychain'
    : 'file-secret';
  return `${scheme}:anyfusion/providers/${providerRef}`;
}

export function resolveProviderSecretReferenceFromConfiguration(
  providerRef: string,
  baseUrl: string,
  providers: Record<string, unknown>,
  writtenReferences: Record<string, string>,
  knownReferences: readonly string[],
): string {
  const existingProviders = Object.fromEntries(
    Object.entries(providers).map(([ref, value]) => {
      const record = value && typeof value === 'object'
        ? value as Record<string, unknown>
        : {};
      return [ref, {
        baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : undefined,
        apiKeyRef: typeof record.apiKeyRef === 'string' ? record.apiKeyRef : undefined,
      }];
    }),
  );
  return resolveProviderSecretReference(
    providerRef,
    baseUrl,
    existingProviders,
    writtenReferences,
    knownReferences,
  );
}

function isSecretReference(value: string | undefined): value is string {
  return Boolean(value && /^(?:keychain|file-secret):[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(value));
}
