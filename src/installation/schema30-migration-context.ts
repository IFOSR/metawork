import { authorizedExecutorBindingFingerprint } from '../core/authorized-executor-binding.js';
import type { ConfigurationSnapshot } from '../configuration/types.js';
import {
  createSchema30MigrationContext,
  type Schema30MigrationBinding,
  type Schema30MigrationContext,
} from '../storage/migrations.js';

export function createMigrationContextFromSnapshot(
  snapshot: ConfigurationSnapshot,
  importedAt = new Date().toISOString(),
): Schema30MigrationContext {
  const planners = Object.entries(snapshot.config.agentClasses)
    .filter(([, agentClass]) => agentClass.kind === 'planner' && agentClass.enabled);
  if (planners.length !== 1) {
    throw new Error(`schema 30 migration requires exactly one enabled Planner AgentClass; found ${planners.length}`);
  }
  const [plannerRef, planner] = planners[0]!;
  const plannerBinding = bindingFor(snapshot, plannerRef, planner);
  const legacyAgentClassBindings: Record<string, Schema30MigrationBinding> = {};

  for (const [agentClassRef, agentClass] of Object.entries(snapshot.config.agentClasses)) {
    if (agentClass.kind !== 'executor' || !agentClass.enabled) continue;
    const binding = bindingFor(snapshot, agentClassRef, agentClass);
    addAlias(legacyAgentClassBindings, agentClassRef, binding);
    const harness = snapshot.config.harnesses[agentClass.harnessRef]!;
    if (harness.driverId === 'codex-cli') {
      addAlias(legacyAgentClassBindings, 'codex-cli', binding);
    }
    if (harness.driverId === 'pi-cli') {
      addAlias(legacyAgentClassBindings, 'pi-agent', binding);
      addAlias(legacyAgentClassBindings, 'pi-cli', binding);
    }
  }

  return createSchema30MigrationContext({
    revisionId: snapshot.revisionId,
    contentHash: snapshot.contentHash,
    importedAt,
    plannerBinding,
    legacyAgentClassBindings,
  });
}

function bindingFor(
  snapshot: ConfigurationSnapshot,
  agentClassRef: string,
  agentClass: ConfigurationSnapshot['config']['agentClasses'][string],
): Schema30MigrationBinding {
  if (agentClass.modelPolicy.mode !== 'fixed') {
    throw new Error(
      `schema 30 migration requires a fixed Model for AgentClass ${agentClassRef}`,
    );
  }
  const harness = snapshot.config.harnesses[agentClass.harnessRef];
  if (!harness) throw new Error(`AgentClass ${agentClassRef} references missing Harness`);
  const modelRef = agentClass.modelPolicy.modelRef;
  const model = snapshot.config.models[modelRef];
  if (!model) throw new Error(`AgentClass ${agentClassRef} references missing Model`);
  const provider = snapshot.config.providers[model.providerRef];
  if (!provider) throw new Error(`Model ${modelRef} references missing Provider`);
  const permissionProfileRef = agentClass.permissionProfileRef ?? null;
  const bindingFingerprint = authorizedExecutorBindingFingerprint({
    agentClassRef,
    harnessRef: agentClass.harnessRef,
    modelRef,
    providerRef: model.providerRef,
    permissionProfileRef: permissionProfileRef ?? 'planner-none',
    configurationRevision: snapshot.revisionId,
  });
  return {
    agentClassRef,
    harnessRef: agentClass.harnessRef,
    modelRef,
    providerRef: model.providerRef,
    permissionProfileRef,
    bindingFingerprint,
  };
}

function addAlias(
  target: Record<string, Schema30MigrationBinding>,
  alias: string,
  binding: Schema30MigrationBinding,
): void {
  const existing = target[alias];
  if (existing && existing.agentClassRef !== binding.agentClassRef) {
    throw new Error(`ambiguous legacy AgentClass alias: ${alias}`);
  }
  target[alias] = binding;
}
