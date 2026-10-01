import { describe, expect, it } from 'vitest';
import { validateEnabledModelPrices } from '../../src/configuration/enabled-model-price-validation.js';
import type { AnyFusionConfigurationV2 } from '../../src/configuration/types.js';

function configuration(enabledBroken: boolean): AnyFusionConfigurationV2 {
  return {
    schemaVersion: 2,
    providers: {
      provider: { protocol: 'openai-compatible', baseUrl: 'https://example.test/v1', apiKeyRef: 'file-secret:x', region: 'global', enabled: true },
    },
    models: {
      good: { providerRef: 'provider', modelId: 'good', capabilities: ['coding'], reasoning: 'disabled', costInputPerMillion: 0, costOutputPerMillion: 0, enabled: true },
      bad: { providerRef: 'provider', modelId: 'bad', capabilities: ['coding'], reasoning: 'disabled', enabled: true },
    },
    harnesses: {
      planner: { kind: 'planner', driverId: 'anyfusion-planner-host-v2', supportsProbe: false, supportsAbort: false, supportsContinuation: false, transport: 'local-process', commandRef: 'planner', args: [], enabled: true },
      executor: { kind: 'executor', driverId: 'pi-cli', supportsProbe: false, supportsAbort: false, supportsContinuation: false, transport: 'local-cli', command: 'pi', args: [], enabled: true },
    },
    agentClasses: {
      planner: { kind: 'planner', harnessRef: 'planner', modelPolicy: { mode: 'fixed', modelRef: 'good' }, routingCapabilities: [], primaryUseCases: [], avoidUseCases: [], plannerAffordances: [], skills: [], mcpServers: [], plugins: [], generatedRuntimeRef: 'planner', enabled: true },
      ...(enabledBroken ? { broken: { kind: 'executor', harnessRef: 'executor', modelPolicy: { mode: 'fixed', modelRef: 'bad' }, permissionProfileRef: 'workspace-engineering', routingCapabilities: [], primaryUseCases: [], avoidUseCases: [], plannerAffordances: [], skills: [], mcpServers: [], plugins: [], generatedRuntimeRef: 'broken', enabled: true } } : {}),
    },
    permissionProfiles: { 'workspace-engineering': { profileId: 'workspace-engineering', version: 1, parameters: {} } },
  } as AnyFusionConfigurationV2;
}

describe('enabled model price validation', () => {
  it('ignores prices for disabled or absent AgentClasses', () => {
    expect(validateEnabledModelPrices(configuration(false))).toEqual([]);
  });
  it('requires both sides of an enabled model price', () => {
    expect(validateEnabledModelPrices(configuration(true))).toEqual([
      '启用模型 provider/bad 缺少输入价格 costInputPerMillion',
      '启用模型 provider/bad 缺少输出价格 costOutputPerMillion',
    ]);
  });
});
