export type ConfigurationRevisionId = string;

export type ConfigurationSnapshot = Readonly<{
  revisionId: ConfigurationRevisionId;
  contentHash: string;
}>;

export type PlannerConfigurationView = Readonly<{
  revisionId: ConfigurationRevisionId;
}>;

export type KernelConfigurationView = Readonly<{
  revisionId: ConfigurationRevisionId;
}>;

export type RuntimePrivateConfigurationBinding = Readonly<{
  revisionId: ConfigurationRevisionId;
  bindingFingerprint: string;
}>;

export type ConfigurationServicePort = Readonly<{
  getActiveSnapshot(): Promise<ConfigurationSnapshot>;
  getSnapshot(revisionId: ConfigurationRevisionId): Promise<ConfigurationSnapshot>;
  getPlannerView(revisionId: ConfigurationRevisionId): Promise<PlannerConfigurationView>;
  getKernelView(revisionId: ConfigurationRevisionId): Promise<KernelConfigurationView>;
  getRuntimeBinding(
    revisionId: ConfigurationRevisionId,
    agentClassId: string,
    modelRef: string,
  ): Promise<RuntimePrivateConfigurationBinding>;
}>;
