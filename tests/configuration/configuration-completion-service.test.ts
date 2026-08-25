import { describe, expect, it } from 'vitest';
import { ConfigurationCompletionService } from '../../src/configuration/configuration-completion-service.js';

describe('ConfigurationCompletionService', () => {
  it('prefers active configuration and local credentials, and reports only unresolved fields', () => {
    const result = new ConfigurationCompletionService({
      presets: [{
        providerRef: 'kimi',
        displayName: 'Kimi',
        baseUrl: 'https://api.kimi.com/coding/v1',
        modelIds: ['k3'],
      }],
      localProviders: [{
        providerRef: 'kimi',
        baseUrl: 'https://api.kimi.com/coding/v1',
        credentialAvailable: true,
        modelIds: ['k3'],
      }],
    }).complete({
      providers: {},
      models: {},
      agentClasses: {
        planner: {
          kind: 'planner',
          modelPolicy: { mode: 'fixed', modelRef: 'k3' },
        },
      },
    });

    expect(result.providers.kimi).toMatchObject({
      displayName: 'Kimi',
      baseUrl: 'https://api.kimi.com/coding/v1',
      credentialState: '已从本机 Agent 导入',
      modelIds: ['k3'],
    });
    expect(result.providerPresets).toEqual([{
      providerRef: 'kimi',
      displayName: 'Kimi',
      baseUrl: 'https://api.kimi.com/coding/v1',
      modelIds: ['k3'],
    }]);
    expect(result.requiredFields).toEqual([]);
  });

  it('marks unknown model capability metadata as confirmation instead of guessing support', () => {
    const result = new ConfigurationCompletionService().complete({
      providers: {
        custom: { baseUrl: 'https://example.com/v1', credentialAvailable: false },
      },
      models: {
        customModel: { providerRef: 'custom', modelId: 'custom-model' },
      },
      agentClasses: {},
    });

    expect(result.models.customModel).toMatchObject({
      capabilityState: '需要确认',
      capabilities: [],
    });
    expect(result.providers.custom?.displayName).toBe('Custom');
    expect(result.requiredFields).toEqual([
      'models.customModel.capabilities',
      'providers.custom.credential',
    ]);
  });
});
