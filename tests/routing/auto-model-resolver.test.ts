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
  it('filters hard capability, context, health and capacity mismatches before scoring', () => {
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
        requiredCapabilities: ['coding'],
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
      expect.objectContaining({ modelRef: 'vision', reason: 'missing_capability:coding' }),
    ]);
  });

  it('uses deterministic score breakdown and objective tie breaking', () => {
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
        candidate({ modelRef: 'cheap', costInputPerMillion: 1, costOutputPerMillion: 2, latencyTier: 'high' }),
      ],
      requirements: { requiredCapabilities: ['coding'], contextTokens: 4_000 },
    });

    expect(result.binding?.modelRef).toBe('cheap');
    expect(result.scoreBreakdown).toMatchObject({
      modelRef: 'cheap',
      objective: 'cost',
      estimatedCost: expect.any(Number),
      estimatedLatencyMs: expect.any(Number),
    });
    expect(result.fallbackCandidates.map(candidate => candidate.modelRef)).toEqual(['cheap', 'fast']);
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
      requirements: { requiredCapabilities: ['coding'], contextTokens: 1_000 },
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
      requirements: { requiredCapabilities: ['coding'], contextTokens: 1_000 },
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
      requirements: { requiredCapabilities: ['coding'], contextTokens: 1_000 },
    })).toThrow('no eligible model candidate');
  });
});
