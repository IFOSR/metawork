import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import { buildRuntimeConfigurationView } from './projections.js';
import { resolveRuntimePrivateConfigurationBinding } from './runtime-private-binding-resolver.js';
import { ATTEMPTS_PER_TASK_BUDGET } from '../core/runtime-limits.js';
import type { SecretStore } from './secret-store.js';
import type {
  ConfigurationSnapshot,
  RuntimePrivateConfigurationBinding,
} from './types.js';

export interface ProductionRuntimeBindings {
  runtimeConfiguration: ReturnType<typeof buildRuntimeConfigurationView>;
  /** Executing Conversations inside one Workspace; the only scheduling limit. */
  maxConcurrentConversationsPerWorkspace: number;
  /** Attempts a single Task may run at once. Internal budget. */
  maxConcurrentAttemptsPerTask: number;
  schedulingAgingMs: number;
  sameConversationQueueLimit: number;
  getRuntimeConfiguration(
    revisionId: string,
  ): ReturnType<typeof buildRuntimeConfigurationView> | null;
  getActiveRuntimeConfiguration(): ReturnType<typeof buildRuntimeConfigurationView>;
  loadConfigurationSnapshot(revisionId: string): Promise<ConfigurationSnapshot>;
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
  const runtimeConfiguration = buildRuntimeConfigurationView(input.snapshot);
  let activeRuntimeConfiguration = runtimeConfiguration;
  const loadConfigurationSnapshot = async (revisionId: string): Promise<ConfigurationSnapshot> => {
    const snapshot = snapshots.get(revisionId) ?? await input.getSnapshot?.(revisionId);
    if (!snapshot || snapshot.revisionId !== revisionId) {
      throw new Error(`configuration revision is unavailable: ${revisionId}`);
    }
    snapshots.set(revisionId, snapshot);
    return snapshot;
  };
  return {
    get runtimeConfiguration() {
      return activeRuntimeConfiguration;
    },
    get maxConcurrentConversationsPerWorkspace() {
      return activeRuntimeConfiguration.runtimePolicy.maxConcurrentConversationsPerWorkspace ?? 2;
    },
    get maxConcurrentAttemptsPerTask() {
      // Internal budget, not a setting: a stored value is ignored so the fan-out
      // stays predictable across configuration revisions.
      return ATTEMPTS_PER_TASK_BUDGET;
    },
    get schedulingAgingMs() {
      return activeRuntimeConfiguration.runtimePolicy.schedulingAgingMs ?? 300_000;
    },
    get sameConversationQueueLimit() {
      return activeRuntimeConfiguration.runtimePolicy.sameConversationQueueLimit ?? 8;
    },
    getRuntimeConfiguration: revisionId => {
      const snapshot = snapshots.get(revisionId);
      return snapshot ? buildRuntimeConfigurationView(snapshot) : null;
    },
    getActiveRuntimeConfiguration: () => activeRuntimeConfiguration,
    loadConfigurationSnapshot,
    updateSnapshot: snapshot => {
      snapshots.set(snapshot.revisionId, snapshot);
      activeRuntimeConfiguration = buildRuntimeConfigurationView(snapshot);
    },
    getRuntimeBinding: async binding => {
      const snapshot = await loadConfigurationSnapshot(binding.configurationRevision);
      return resolveRuntimePrivateConfigurationBinding({
        configuration: buildRuntimeConfigurationView(snapshot),
        authorizedBinding: binding,
        secretStore: input.secretStore,
      });
    },
  };
}
