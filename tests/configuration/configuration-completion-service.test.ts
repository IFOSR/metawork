import { describe, expect, it } from 'vitest';
import { ConfigurationCompletionService } from '../../src/configuration/configuration-completion-service.js';
import { MODEL_CAPABILITY_CATALOG } from '../../src/configuration/model-capability-catalog.js';

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

  it('fills known Model capabilities from the public catalog when the config omits them', () => {
    const result = new ConfigurationCompletionService({
      modelCapabilities: { 'gpt-5.6-sol': ['coding', 'tools', 'vision'] },
    }).complete({
      providers: {},
      models: {
        sol: { providerRef: 'code-cli', modelId: 'gpt-5.6-sol' },
      },
      agentClasses: {},
    });

    expect(result.models.sol).toEqual({
      providerRef: 'code-cli',
      modelId: 'gpt-5.6-sol',
      capabilities: ['coding', 'tools', 'vision'],
      capabilityState: '已自动发现',
    });
    expect(result.requiredFields).not.toContain('models.sol.capabilities');
  });

  it('exposes known public Model capabilities for image generation and coding models', () => {
    expect(MODEL_CAPABILITY_CATALOG['gpt-image-2']).toContain('vision');
    expect(MODEL_CAPABILITY_CATALOG['gpt-5.6-sol']).toEqual(
      expect.arrayContaining(['coding', 'tools', 'vision']),
    );

    const result = new ConfigurationCompletionService({
      modelCapabilities: MODEL_CAPABILITY_CATALOG,
    }).complete({
      providers: {},
      models: {
        image: { providerRef: 'code-cli', modelId: 'gpt-image-2' },
      },
      agentClasses: {},
    });

    expect(result.models.image).toMatchObject({
      capabilities: expect.arrayContaining(['vision']),
      capabilityState: '已自动发现',
    });
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
