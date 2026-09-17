import { describe, expect, it } from 'vitest';
import { resolvePublicRoutingIdentity } from '../../src/configuration/public-routing-identity.js';

const plannerBinding = {
  agentClassRef: 'planner',
  harnessRef: 'anyfusion-planner-host-v2',
  providerRef: 'planner-provider',
  modelRef: 'planner-model',
  configurationRevision: 'revision-1',
};

describe('public routing identity', () => {
  it('presents the Planner as MetaWork while retaining the AnyFusion-Pi attribution', () => {
    const identity = resolvePublicRoutingIdentity(undefined, plannerBinding);

    expect(identity.executorDisplayName).toBe('MetaWork Planner (AnyFusion-Pi)');
    expect(identity.harnessDisplayName).toBe('MetaWork Planner (AnyFusion-Pi)');
    expect(plannerBinding.harnessRef).toBe('anyfusion-planner-host-v2');
  });

  it('uses configured AgentClass and Provider display names without changing binding IDs', () => {
    const binding = {
      agentClassRef: 'pi-agent',
      harnessRef: 'pi-cli',
      providerRef: 'kimi',
      modelRef: 'research',
      configurationRevision: 'revision-1',
    };
    const source = {
      revisionId: 'revision-1',
      contentHash: 'sha256:test',
      config: {
        schemaVersion: 2 as const,
        providers: {
          kimi: {
            displayName: '我的工作模型',
            protocol: 'openai-compatible' as const,
            baseUrl: 'https://api.kimi.com/coding/v1',
            apiKeyRef: 'file-secret:anyfusion/providers/kimi',
            region: 'international',
            enabled: true,
          },
        },
        models: {
          research: {
            providerRef: 'kimi',
            modelId: 'k3',
            capabilities: ['tools' as const],
            reasoning: 'high' as const,
            enabled: true,
          },
        },
        harnesses: {},
        agentClasses: {
          'pi-agent': {
            displayName: '研究助手',
            kind: 'executor' as const,
            harnessRef: 'pi-cli',
            modelPolicy: { mode: 'fixed' as const, modelRef: 'research' },
            routingCapabilities: [],
            primaryUseCases: [],
            avoidUseCases: [],
            plannerAffordances: [],
            skills: [],
            mcpServers: [],
            plugins: [],
            generatedRuntimeRef: 'pi-agent',
            enabled: true,
          },
        },
        permissionProfiles: {},
        runtimePolicy: {},
        gateway: {},
      },
    };

    const identity = resolvePublicRoutingIdentity(source, binding);

    expect(identity.executorDisplayName).toBe('研究助手');
    expect(identity.providerDisplayName).toBe('我的工作模型');
    expect(binding.agentClassRef).toBe('pi-agent');
    expect(binding.providerRef).toBe('kimi');
  });

  it.each([
    ['pi-agent', '智能体 1'],
    ['codex-cli', '智能体 2'],
    ['research-assistant', 'Research Assistant'],
  ])('resolves the missing %s display name to %s', (agentClassRef, expected) => {
    const identity = resolvePublicRoutingIdentity(undefined, {
      ...plannerBinding,
      agentClassRef,
    });

    expect(identity.executorDisplayName).toBe(expected);
  });
});
