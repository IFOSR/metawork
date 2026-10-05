import { describe, expect, it } from 'vitest';
import {
  AutoModelResolver,
  filterEligibleModelCandidates,
  type AutoModelCandidate,
} from '../../src/routing/auto-model-resolver.js';
import {
  planProposalFingerprint,
  planRoutingCandidateSetFingerprint,
  planSubtaskCandidateGroups,
  resolvePreferredModelRef,
} from '../../src/routing/plan-routing-candidates.js';
import type { KernelConfigurationView } from '../../src/configuration/types.js';
import type { WorkGraphSubtask } from '../../src/work-graph/types.js';

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

function kernelConfiguration(overrides: {
  fastPolicy?: KernelConfigurationView['agentClasses'][string]['modelPolicy'];
  deepEnabled?: boolean;
} = {}): KernelConfigurationView {
  return {
    revisionId: 'revision-1',
    contentHash: 'hash-1',
    agentClasses: {
      'codex-fast': {
        kind: 'executor',
        harnessRef: 'codex',
        driverId: 'codex-cli',
        modelPolicy: overrides.fastPolicy ?? {
          mode: 'auto',
          allowedModelRefs: ['model-fast', 'model-deep'],
        },
        permissionProfileRef: 'workspace',
        routingCapabilities: ['workspace-engineering'],
        enabled: true,
        transport: 'local-cli',
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
      },
      'pi-general': {
        kind: 'executor',
        harnessRef: 'pi',
        driverId: 'pi-cli',
        modelPolicy: { mode: 'auto', allowedModelRefs: ['model-deep'] },
        permissionProfileRef: 'workspace',
        routingCapabilities: ['workspace-engineering'],
        enabled: overrides.deepEnabled ?? true,
        transport: 'local-cli',
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
      },
    },
    models: {
      'model-fast': {
        providerRef: 'provider-a',
        modelId: 'gpt-fast',
        capabilities: ['coding', 'tools'],
        reasoning: 'low',
        enabled: true,
      },
      'model-deep': {
        providerRef: 'provider-a',
        modelId: 'gpt-deep',
        capabilities: ['coding', 'tools'],
        reasoning: 'high',
        enabled: true,
      },
    },
    providers: { 'provider-a': { enabled: true } },
    permissionProfiles: {
      workspace: { profileId: 'workspace-engineering', version: 1, parameters: {} },
    },
    runtimePolicy: {},
  };
}

function subtask(overrides: Partial<WorkGraphSubtask> = {}): WorkGraphSubtask {
  return {
    id: 'subtask-1',
    title: 'Implement parser',
    goal: 'Implement the parser',
    dependencies: [],
    contextRefs: [],
    requiredCapabilities: [],
    executorBindings: [
      { agentClassRef: 'codex-fast', modelSelection: { mode: 'fixed-by-agent-class' } },
      { agentClassRef: 'pi-general', modelSelection: { mode: 'fixed-by-agent-class' } },
    ],
    deliveryKind: 'edit',
    acceptance: [],
    riskLevel: 'low',
    ...overrides,
  };
}

describe('shared plan routing candidates', () => {
  it('narrows candidates with the same filter the resolver uses', () => {
    const policy = { mode: 'auto' as const, allowedModelRefs: ['model-fast', 'model-deep'] };
    const candidates = [
      candidate({ modelRef: 'model-fast' }),
      candidate({ modelRef: 'model-deep', capabilities: ['coding'] }),
      candidate({ modelRef: 'model-other' }),
    ];
    const filtered = filterEligibleModelCandidates({
      policy,
      candidates,
      requirements: {
        requiredCapabilities: ['tools'],
        preferredCapabilities: [],
        contextTokens: 1_024,
      },
    });
    expect(filtered.eligible.map(item => item.modelRef)).toEqual(['model-fast']);
    expect(filtered.rejected).toContainEqual(expect.objectContaining({
      modelRef: 'model-deep',
      reason: 'missing_capability:tools',
    }));
  });

  it('projects eligible candidates per proposed AgentClass in planner order', () => {
    const groups = planSubtaskCandidateGroups({
      configuration: kernelConfiguration(),
      subtask: subtask(),
    });
    expect(groups.map(group => group.agentClassRef)).toEqual(['codex-fast', 'pi-general']);
    expect(groups.every(group => group.eligible.length > 0)).toBe(true);
    expect(groups[0]!.eligible.map(item => item.modelRef).sort())
      .toEqual(['model-deep', 'model-fast']);
  });

  it('excludes unavailable AgentClasses exactly like the Kernel health rule', () => {
    const groups = planSubtaskCandidateGroups({
      configuration: kernelConfiguration(),
      subtask: subtask(),
      unavailableAgentClasses: new Set(['pi-general']),
    });
    expect(groups.find(group => group.agentClassRef === 'pi-general')?.error).toBe('agent_class_unavailable');
  });

  it('keeps a fixed policy to exactly one eligible candidate', () => {
    const groups = planSubtaskCandidateGroups({
      configuration: kernelConfiguration({
        fastPolicy: { mode: 'fixed', modelRef: 'model-fast' },
      }),
      subtask: subtask(),
    });
    expect(groups[0]!.eligible.map(item => item.modelRef)).toEqual(['model-fast']);
  });

  it('fails closed for a disabled AgentClass instead of inventing candidates', () => {
    const groups = planSubtaskCandidateGroups({
      configuration: kernelConfiguration({ deepEnabled: false }),
      subtask: subtask(),
    });
    expect(groups[1]!.eligible).toEqual([]);
  });

  it('produces an order-independent candidate-set fingerprint', () => {
    const first = planRoutingCandidateSetFingerprint([
      { agentClassRef: 'b', providerRef: 'p', modelRef: 'm2' },
      { agentClassRef: 'a', providerRef: 'p', modelRef: 'm1' },
    ]);
    const second = planRoutingCandidateSetFingerprint([
      { agentClassRef: 'a', providerRef: 'p', modelRef: 'm1' },
      { agentClassRef: 'b', providerRef: 'p', modelRef: 'm2' },
    ]);
    expect(first).toBe(second);
    expect(planRoutingCandidateSetFingerprint([
      { agentClassRef: 'a', providerRef: 'p', modelRef: 'm1' },
    ])).not.toBe(first);
  });

  it('fingerprints the proposal so a stale observation cannot be reused', () => {
    const first = planProposalFingerprint({ task: { goal: 'a' }, workGraph: null });
    const second = planProposalFingerprint({ task: { goal: 'b' }, workGraph: null });
    expect(first).not.toBe(second);
  });

  it('derives the preferred Model ref from the Planner selection and policy', () => {
    expect(resolvePreferredModelRef(
      { mode: 'proposed', modelRef: 'model-deep', reason: 'needs depth' },
      { mode: 'auto', allowedModelRefs: ['model-fast', 'model-deep'] },
    )).toBe('model-deep');
    expect(resolvePreferredModelRef(
      { mode: 'agent-class-default' },
      { mode: 'auto', allowedModelRefs: ['model-fast'], defaultModelRef: 'model-fast' },
    )).toBe('model-fast');
    expect(resolvePreferredModelRef(
      { mode: 'fixed-by-agent-class' },
      { mode: 'auto', allowedModelRefs: ['model-fast'] },
    )).toBeUndefined();
  });
});

