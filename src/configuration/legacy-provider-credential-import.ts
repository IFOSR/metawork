import { access } from 'node:fs/promises';
import type { ProviderDefinition } from './types.js';
import {
  CredentialsFileSecretStore,
  providerRefFromSecretReference,
} from './credentials-file-secret-store.js';
import type { SecretReference, SecretStore } from './secret-store.js';

export interface LegacyProviderCredentialImportResult {
  imported: string[];
  missing: string[];
}

export async function importLegacyProviderCredentials(input: {
  target: CredentialsFileSecretStore;
  targetExists?: boolean;
  providers: Record<string, ProviderDefinition>;
  legacyStore: SecretStore;
}): Promise<LegacyProviderCredentialImportResult> {
  const targetExists = input.targetExists ?? await fileExists(input.target.filePath);
  if (targetExists) {
    await input.target.validate();
    return { imported: [], missing: [] };
  }

  const importedValues: Record<string, string> = {};
  const imported: string[] = [];
  const missing: string[] = [];
  for (const [providerRef, provider] of Object.entries(input.providers)) {
    let reference: SecretReference;
    try {
      reference = provider.apiKeyRef as SecretReference;
      providerRefFromSecretReference(reference);
    } catch {
      missing.push(providerRef);
      continue;
    }
    try {
      const value = (await input.legacyStore.get(reference)).trim();
      if (!value) {
        missing.push(providerRef);
        continue;
      }
      importedValues[providerRef] = value;
      imported.push(providerRef);
    } catch {
      missing.push(providerRef);
    }
  }
  // An empty but valid file is the migration marker, so the legacy store is
  // never consulted again after this first pass.
  await input.target.putProviders(importedValues);
  return { imported, missing };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
