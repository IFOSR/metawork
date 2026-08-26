import { FileSecretStore } from './file-secret-store.js';
import { KeychainSecretStore } from './keychain-secret-store.js';
import {
  assertSecretReference,
  type SecretReference,
  type SecretStore,
} from './secret-store.js';
import {
  PRODUCT_ENVIRONMENT,
  resolveProductEnvironment,
} from '../installation/product-environment.js';

export function createProductionSecretStore(input: {
  platform?: NodeJS.Platform;
  secretsRoot: string;
  env?: NodeJS.ProcessEnv;
  references?: readonly string[];
}): SecretStore {
  const platform = input.platform ?? process.platform;
  const requested = resolveProductEnvironment(
    input.env ?? {},
    ...PRODUCT_ENVIRONMENT.secretStore,
  );
  const configured = configuredSecretStore(input.references ?? []);
  if (requested && configured && requested !== configured) {
    throw new Error(
      `METAWORK_SECRET_STORE=${requested} conflicts with active ${configured} secret references`,
    );
  }
  if (requested === 'file') {
    return new FileSecretStore(input.secretsRoot);
  }
  if (requested && requested !== 'keychain') {
    throw new Error(`unsupported METAWORK_SECRET_STORE: ${requested}`);
  }
  if (configured === 'file') {
    return new FileSecretStore(input.secretsRoot);
  }
  if (platform !== 'darwin') {
    if (requested === 'keychain' || configured === 'keychain') {
      throw new Error('Keychain secret store requires macOS');
    }
    throw new Error(
      'non-macOS native installation requires explicit METAWORK_SECRET_STORE=file',
    );
  }
  return new KeychainSecretStore();
}

export async function prepareProductionSecretStore(store: SecretStore): Promise<void> {
  if (!(store instanceof FileSecretStore)) return;
  await store.initialize();
  await store.assertSecurePermissions();
}

function configuredSecretStore(
  references: readonly string[],
): 'file' | 'keychain' | null {
  const schemes = new Set<'file' | 'keychain'>();
  for (const value of references) {
    assertSecretReference(value);
    const reference = value as SecretReference;
    schemes.add(reference.startsWith('file-secret:') ? 'file' : 'keychain');
  }
  if (schemes.size > 1) {
    throw new Error('active configuration mixes secret reference schemes');
  }
  return schemes.values().next().value ?? null;
}
