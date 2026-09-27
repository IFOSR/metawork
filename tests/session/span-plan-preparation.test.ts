import { describe, expect, it, vi } from 'vitest';
import { attachSpanRoutingObservation, type PlanProposedEvent } from '../../src/session/span-plan-preparation.js';
import type { KernelConfigurationView, RuntimeConfigurationView } from '../../src/configuration/types.js';
import type { WorkGraphSubtask } from '../../src/work-graph/types.js';
import type {
  SpanRoutingEvaluator,
  SpanSubtaskEvaluationRequest,
} from '../../src/routing/span-routing-types.js';

function agentClasses(): KernelConfigurationView['agentClasses'] {
  return {
    'codex-fast': {
      kind: 'executor', harnessRef: 'codex', driverId: 'codex-cli',
      modelPolicy: { mode: 'auto', allowedModelRefs: ['model-fast'] },
      permissionProfileRef: 'workspace', routingCapabilities: ['workspace-engineering'],
      enabled: true, transport: 'local-cli', supportsProbe: true, supportsAbort: true, supportsContinuation: true,
    },
    'pi-general': {
      kind: 'executor', harnessRef: 'pi', driverId: 'pi-cli',
      modelPolicy: { mode: 'auto', allowedModelRefs: ['model-deep'] },
      permissionProfileRef: 'workspace', routingCapabilities: ['workspace-research'],
      enabled: true, transport: 'local-cli', supportsProbe: true, supportsAbort: true, supportsContinuation: true,
    },
  };
}

function kernelConfiguration(): KernelConfigurationView {
  return {
    revisionId: 'revision-1',
    contentHash: 'hash-1',
    agentClasses: agentClasses(),
    models: {
      'model-fast': { providerRef: 'provider-a', modelId: 'gpt-fast', capabilities: ['coding', 'tools'], reasoning: 'low', enabled: true },
      'model-deep': { providerRef: 'provider-a', modelId: 'gpt-deep', capabilities: ['coding', 'tools'], reasoning: 'high', enabled: true },
    },
    providers: { 'provider-a': { enabled: true } },
    permissionProfiles: { workspace: { profileId: 'workspace-engineering', version: 1, parameters: {} } },
    runtimePolicy: {},
  };
}

function runtimeConfiguration(enabled = true, timeoutMs = 3_000): RuntimeConfigurationView {
  return {
    revisionId: 'revision-1',
    contentHash: 'hash-1',
    schemaVersion: 2,
    providers: {},
    models: {},
    harnesses: {},
    agentClasses: {},
    permissionProfiles: {},
    runtimePolicy: {},
    gateway: {},
    ...(enabled ? {
      routing: {
        span: {
          enabled: true,
          model: 'respan/span-01-lite',
          apiKeyRef: 'file-secret:anyfusion/routing/span',
          timeoutMs,
        },
      },
    } : {}),
  } as RuntimeConfigurationView;
}

