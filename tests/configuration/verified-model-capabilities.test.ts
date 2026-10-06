import { describe, it, expect } from 'vitest';
import { prepareVerifiedModelCapabilities } from '../../src/configuration/model-capability-catalog.js';
import { buildModelsJson } from '../../src/configuration/agent-runtime-renderer.js';
import { buildStagedLegacyConfiguration } from '../../src/configuration/staged-legacy-configuration.js';

describe('revision-scoped visual model facts', () => {
  it('repairs official Flash input without widening an unrelated endpoint or mutating history', () => {
    const config = buildStagedLegacyConfiguration({ testMode: true }).snapshot.config;
    const model = Object.values(config.models)[0]!;
    model.modelId = 'deepseek-flash'; model.capabilities = ['tools'];
    config.providers[model.providerRef]!.baseUrl = 'https://api.deepseek.com/v1';
    const candidate = prepareVerifiedModelCapabilities(config);
    expect(model.capabilities).toEqual(['tools']);
    expect(Object.values(candidate.models)[0]!.capabilities).toEqual(['tools', 'vision']);
    const runtime = buildModelsJson(candidate) as { providers: Record<string, { models: Array<{ id: string; input: string[] }> }> };
    expect(runtime.providers[model.providerRef]!.models.find(m => m.id === 'deepseek-flash')!.input).toEqual(['text', 'image']);
    for (const baseUrl of ['https://third-party.example/v1', 'https://api.deepseek.com.attacker.test', 'http://api.deepseek.com']) {
      config.providers[model.providerRef]!.baseUrl = baseUrl;
      expect(Object.values(prepareVerifiedModelCapabilities(config).models)[0]!.capabilities).toEqual(['tools']);
    }
  });
});
