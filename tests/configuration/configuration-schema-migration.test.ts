import { describe, expect, it } from 'vitest';
import { migrateConfigurationV2ToV3, migrateConfigurationV3ToV2 } from '../../src/configuration/configuration-schema-migration.js';
import { parseAnyFusionConfigurationV2 } from '../../src/configuration/schema.js';
import type { AnyFusionConfigurationV2 } from '../../src/configuration/types.js';

describe('configuration schema migration', () => {
  it('preserves stable identities and marks legacy prices as user supplied', () => {
    const input = {
      schemaVersion: 2,
      providers: {}, models: {}, harnesses: {}, agentClasses: {},
      permissionProfiles: {}, runtimePolicy: {}, gateway: {},
    } as AnyFusionConfigurationV2;
    input.providers.provider = {
      protocol: 'openai-compatible', baseUrl: 'https://example.com/v1',
      apiKeyRef: 'file-secret:anyfusion/providers/provider', region: 'international', enabled: true,
    };
    input.models.demo = {
      providerRef: 'provider', modelId: 'demo', capabilities: [], reasoning: 'high',
      costInputPerMillion: 1, enabled: true,
    };
    const migrated = migrateConfigurationV2ToV3(input);
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.models.demo?.pricing).toMatchObject({ source: 'user', exchangeRate: 7 });
    expect(migrated.models.demo?.modelId).toBe('demo');
    expect(migrateConfigurationV3ToV2(migrated).schemaVersion).toBe(2);
    expect(parseAnyFusionConfigurationV2(migrated).schemaVersion).toBe(2);
  });
});
