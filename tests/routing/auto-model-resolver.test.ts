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
  it('follows the decision model even when the preferred candidate has fewer broad labels', () => {
    const result = AutoModelResolver.resolve({
      configurationRevision: 'revision-1', agentClassRef: 'executor',
      harnessRef: 'pi', permissionProfileRef: 'workspace',
      policy: { mode: 'auto', allowedModelRefs: ['tag-rich', 'specialist'] },
      candidates: [
        candidate({ modelRef: 'tag-rich', capabilities: ['coding', 'planning', 'long-context', 'tools'] }),
        candidate({ modelRef: 'specialist', capabilities: ['tools'], costInputPerMillion: 10 }),
      ],
      requirements: {
        requiredCapabilities: ['coding', 'planning', 'long-context', 'tools'],
        preferredCapabilities: ['coding', 'planning', 'long-context'], contextTokens: 4_000,
      },
      spanProbabilities: { 'tag-rich': 0.1, specialist: 0.9 },
    });
    expect(result.binding?.modelRef).toBe('specialist');
    expect(result.rejectedCandidates).toEqual([]);
    expect(result.scoreBreakdown?.spanProbability).toBe(0.9);
  });

  it.each(['vision', 'tools', 'image-generation', 'image-editing'] as const)(
    'keeps the %s execution constraint even with a favorable decision score', capability => {
      const result = AutoModelResolver.resolve({
        configurationRevision: 'revision-1', agentClassRef: 'executor',
        harnessRef: 'pi', permissionProfileRef: 'workspace',
        policy: { mode: 'auto', allowedModelRefs: ['unsupported', 'supported'] },
        candidates: [
          candidate({ modelRef: 'unsupported', capabilities: [] }),
          candidate({ modelRef: 'supported', capabilities: [capability] }),
        ],
        requirements: { requiredCapabilities: [capability], preferredCapabilities: [], contextTokens: 1_024 },
        spanProbabilities: { unsupported: 0.99, supported: 0.01 },
      });
      expect(result.binding?.modelRef).toBe('supported');
      expect(result.rejectedCandidates[0]?.reason).toBe(`missing_capability:${capability}`);
    },
  );

  it('does not treat missing prices as free and refuses unknown costs with a hard budget', () => {
    const input = {
      configurationRevision: 'revision-1', agentClassRef: 'executor',
      harnessRef: 'pi', permissionProfileRef: 'workspace',
      policy: { mode: 'auto' as const, allowedModelRefs: ['unknown', 'priced'], objective: { priority: 'cost' as const } },
      candidates: [
        candidate({ modelRef: 'unknown', costInputPerMillion: undefined }),
        candidate({ modelRef: 'priced' }),
      ],
      requirements: { preferredCapabilities: [], contextTokens: 1_024 },
    };
    expect(AutoModelResolver.resolve(input).binding?.modelRef).toBe('priced');
    const advised = AutoModelResolver.resolve({ ...input, spanProbabilities: { unknown: 0.9, priced: 0.1 } });
    expect(advised.binding?.modelRef).toBe('unknown');
    expect(advised.scoreBreakdown?.estimatedCost).toBeNull();
    const budgeted = AutoModelResolver.resolve({ ...input, requirements: { ...input.requirements, maxCostPerTurn: 1 } });
    expect(budgeted.rejectedCandidates).toContainEqual({ modelRef: 'unknown', providerRef: 'provider-a', reason: 'cost_unknown' });
    const free = AutoModelResolver.resolve({ ...input, candidates: [candidate({ modelRef: 'priced', costInputPerMillion: 0, costOutputPerMillion: 0 })] });
    expect(free.scoreBreakdown?.estimatedCost).toBe(0);
  });

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
      preferredCapabilityMatchCount: 0,
      preferredCapabilityMissCount: 0,
    });
  });

  it('uses the cost objective without rewarding generic capability labels', () => {
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

    expect(result.binding?.modelRef).toBe('cheap');
    expect(result.scoreBreakdown).toMatchObject({
      modelRef: 'cheap',
      objective: 'cost',
      estimatedCost: expect.any(Number),
      estimatedLatencyMs: expect.any(Number),
      preferredCapabilityMatchCount: 0,
      preferredCapabilityMissCount: 0,
    });
    expect(result.fallbackCandidates.map(candidate => candidate.modelRef)).toEqual(['cheap', 'fast']);
    expect(result.policyVersion).toBe('auto-model-routing-v2');
  });

  it('does not simulate semantic judgment with keyword overlap when the decision model is absent', () => {
    const result = AutoModelResolver.resolve({
      configurationRevision: 'revision-1',
      agentClassRef: 'executor',
      harnessRef: 'pi',
      permissionProfileRef: 'workspace',
      policy: {
        mode: 'auto',
        allowedModelRefs: ['generic', 'refactor-specialist'],
        objective: { priority: 'quality' },
      },
      candidates: [
        candidate({
          modelRef: 'generic',
          description: 'General purpose assistant',
        }),
        candidate({
          modelRef: 'refactor-specialist',
          description: 'Strong at large codebase refactoring and engineering migration',
          routingNotes: { preferredTaskTypes: ['大型代码重构'] },
        }),
      ],
      requirements: {
        preferredCapabilities: ['coding'],
        contextTokens: 4_000,
        taskText: '请完成大型代码重构并补充回归测试',
      },
    });

    expect(result.binding?.modelRef).toBe('generic');
    expect(result.scoreBreakdown).toMatchObject({
      modelRef: 'generic',
      modelFitScore: 0,
    });
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

  it('names the rejected candidates and reasons when nothing is eligible', () => {
    expect(() => AutoModelResolver.resolve({
      configurationRevision: 'revision-1',
      agentClassRef: 'planner',
      harnessRef: 'anyfusion-planner',
      permissionProfileRef: 'planner-none',
      policy: { mode: 'fixed', modelRef: 'k3' },
      candidates: [
        candidate({
          modelRef: 'k3',
          modelId: 'k3',
          capabilities: [],
        }),
      ],
      requirements: {
        preferredCapabilities: ['planning', 'structured-output'],
        contextTokens: 1_024,
        requiresStructuredOutput: true,
      },
    })).toThrow(
      'no eligible model candidate (k3: missing_capability:structured-output)',
    );
  });
});
