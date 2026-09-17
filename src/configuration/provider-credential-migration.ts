import { existsSync } from 'node:fs';
import type { CredentialsFileSecretStore } from './credentials-file-secret-store.js';
import { importLegacyProviderCredentials } from './legacy-provider-credential-import.js';
import {
  createLegacyProductionSecretStore,
  prepareProductionSecretStore,
} from './production-secret-store.js';
import type { ProviderDefinition } from './types.js';

export type ProviderCredentialMigrationStatus =
  'already-migrated' | 'migrated' | 'legacy-store-unavailable';

export interface ProviderCredentialMigrationResult {
  readonly status: ProviderCredentialMigrationStatus;
  readonly imported: readonly string[];
  readonly missing: readonly string[];
  readonly detail?: string;
}

/**
 * Pre-activation Provider credential migration (ADR-0033 cutover).
 *
 * Installations created before the MetaWork credentials file kept Provider keys
 * in the account-scoped `accounts/<id>/secrets/` directory. The credentials file
 * became the production store together with a one-time import that runs during
 * Server startup — that is, *after* a release activation. The upgrade
 * transaction probes the candidate configuration *before* activation, so an
 * older installation could never satisfy that probe and every update failed with
 * `Provider <ref> secret is unavailable`.
 *
 * Running the same import first makes the probe meaningful instead of
 * unsatisfiable. It is inert once the credentials file exists and it writes
 * nothing but that file.
 */
export async function migrateLegacyProviderCredentials(input: {
  target: CredentialsFileSecretStore;
  providers: Record<string, ProviderDefinition>;
  legacySecretsDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ProviderCredentialMigrationResult> {
  if (existsSync(input.target.filePath)) {
    // A valid file is the migration marker. A malformed one fails closed, just
    // like Server startup and configuration access.
    await input.target.validate();
    return { status: 'already-migrated', imported: [], missing: [] };
  }

  let legacyStore;
  try {
    legacyStore = createLegacyProductionSecretStore({
      secretsRoot: input.legacySecretsDir,
      env: input.env ?? process.env,
      references: Object.values(input.providers).map(provider => provider.apiKeyRef),
    });
  } catch (error) {
    // No Provider can be migrated from the legacy layout. Report it instead of
    // failing outright: the candidate probe still reports which references are
    // genuinely unavailable.
    return {
      status: 'legacy-store-unavailable',
      imported: [],
      missing: Object.keys(input.providers),
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  await prepareProductionSecretStore(input.target);
  const result = await importLegacyProviderCredentials({
    target: input.target,
    providers: input.providers,
    legacyStore,
  });
  return {
    status: 'migrated',
    imported: [...result.imported],
    missing: [...result.missing],
  };
}
