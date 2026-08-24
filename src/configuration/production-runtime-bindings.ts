import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import { buildRuntimeConfigurationView } from './projections.js';
import { resolveRuntimePrivateConfigurationBinding } from './runtime-private-binding-resolver.js';
import type { SecretStore } from './secret-store.js';
import type {
  ConfigurationSnapshot,
  RuntimePrivateConfigurationBinding,
} from './types.js';

export interface ProductionRuntimeBindings {
  runtimeConfiguration: ReturnType<typeof buildRuntimeConfigurationView>;
  maxConcurrentAttempts: number;
  getRuntimeConfiguration(
    revisionId: string,
  ): ReturnType<typeof buildRuntimeConfigurationView> | null;
  getActiveRuntimeConfiguration(): ReturnType<typeof buildRuntimeConfigurationView>;
  updateSnapshot(snapshot: ConfigurationSnapshot): void;
  getRuntimeBinding(
    binding: AuthorizedExecutorBinding,
  ): Promise<RuntimePrivateConfigurationBinding>;
}

export function createProductionRuntimeBindings(input: {
  snapshot: ConfigurationSnapshot;
  secretStore: SecretStore;
  getSnapshot?: (revisionId: string) => Promise<ConfigurationSnapshot>;
}): ProductionRuntimeBindings {
  const snapshots = new Map<string, ConfigurationSnapshot>([[input.snapshot.revisionId, input.snapshot]]);
  let activeSnapshot = input.snapshot;
  const runtimeConfiguration = buildRuntimeConfigurationView(input.snapshot);
  let activeRuntimeConfiguration = runtimeConfiguration;
  return {
    get runtimeConfiguration() {
      return activeRuntimeConfiguration;
    },
    get maxConcurrentAttempts() {
      return activeRuntimeConfiguration.runtimePolicy.maxConcurrentAttempts ?? 4;
    },
    getRuntimeConfiguration: revisionId => {
      const snapshot = snapshots.get(revisionId);
      return snapshot ? buildRuntimeConfigurationView(snapshot) : null;
    },
    getActiveRuntimeConfiguration: () => activeRuntimeConfiguration,
    updateSnapshot: snapshot => {
      snapshots.set(snapshot.revisionId, snapshot);
      activeSnapshot = snapshot;
      activeRuntimeConfiguration = buildRuntimeConfigurationView(snapshot);
    },
    getRuntimeBinding: async binding => {
      const snapshot = snapshots.get(binding.configurationRevision)
        ?? (binding.configurationRevision === activeSnapshot.revisionId
          ? activeSnapshot
          : await input.getSnapshot?.(binding.configurationRevision));
      if (!snapshot) {
        throw new Error(
          `configuration revision is unavailable: ${binding.configurationRevision}`,
        );
      }
      return resolveRuntimePrivateConfigurationBinding({
        configuration: buildRuntimeConfigurationView(snapshot),
        authorizedBinding: binding,
        secretStore: input.secretStore,
      });
    },
  };
}
