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

