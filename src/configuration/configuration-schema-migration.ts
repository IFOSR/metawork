import type { AnyFusionConfigurationV2, ModelPricingMetadata } from './types.js';

export interface AnyFusionConfigurationV3 extends Omit<AnyFusionConfigurationV2, 'schemaVersion'> {
  schemaVersion: 3;
}

/**
 * Converts an existing v2 revision to the additive settings contract. The
 * runtime keeps v2 readable; callers may stage this result as a v3 candidate
 * when the repository schema migration is enabled.
 */
export function migrateConfigurationV2ToV3(
  configuration: AnyFusionConfigurationV2,
): AnyFusionConfigurationV3 {
  return {
    ...configuration,
    schemaVersion: 3,
    models: Object.fromEntries(Object.entries(configuration.models).map(([ref, model]) => {
      const pricing: ModelPricingMetadata | undefined = model.pricing ?? (
        model.costInputPerMillion !== undefined || model.costOutputPerMillion !== undefined
          ? {
              source: 'user',
              exchangeRate: 7,
              overrideReason: '迁移自 schema v2 的人民币价格',
            }
          : undefined
      );
      return [ref, { ...model, ...(pricing ? { pricing } : {}) }];
    })),
    agentClasses: Object.fromEntries(Object.entries(configuration.agentClasses).map(([ref, agent]) => [
      ref,
      { ...agent, ...(agent.responsibility !== undefined ? { responsibility: agent.responsibility } : {}) },
    ])),
  };
}

export function migrateConfigurationV3ToV2(
  configuration: AnyFusionConfigurationV3,
): AnyFusionConfigurationV2 {
  return { ...configuration, schemaVersion: 2 };
}
