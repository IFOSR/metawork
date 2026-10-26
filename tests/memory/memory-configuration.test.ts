import { describe, expect, it } from 'vitest';
import { parseAnyFusionConfigurationV2 } from '../../src/configuration/schema.js';
import { resolveMemoryRuntimePolicy } from '../../src/memory/memory-runtime-policy.js';
import type { AnyFusionConfigurationV2 } from '../../src/configuration/types.js';

function baseConfiguration(overrides: Partial<AnyFusionConfigurationV2> = {}): AnyFusionConfigurationV2 {
  return {
    schemaVersion: 2,
    providers: {
      'openai-like': {
        protocol: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        apiKeyRef: 'file-secret:anyfusion/providers/openai-like',
        region: 'global',
        enabled: true,
        displayName: 'OpenAI-like',
      },
      anthropic: {
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKeyRef: 'file-secret:anyfusion/providers/anthropic',
        region: 'global',
        enabled: true,
      },
    },
    models: {
      'extraction-model': {
        providerRef: 'openai-like',
        modelId: 'gpt-4o-mini',
        capabilities: ['structured-output'],
        reasoning: 'disabled',
        enabled: true,
      },
      'plain-model': {
        providerRef: 'openai-like',
        modelId: 'gpt-4o',
        capabilities: ['coding'],
        reasoning: 'disabled',
        enabled: true,
      },
    },
    harnesses: {},
    agentClasses: {},
    permissionProfiles: {},
    runtimePolicy: { maxConcurrentAttempts: 2, maxConcurrentAttemptsPerTask: 1 },
    gateway: {},
    ...overrides,
  } as AnyFusionConfigurationV2;
}

describe('memory configuration', () => {
  it('accepts a configuration without a memory section', () => {
    const parsed = parseAnyFusionConfigurationV2(baseConfiguration());
    expect(parsed.memory).toBeUndefined();
    expect(resolveMemoryRuntimePolicy(parsed).mode).toBe('disabled');
  });

  it('accepts memory that is explicitly disabled without a model', () => {
    const parsed = parseAnyFusionConfigurationV2(baseConfiguration({
      memory: { enabled: false },
    }));
    expect(resolveMemoryRuntimePolicy(parsed).mode).toBe('disabled');
  });

  it('accepts the enabled-without-model state the settings page renders', () => {
    // Design §7.2: "enabled, no extraction model yet" is a persistable state, not
    // an invalid configuration (review P2-7).
    const parsed = parseAnyFusionConfigurationV2(baseConfiguration({
      memory: { enabled: true },
    }));
    expect(parsed.memory).toEqual({ enabled: true });
    expect(resolveMemoryRuntimePolicy(parsed).mode).toBe('needs-model');
  });

  it('rejects a provider without its model and a model without its provider', () => {
    expect(() => parseAnyFusionConfigurationV2(baseConfiguration({
      memory: { enabled: true, providerRef: 'openai-like' },
    }))).toThrow(/requires a modelRef/u);
    expect(() => parseAnyFusionConfigurationV2(baseConfiguration({
      memory: { enabled: true, modelRef: 'extraction-model' },
    }))).toThrow(/requires a providerRef/u);
  });

  it('rejects a provider that is not openai-compatible', () => {
    expect(() => parseAnyFusionConfigurationV2(baseConfiguration({
      memory: { enabled: true, providerRef: 'anthropic', modelRef: 'extraction-model' },
    }))).toThrow(/openai-compatible/u);
  });

  it('rejects a disabled provider', () => {
    const configuration = baseConfiguration();
    configuration.providers['openai-like']!.enabled = false;
    expect(() => parseAnyFusionConfigurationV2({
      ...configuration,
      memory: { enabled: true, providerRef: 'openai-like', modelRef: 'extraction-model' },
    })).toThrow(/enabled Provider/u);
  });

  it('rejects a model that belongs to another provider', () => {
    const configuration = baseConfiguration();
    configuration.models['extraction-model']!.providerRef = 'anthropic';
    expect(() => parseAnyFusionConfigurationV2({
      ...configuration,
      memory: { enabled: true, providerRef: 'openai-like', modelRef: 'extraction-model' },
    })).toThrow(/must belong to Provider/u);
  });

  it('rejects a model without structured output capability', () => {
    expect(() => parseAnyFusionConfigurationV2(baseConfiguration({
      memory: { enabled: true, providerRef: 'openai-like', modelRef: 'plain-model' },
    }))).toThrow(/structured-output/u);
  });

  it('rejects a disabled model', () => {
    const configuration = baseConfiguration();
    configuration.models['extraction-model']!.enabled = false;
    expect(() => parseAnyFusionConfigurationV2({
      ...configuration,
      memory: { enabled: true, providerRef: 'openai-like', modelRef: 'extraction-model' },
    })).toThrow(/enabled Model/u);
  });

  it('accepts a valid extraction model and resolves the runtime policy', () => {
    const parsed = parseAnyFusionConfigurationV2(baseConfiguration({
      memory: {
        enabled: true,
        providerRef: 'openai-like',
        modelRef: 'extraction-model',
        retrieval: { maxResults: 7, maxChars: 1_500 },
        sidecar: { port: 9_000, autoStart: true },
      },
    }));
    const policy = resolveMemoryRuntimePolicy(parsed);
    expect(policy.mode).toBe('enabled');
    expect(policy.baseUrl).toBe('https://api.example.com/v1');
    expect(policy.apiKeyRef).toBe('file-secret:anyfusion/providers/openai-like');
    expect(policy.modelId).toBe('gpt-4o-mini');
    expect(policy.maxResults).toBe(7);
    expect(policy.maxChars).toBe(1_500);
    expect(policy.port).toBe(9_000);
  });

  it('reports needs-model when the switch is on but the model is missing', () => {
    const policy = resolveMemoryRuntimePolicy(baseConfiguration({
      memory: { enabled: true },
    }));
    expect(policy.mode).toBe('needs-model');
  });

  it('never auto-selects an extraction model', () => {
    const policy = resolveMemoryRuntimePolicy(baseConfiguration({
      memory: { enabled: true },
    }));
    expect(policy.providerRef).toBeNull();
    expect(policy.modelRef).toBeNull();
    expect(policy.modelId).toBeNull();
  });
});
