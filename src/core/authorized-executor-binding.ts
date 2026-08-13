import { createHash } from 'node:crypto';

export interface RevisionedAgentBinding {
  agentClassRef: string;
  harnessRef: string;
  providerRef: string;
  modelRef: string;
  permissionProfileRef: string | null;
  configurationRevision: string;
}

export interface AuthorizedExecutorBinding extends RevisionedAgentBinding {
  permissionProfileRef: string;
}

export function authorizedExecutorBindingFingerprint(
  binding: AuthorizedExecutorBinding,
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      binding.agentClassRef,
      binding.harnessRef,
      binding.providerRef,
      binding.modelRef,
      binding.permissionProfileRef,
      binding.configurationRevision,
    ]))
    .digest('hex');
}
