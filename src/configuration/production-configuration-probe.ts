import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { executableFile, resolveExecutorTool } from '../utils/executor-tool-path.js';
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
  /** Program activation is independent of external Executor installation readiness. */
  checkExecutors?: boolean;
  previousSnapshot?: () => Promise<ConfigurationSnapshot>;
}): (
  snapshot: ConfigurationSnapshot,
  compiled: CompiledConfigurationRevision,
) => Promise<ConfigurationProbeResult> {
  const detectCommand = input.detectCommand ?? (async command => executableFile(resolveExecutorTool(command, { releaseRoot: input.releaseRoot })));
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

    const previous = await input.previousSnapshot?.();
    const requiredHarnesses = new Set(Object.values(snapshot.config.agentClasses)
      .filter(agent => agent.enabled)
      .map(agent => agent.harnessRef));
    for (const [ref, harness] of Object.entries(snapshot.config.harnesses)) {
      if (input.checkExecutors === false) continue;
      if (!requiredHarnesses.has(ref)) continue;
      if (harness.transport !== 'local-cli' || !harness.enabled) continue;
      // Unchanged unavailable tools must not block repairing unrelated settings.
      const old = previous?.config.harnesses[ref];
      if (old?.transport === 'local-cli' && old.command === harness.command) continue;
      const commandAvailable = await detectCommand(harness.command);
      if (!commandAvailable) {
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
  if (isAbsolute(command)) return executableFile(command);
  if (command.includes('/') || command.includes('\\')) return false;
  return searchPath.split(delimiter).some(directory => isAbsolute(directory) && executableFile(join(directory, command)));
}
