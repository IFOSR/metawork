import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import type { RuntimePrivateConfigurationBinding } from '../configuration/types.js';
import { authorizedExecutorBindingFingerprint, type AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';

/** Verify the selected effective configuration, independent of file bytes/order. */
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
  const expected = manifest.runtimeConfiguration;
  if (driverId !== 'pi-cli' && driverId !== 'codex-cli') return;
  if (!expected) throw new Error('Executor effective configuration is missing');
  if (driverId === 'pi-cli') {
    const registry = record(await readJson('.pi/agent/models.json'));
    const entry = record(record(registry.providers)[authorizedBinding.providerRef]);
    const { models, ...provider } = entry;
    compare(provider, expected.provider, 'selected Provider');
    const matches = Array.isArray(models)
      ? models.filter(item => record(item).id === modelId) : [];
    if (matches.length !== 1) throw new Error('Executor configuration mismatch: selected Model must exist exactly once');
    compare(matches[0], expected.model, 'selected Model');
    compare(await readJson('.pi/agent/settings.json'), expected.settings, 'execution settings');
  } else {
    let config: Record<string, unknown>;
    try {
      config = parseToml(await readFile(join(homePath, 'config.toml'), 'utf8'));
    } catch {
      throw new Error('Executor configuration could not be read: config.toml');
    }
    // The concrete model/provider are supplied by the authorized CLI arguments.
    const { model_providers, model, model_provider, ...settings } = config;
    compare(record(model_providers)[authorizedBinding.providerRef], expected.provider, 'selected Provider');
    compare(settings, expected.settings, 'execution settings');
  }

  async function readJson(path: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(join(homePath, path), 'utf8'));
    } catch {
      throw new Error(`Executor configuration could not be read: ${path}`);
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function compare(actual: unknown, expected: unknown, subject: string): void {
  if (!isDeepStrictEqual(actual, expected)) {
    // Never include parsed values: modified files may contain credentials.
    throw new Error(`Executor configuration mismatch: ${subject}`);
  }
}