function subtask(id: string, overrides: Partial<WorkGraphSubtask> = {}): WorkGraphSubtask {
  return {
    id,
    title: `Subtask ${id}`,
    goal: `Do ${id}`,
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

function planEvent(subtasks: WorkGraphSubtask[]): PlanProposedEvent {
  return {
    schemaVersion: 5,
    configurationRevision: 'revision-1',
    type: 'plan_proposed',
    id: 'plan-event-1',
    correlationId: 'plan-1',
    causationId: null,
    occurredAt: '2026-09-27T00:00:00.000Z',
    sessionId: 'conversation-1',
    conversationId: 'conversation-1',
    proposal: {
      action: 'plan_work_graph',
      task: { goal: 'Ship it' },
      workGraph: { schemaVersion: 7, configurationRevision: 'revision-1', reason: 'x', subtasks },
    },
    requestText: 'Ship it',
    generationId: 'generation-1',
    proposalSource: 'initial',
    targetGraphRevision: 1,
    attachmentIds: [],
  } as unknown as PlanProposedEvent;
}

function evaluator(
  impl: (input: {
    deadlineMs: number;
    requests: readonly SpanSubtaskEvaluationRequest[];
  }) => { subtasks: Array<{ subtaskId: string; candidateSetFingerprint: string; status: 'advised'; resolvedModel: string; candidates: Array<{ candidateId: string; agentClassRef: string; providerRef: string; modelRef: string; probability: number }> }> },
): SpanRoutingEvaluator {
  return { evaluate: async input => impl(input) };
}

function adviseAll(): SpanRoutingEvaluator {
  return evaluator(({ requests }) => ({
    subtasks: requests.map(request => ({
      subtaskId: request.subtaskId,
      candidateSetFingerprint: request.candidateSetFingerprint,
      status: 'advised' as const,
      resolvedModel: 'respan/span-01-lite-20260925',
      candidates: request.request.candidates.map(binding => ({
        candidateId: binding.questionId,
        agentClassRef: binding.agentClassRef,
        providerRef: binding.providerRef,
        modelRef: binding.modelRef,
        probability: binding.agentClassRef === 'codex-fast' ? 0.9 : 0.4,
      })),
    })),
  }));
}

describe('attachSpanRoutingObservation', () => {
  it('leaves the event untouched when no evaluator is configured', async () => {
    const event = planEvent([subtask('s1')]);
    const result = await attachSpanRoutingObservation({
      event,
      configuration: kernelConfiguration(),
      executorStatuses: [],
      runtimeConfiguration: runtimeConfiguration(),
      evaluator: null,
    });
    expect(result).toBe(event);
  });

  it('leaves the event untouched when Span is disabled', async () => {
    const event = planEvent([subtask('s1')]);
    const evaluate = vi.fn();
    const result = await attachSpanRoutingObservation({
      event,
      configuration: kernelConfiguration(),
      executorStatuses: [],
      runtimeConfiguration: runtimeConfiguration(false),
      evaluator: { evaluate },
    });
    expect(result).toBe(event);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('leaves non work-graph proposals untouched', async () => {
    const event = planEvent([subtask('s1')]);
    const proposal = { ...event.proposal, action: 'direct_reply' } as unknown as PlanProposedEvent['proposal'];
    const evaluate = vi.fn();
    const result = await attachSpanRoutingObservation({
      event: { ...event, proposal },
      configuration: kernelConfiguration(),
      executorStatuses: [],
      runtimeConfiguration: runtimeConfiguration(),
      evaluator: { evaluate },
    });
    expect(result.proposal.action).toBe('direct_reply');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('attaches an advised observation for a multi-candidate Subtask', async () => {
    const result = await attachSpanRoutingObservation({
      event: planEvent([subtask('s1')]),
      configuration: kernelConfiguration(),
      executorStatuses: [],
      runtimeConfiguration: runtimeConfiguration(),
      evaluator: adviseAll(),
    });
    const observation = result.spanRouting;
    expect(observation?.subtasks).toHaveLength(1);
    expect(observation?.subtasks[0]).toMatchObject({
      subtaskId: 's1',
      status: 'advised',
      resolvedModel: 'respan/span-01-lite-20260925',
    });
    expect(observation?.proposalFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(observation?.configurationRevision).toBe('revision-1');
  });

  it('skips a single-candidate Subtask without calling the API', async () => {
    const evaluate = vi.fn(async () => ({ subtasks: [] }));
    const result = await attachSpanRoutingObservation({
      event: planEvent([
        subtask('s1', {
          executorBindings: [{ agentClassRef: 'codex-fast', modelSelection: { mode: 'fixed-by-agent-class' } }],
        }),
      ]),
      configuration: kernelConfiguration(),
      executorStatuses: [],
      runtimeConfiguration: runtimeConfiguration(),
      evaluator: { evaluate },
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(result.spanRouting?.subtasks[0]).toMatchObject({ status: 'skipped', reason: 'single_candidate' });
  });

  it('skips a Subtask with no eligible candidate', async () => {
    const evaluate = vi.fn(async () => ({ subtasks: [] }));
    const result = await attachSpanRoutingObservation({
      event: planEvent([
        subtask('s1', {
          executorBindings: [{ agentClassRef: 'missing-class', modelSelection: { mode: 'fixed-by-agent-class' } }],
        }),
      ]),
      configuration: kernelConfiguration(),
      executorStatuses: [],
      runtimeConfiguration: runtimeConfiguration(),
      evaluator: { evaluate },
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(result.spanRouting?.subtasks[0]).toMatchObject({ status: 'skipped', reason: 'no_eligible_candidate' });
  });

  it('excludes unavailable AgentClasses from the evaluated candidate set', async () => {
    const configuration = kernelConfiguration();
    configuration.agentClasses['codex-fast'] = {
      ...configuration.agentClasses['codex-fast']!,
      modelPolicy: { mode: 'auto', allowedModelRefs: ['model-fast', 'model-deep'] },
    };
    const captured: string[][] = [];
    const result = await attachSpanRoutingObservation({
      event: planEvent([subtask('s1')]),
      configuration,
      executorStatuses: [{
        agentClassName: 'pi-general',
        classHealth: 'error',
        recentAttempts: [],
        recentRecoveryChecks: [],
        updatedAt: '2026-09-27T00:00:00.000Z',
      }],
      runtimeConfiguration: runtimeConfiguration(),
      evaluator: evaluator(({ requests }) => {
        captured.push(requests[0]!.request.candidates.map(item => item.agentClassRef));
        return { subtasks: [] };
      }),
    });
    expect(captured[0]).toEqual(['codex-fast', 'codex-fast']);
    // The evaluator omitted its observation, so the Subtask fails closed.
    expect(result.spanRouting?.subtasks[0]).toMatchObject({ status: 'fallback' });
  });

  it('records ordered subtask observations and fails closed when one is omitted', async () => {
    const result = await attachSpanRoutingObservation({
      event: planEvent([subtask('s1'), subtask('s2')]),
      configuration: kernelConfiguration(),
      executorStatuses: [],
      runtimeConfiguration: runtimeConfiguration(),
      evaluator: {
        evaluate: async ({ requests }) => ({
          subtasks: [{
            subtaskId: requests[0]!.subtaskId,
            candidateSetFingerprint: requests[0]!.candidateSetFingerprint,
            status: 'fallback',
            reason: 'span_timeout',
          }],
        }),
      },
    });
    expect(result.spanRouting?.subtasks.map(item => item.subtaskId)).toEqual(['s1', 's2']);
    expect(result.spanRouting?.subtasks[0]).toMatchObject({ status: 'fallback', reason: 'span_timeout' });
    expect(result.spanRouting?.subtasks[1]).toMatchObject({ status: 'fallback', reason: 'span_invalid_response' });
  });

  it('never stores plaintext credentials or raw provider payloads', async () => {
    const result = await attachSpanRoutingObservation({
      event: planEvent([subtask('s1')]),
      configuration: kernelConfiguration(),
      executorStatuses: [],
      runtimeConfiguration: runtimeConfiguration(),
      evaluator: adviseAll(),
    });
    const serialized = JSON.stringify(result.spanRouting);
    expect(serialized).not.toContain('file-secret');
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('sk-');
  });
});
