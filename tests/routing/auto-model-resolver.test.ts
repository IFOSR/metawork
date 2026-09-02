import { describe, expect, it } from 'vitest';
import {
  AutoModelResolver,
  type AutoModelCandidate,
} from '../../src/routing/auto-model-resolver.js';

function candidate(overrides: Partial<AutoModelCandidate> = {}): AutoModelCandidate {
  return {
    providerRef: 'provider-a',
    modelRef: 'model-a',
    modelId: 'model-a-id',
    capabilities: ['coding', 'structured-output', 'tools'],
    contextLimit: 32_000,
    costInputPerMillion: 1,
    costOutputPerMillion: 2,
    latencyTier: 'medium',
    qualityTier: 'medium',
    health: 'healthy',
    available: true,
    ...overrides,
  };
}

describe('AutoModelResolver', () => {
  it('requires an image-capable model for image routing work', () => {
    const result = AutoModelResolver.resolve({
      configurationRevision: 'revision-1',
      agentClassRef: 'pi-agent',
      harnessRef: 'pi-cli',
      permissionProfileRef: 'workspace-engineering',
      policy: {
        mode: 'auto',
        allowedModelRefs: ['chat', 'image'],
        defaultModelRef: 'chat',
      },
      candidates: [
        candidate({
          modelRef: 'chat',
          capabilities: ['tools'],
        }),
        candidate({
          modelRef: 'image',
          capabilities: ['image-generation', 'image-editing'],
        }),
      ],
      requirements: {
        requiredCapabilities: ['image-generation'],
        preferredCapabilities: [],
        contextTokens: 1_024,
      },
    });

    expect(result.binding?.modelRef).toBe('image');
    expect(result.rejectedCandidates).toContainEqual(expect.objectContaining({
      modelRef: 'chat',
      reason: 'missing_capability:image-generation',
    }));
  });

  it('keeps models without a preferred capability in the fallback pool', () => {
    const result = AutoModelResolver.resolve({
      configurationRevision: 'revision-1',
      agentClassRef: 'codex-cli',
      harnessRef: 'codex',
      permissionProfileRef: 'workspace-engineering',
      policy: {
        mode: 'auto',
        allowedModelRefs: ['short', 'vision', 'healthy'],
        objective: { priority: 'balanced' },
      },
      candidates: [
        candidate({ modelRef: 'short', contextLimit: 1_000 }),
        candidate({ modelRef: 'vision', capabilities: ['vision', 'structured-output'] }),
        candidate({ modelRef: 'healthy', modelId: 'healthy-id', qualityTier: 'high' }),
      ],
      requirements: {
        preferredCapabilities: ['coding'],
        contextTokens: 8_000,
        requiresStructuredOutput: true,
      },
    });

    expect(result.binding).toMatchObject({
      agentClassRef: 'codex-cli',
      harnessRef: 'codex',
      providerRef: 'provider-a',
      modelRef: 'healthy',
      permissionProfileRef: 'workspace-engineering',
      configurationRevision: 'revision-1',
    });
    expect(result.rejectedCandidates).toEqual([
      expect.objectContaining({ modelRef: 'short', reason: 'context_window_insufficient' }),
    ]);
    expect(result.fallbackCandidates.map(candidate => candidate.modelRef)).toEqual([
      'healthy',
      'vision',
    ]);
    expect(result.scoreBreakdown).toMatchObject({
      modelRef: 'healthy',
      preferredCapabilityMatchCount: 1,
      preferredCapabilityMissCount: 0,
    });
  });

  it('prefers a model with a matching capability profile before the cost objective', () => {
    const result = AutoModelResolver.resolve({
      configurationRevision: 'revision-1',
      agentClassRef: 'planner',
      harnessRef: 'planner-host',
      permissionProfileRef: 'planner-none',
      policy: {
        mode: 'auto',
        allowedModelRefs: ['cheap', 'fast'],
        objective: { priority: 'cost' },
      },
      candidates: [
        candidate({ modelRef: 'fast', costInputPerMillion: 4, costOutputPerMillion: 8, latencyTier: 'low' }),
        candidate({
          modelRef: 'cheap',
          costInputPerMillion: 1,
          costOutputPerMillion: 2,
          latencyTier: 'high',
          capabilities: ['structured-output', 'tools'],
        }),
      ],
      requirements: { preferredCapabilities: ['coding'], contextTokens: 4_000 },
    });

    expect(result.binding?.modelRef).toBe('fast');
    expect(result.scoreBreakdown).toMatchObject({
      modelRef: 'fast',
      objective: 'cost',
      estimatedCost: expect.any(Number),
      estimatedLatencyMs: expect.any(Number),
      preferredCapabilityMatchCount: 1,
      preferredCapabilityMissCount: 0,
    });
    expect(result.fallbackCandidates.map(candidate => candidate.modelRef)).toEqual(['fast', 'cheap']);
    expect(result.policyVersion).toBe('auto-model-routing-v1');
  });

  it('never overrides fixed policy and returns a concrete binding only', () => {
    const result = AutoModelResolver.resolve({
      configurationRevision: 'revision-1',
      agentClassRef: 'codex-cli',
      harnessRef: 'codex',
      permissionProfileRef: 'workspace-engineering',
      policy: { mode: 'fixed', modelRef: 'fixed-model' },
      candidates: [candidate({ modelRef: 'fixed-model' })],
      requirements: { preferredCapabilities: ['coding'], contextTokens: 1_000 },
    });

    expect(result.binding?.modelRef).toBe('fixed-model');
    expect(JSON.stringify(result.binding)).not.toContain('auto');
    expect(result.rejectedCandidates).toEqual([]);
  });

  it('fails closed when no authorized candidate remains', () => {
    expect(() => AutoModelResolver.resolve({
      configurationRevision: 'revision-1',
      agentClassRef: 'codex-cli',
      harnessRef: 'codex',
      permissionProfileRef: 'workspace-engineering',
      policy: {
        mode: 'auto',
        allowedModelRefs: ['unavailable'],
      },
      candidates: [candidate({ modelRef: 'unavailable', available: false, health: 'unavailable' })],
      requirements: { preferredCapabilities: ['coding'], contextTokens: 1_000 },
    })).toThrow('no eligible model candidate');
  });

  it('rejects candidates whose provider, harness, or runtime capacity is not authorized', () => {
    expect(() => AutoModelResolver.resolve({
      configurationRevision: 'revision-1',
      agentClassRef: 'codex-cli',
      harnessRef: 'codex',
      permissionProfileRef: 'workspace-engineering',
      policy: {
        mode: 'auto',
        allowedModelRefs: ['disabled-provider', 'wrong-harness', 'busy'],
      },
      candidates: [
        candidate({
          modelRef: 'disabled-provider',
          providerEnabled: false,
        }),
        candidate({
          modelRef: 'wrong-harness',
          harnessCompatible: false,
        }),
        candidate({
          modelRef: 'busy',
          capacityAvailable: false,
        }),
      ],
      requirements: { preferredCapabilities: ['coding'], contextTokens: 1_000 },
    })).toThrow('no eligible model candidate');
  });

  it('retains the protocol hard constraint for structured Planner output', () => {
    const result = AutoModelResolver.resolve({
      configurationRevision: 'revision-1',
      agentClassRef: 'planner',
      harnessRef: 'planner-host',
      permissionProfileRef: 'planner-none',
      policy: {
        mode: 'auto',
        allowedModelRefs: ['plain', 'structured'],
      },
      candidates: [
        candidate({
          modelRef: 'plain',
          capabilities: ['planning'],
        }),
        candidate({
          modelRef: 'structured',
          capabilities: ['planning', 'structured-output'],
        }),
      ],
      requirements: {
        preferredCapabilities: ['planning'],
        contextTokens: 1_000,
        requiresStructuredOutput: true,
      },
    });

    expect(result.binding?.modelRef).toBe('structured');
    expect(result.rejectedCandidates).toEqual([
      { modelRef: 'plain', providerRef: 'provider-a', reason: 'missing_capability:structured-output' },
    ]);
  });
});