describe('Span probability ordering in AutoModelResolver', () => {
  it('leaves the deterministic result untouched when no probabilities are supplied', () => {
    const input = {
      configurationRevision: 'revision-1',
      agentClassRef: 'codex-fast',
      harnessRef: 'codex',
      permissionProfileRef: 'workspace',
      policy: { mode: 'auto' as const, allowedModelRefs: ['model-fast', 'model-deep'] },
      candidates: [
        candidate({ modelRef: 'model-fast', latencyTier: 'low' as const }),
        candidate({ modelRef: 'model-deep', latencyTier: 'high' as const }),
      ],
      requirements: { preferredCapabilities: [], contextTokens: 1_024 },
    };
    const baseline = AutoModelResolver.resolve(input);
    expect(baseline.policyVersion).toBe('auto-model-routing-v2');
    expect(baseline.scoreBreakdown?.spanProbability).toBeUndefined();
    expect(AutoModelResolver.resolve({ ...input, spanProbabilities: undefined }).binding)
      .toEqual(baseline.binding);
  });

  it('prefers the higher validated probability among hard-eligible candidates only', () => {
    const input = {
      configurationRevision: 'revision-1',
      agentClassRef: 'codex-fast',
      harnessRef: 'codex',
      permissionProfileRef: 'workspace',
      policy: { mode: 'auto' as const, allowedModelRefs: ['model-fast', 'model-deep'] },
      candidates: [
        candidate({ modelRef: 'model-fast', latencyTier: 'low' as const }),
        candidate({ modelRef: 'model-deep', latencyTier: 'high' as const }),
      ],
      requirements: { preferredCapabilities: [], contextTokens: 1_024 },
    };
    const baseline = AutoModelResolver.resolve(input);
    expect(baseline.binding?.modelRef).toBe('model-fast');
    const span = AutoModelResolver.resolve({
      ...input,
      spanProbabilities: { 'model-fast': 0.2, 'model-deep': 0.9 },
    });
    expect(span.binding?.modelRef).toBe('model-deep');
    expect(span.policyVersion).toBe('span-routing-v2');
    expect(span.scoreBreakdown?.spanProbability).toBe(0.9);
    // The base arithmetic is preserved and not blended with the probability.
    expect(span.scoreBreakdown?.totalScore).toBeGreaterThan(0);
  });

  it('never lets a probability override a hard eligibility rejection', () => {
    const input = {
      configurationRevision: 'revision-1',
      agentClassRef: 'codex-fast',
      harnessRef: 'codex',
      permissionProfileRef: 'workspace',
      policy: { mode: 'auto' as const, allowedModelRefs: ['model-fast', 'model-deep'] },
      candidates: [
        candidate({ modelRef: 'model-fast' }),
        candidate({ modelRef: 'model-deep', capabilities: ['coding'] }),
      ],
      requirements: {
        requiredCapabilities: ['tools' as const],
        preferredCapabilities: [],
        contextTokens: 1_024,
      },
    };
    const result = AutoModelResolver.resolve({
      ...input,
      spanProbabilities: { 'model-fast': 0.1, 'model-deep': 1 },
    });
    expect(result.binding?.modelRef).toBe('model-fast');
  });

  it('keeps a fixed policy pinned even with a higher probability elsewhere', () => {
    const result = AutoModelResolver.resolve({
      configurationRevision: 'revision-1',
      agentClassRef: 'codex-fast',
      harnessRef: 'codex',
      permissionProfileRef: 'workspace',
      policy: { mode: 'fixed', modelRef: 'model-fast' },
      candidates: [candidate({ modelRef: 'model-fast' }), candidate({ modelRef: 'model-deep' })],
      requirements: { preferredCapabilities: [], contextTokens: 1_024 },
      spanProbabilities: { 'model-fast': 0.1, 'model-deep': 1 },
    });
    expect(result.binding?.modelRef).toBe('model-fast');
    expect(result.policyVersion).toBe('span-routing-v2');
  });
});
