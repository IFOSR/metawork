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
  getRuntimeBinding(
    binding: AuthorizedExecutorBinding,
  ): Promise<RuntimePrivateConfigurationBinding>;
}

export function createProductionRuntimeBindings(input: {
  snapshot: ConfigurationSnapshot;
  secretStore: SecretStore;
  getSnapshot?: (revisionId: string) => Promise<ConfigurationSnapshot>;
}): ProductionRuntimeBindings {
  const runtimeConfiguration = buildRuntimeConfigurationView(input.snapshot);
  return {
    runtimeConfiguration,
    maxConcurrentAttempts: runtimeConfiguration.runtimePolicy.maxConcurrentAttempts ?? 4,
    getRuntimeBinding: async binding => {
      const snapshot = binding.configurationRevision === input.snapshot.revisionId
        ? input.snapshot
        : await input.getSnapshot?.(binding.configurationRevision);
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
