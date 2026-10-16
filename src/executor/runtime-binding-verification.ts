import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimePrivateConfigurationBinding } from '../configuration/types.js';
import { authorizedExecutorBindingFingerprint, type AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';

/** Generated revision configuration is authoritative for every managed launch. */
export async function verifyExecutorRuntimeHome(input: {
  runtimeBinding: RuntimePrivateConfigurationBinding;
  authorizedBinding: AuthorizedExecutorBinding;
  driverId: string;
  modelId: string;
  homePath: string;
}): Promise<void> {
  const { runtimeBinding, authorizedBinding, driverId, modelId, homePath } = input;
  const manifest = runtimeBinding.manifest;
  if (!manifest) return; // Legacy injected bindings have no generated configuration.
  if (runtimeBinding.revisionId !== authorizedBinding.configurationRevision
    || runtimeBinding.bindingFingerprint !== authorizedExecutorBindingFingerprint(authorizedBinding)
    || manifest.driverId !== driverId || manifest.modelId !== modelId
    || manifest.permissionProfileRef !== authorizedBinding.permissionProfileRef
    || runtimeBinding.environment?.OPENAI_BASE_URL !== manifest.baseUrl
    || runtimeBinding.environment?.OPENAI_MODEL !== manifest.modelId) {
    throw new Error('Executor configuration manifest binding mismatch');
  }
  for (const [path, expected] of Object.entries(manifest.runtimeFileHashes)) {
    const bytes = await readFile(join(homePath, path));
    if (createHash('sha256').update(bytes).digest('hex') !== expected) {
      throw new Error(`Executor configuration content mismatch: ${path}`);
    }
  }
}
