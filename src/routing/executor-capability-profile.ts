import type {
  ModelCapability,
  PlannerExecutorCapabilityManual,
} from '../configuration/types.js';
import {
  buildExecutorCapabilityManual,
} from './executor-capability-manual.js';
import {
  compileExecutorCapabilityProfileCore,
  type ExecutorCapabilityProfileInput,
} from './executor-capability-profile-core.js';

export interface ExecutorCapabilityProfile {
  schemaVersion: 1;
  agentClassRef: string;
  configurationRevision: string;
  sourceFingerprint: string;
  routableCapabilities: PlannerExecutorCapabilityManual['routableCapabilities'];
  capabilities: PlannerExecutorCapabilityManual['capabilities'];
  modelCapabilities: Record<string, ModelCapability[]>;
  manual: PlannerExecutorCapabilityManual;
}

export function compileExecutorCapabilityProfile(
  input: ExecutorCapabilityProfileInput,
): ExecutorCapabilityProfile {
  const core = compileExecutorCapabilityProfileCore(input);
  const manual = buildExecutorCapabilityManual(input);
  if (manual.sourceFingerprint !== core.sourceFingerprint) {
    throw new Error(
      `Executor capability profile fingerprint mismatch: ${input.agentClassRef}`,
    );
  }
  if (!sameCapabilities(manual.routableCapabilities, core.routableCapabilities)) {
    throw new Error(
      `Executor capability profile routing projection mismatch: ${input.agentClassRef}`,
    );
  }
  return {
    schemaVersion: 1,
    agentClassRef: core.agentClassRef,
    configurationRevision: core.configurationRevision,
    sourceFingerprint: core.sourceFingerprint,
    routableCapabilities: core.routableCapabilities,
    capabilities: core.capabilities,
    modelCapabilities: core.modelCapabilities,
    manual,
  };
}

function sameCapabilities(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((capability, index) => capability === right[index]);
}
