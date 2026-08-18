import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type {
  CompiledConfigurationRevision,
  ConfigurationProbeResult,
} from './configuration-service.js';
import { assertSecretReference, type SecretStore } from './secret-store.js';
import type { ConfigurationSnapshot } from './types.js';

export function createProductionConfigurationProbe(input: {
  releaseRoot: string;
  secretStore: SecretStore;
  detectCommand?: (command: string) => Promise<boolean>;
}): (
  snapshot: ConfigurationSnapshot,
  compiled: CompiledConfigurationRevision,
) => Promise<ConfigurationProbeResult> {
  const detectCommand = input.detectCommand ?? commandExistsOnPath;
  return async snapshot => {
    const issues: string[] = [];
    for (const [providerRef, provider] of Object.entries(snapshot.config.providers)) {
      if (!provider.enabled) continue;
      try {
        assertSecretReference(provider.apiKeyRef);
        const secret = await input.secretStore.get(provider.apiKeyRef);
        if (secret.trim().length === 0) throw new Error('empty secret');
      } catch {
        issues.push(`Provider ${providerRef} secret is unavailable`);
      }
    }

    const enabledPlanner = Object.values(snapshot.config.harnesses)
      .some(harness => harness.kind === 'planner' && harness.enabled);
    if (enabledPlanner) {
      const plannerCliCandidates = [
        join(
          input.releaseRoot,
          'planner',
          'packages',
          'coding-agent',
          'dist',
          'cli.js',
        ),
        join(
          input.releaseRoot,
          'planner',
          'AnyFusion-Pi',
          'packages',
          'coding-agent',
          'dist',
          'cli.js',
        ),
      ];
      const plannerAvailable = await Promise.all(
        plannerCliCandidates.map(path => access(path).then(() => true, () => false)),
      ).then(results => results.some(Boolean));
      if (!plannerAvailable) {
        issues.push('Planner artifact is missing');
      }
    }

    for (const harness of Object.values(snapshot.config.harnesses)) {
      if (harness.transport !== 'local-cli' || !harness.enabled) continue;
      if (!await detectCommand(harness.command)) {
        issues.push(`Executor command is unavailable: ${harness.command}`);
      }
    }

    return issues.length === 0 ? { ok: true } : { ok: false, issues };
  };
}

export async function commandExistsOnPath(
  command: string,
  searchPath = process.env.PATH ?? '',
): Promise<boolean> {
  for (const directory of searchPath.split(delimiter)) {
    if (await access(join(directory || process.cwd(), command)).then(() => true, () => false)) {
      return true;
    }
  }
  return false;
}
