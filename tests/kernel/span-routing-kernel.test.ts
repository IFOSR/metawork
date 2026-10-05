import { describe, expect, it } from 'vitest';
import {
  ControlKernel,
  type KernelEvent,
  type KernelSnapshot,
} from '../../src/kernel/control-kernel.js';
import type { KernelConfigurationView } from '../../src/configuration/index.js';
import type { PlanningAgentPlan } from '../../src/planning/planning-types.js';
import type { WorkGraphProposal } from '../../src/work-graph/types.js';
import {
  planProposalFingerprint,
  planRoutingCandidateSetFingerprint,
  planSubtaskCandidateGroups,
} from '../../src/routing/plan-routing-candidates.js';
import {
  SPAN_QUESTION_VERSION,
  type SpanRoutingObservation,
} from '../../src/routing/span-routing-types.js';

const configurationRevision = 'revision-span-kernel';

const kernelConfiguration: KernelConfigurationView = {
  revisionId: configurationRevision,
  contentHash: 'sha256:span-kernel',
  agentClasses: {
    'codex-fast': {
      kind: 'executor',
      harnessRef: 'codex-harness',
      driverId: 'codex-cli',
      modelPolicy: { mode: 'auto', allowedModelRefs: ['model-fast', 'model-deep'], defaultModelRef: 'model-fast' },
      permissionProfileRef: 'workspace-default',
      routingCapabilities: ['workspace-engineering'],
      enabled: true,
      transport: 'local-cli',
      supportsProbe: true,
      supportsAbort: true,
      supportsContinuation: true,
    },
    'pi-general': {
      kind: 'executor',
      harnessRef: 'pi-harness',
      driverId: 'pi-cli',
      modelPolicy: { mode: 'auto', allowedModelRefs: ['model-fast', 'model-deep'], defaultModelRef: 'model-fast' },
      permissionProfileRef: 'workspace-default',
      routingCapabilities: ['workspace-engineering'],
      enabled: true,
      transport: 'local-cli',
      supportsProbe: true,
      supportsAbort: true,
      supportsContinuation: false,
    },
  },
  models: {
    'model-fast': {
      providerRef: 'openai',
      modelId: 'gpt-fast',
      capabilities: ['coding', 'tools'],
      reasoning: 'low',
      latencyTier: 'low',
      enabled: true,
    },
    'model-deep': {
      providerRef: 'openai',
      modelId: 'gpt-deep',
      capabilities: ['coding', 'tools'],
      reasoning: 'high',
      latencyTier: 'high',
      enabled: true,
    },
  },
  providers: { openai: { enabled: true } },
  permissionProfiles: {
    'workspace-default': { profileId: 'workspace-engineering', version: 1, parameters: {} },
  },
  runtimePolicy: {},
};

const workGraph: WorkGraphProposal = {
  schemaVersion: 7,
  configurationRevision,
  reason: 'span kernel test',
  subtasks: [{
    id: 'subtask_execute',
    title: 'Implement parser',
    goal: 'Implement the parser',
    dependencies: [],
    contextRefs: [{ kind: 'current_user_input' }],
    requiredCapabilities: ['workspace-engineering'],
    executorBindings: [
      { agentClassRef: 'codex-fast', modelSelection: { mode: 'agent-class-default' } },
      { agentClassRef: 'pi-general', modelSelection: { mode: 'agent-class-default' } },
    ],
    deliveryKind: 'edit',
    acceptance: [{ key: 'c1', description: 'Parser works', requiredEvidence: [] }],
    riskLevel: 'low',
  }],
};

const proposal: PlanningAgentPlan = {
  id: 'plan_span',
  schemaVersion: 8,
  action: 'plan_work_graph',
  confidence: 0.9,
  reason: 'span kernel test',
  clarificationQuestion: null,
  response: { directReply: null },
  task: {
    binding: 'new',
    taskId: null,
    control: 'none',
    scope: null,
    title: 'Implement parser',
    goal: 'Implement the parser',
    includeRecentConversationContext: false,
    priority: { level: 'normal', reason: 'test' },
  },
  risk: { level: 'low', requiresConfirmation: false, reasons: [] },
  authorizationResolution: null,
  workGraph,
  source: 'anyfusion-planner',
};

const event: Extract<KernelEvent, { type: 'plan_proposed' }> = {
  schemaVersion: 5,
  configurationRevision,
  type: 'plan_proposed',
  id: 'event_plan_span',
  correlationId: 'request_span',
  causationId: null,
  occurredAt: '2026-09-27T00:00:00.000Z',
  sessionId: 'session_span',
  conversationId: 'conversation_span',
  proposal,
  requestText: 'Implement the parser',
  generationId: 'generation_span',
  proposalSource: 'initial',
  targetGraphRevision: 1,
  attachmentIds: [],
};

const proposalFingerprint = planProposalFingerprint({
  task: proposal.task,
  workGraph,
});

const snapshot: KernelSnapshot = {
  schemaVersion: 5,
  type: 'plan_admission',
  tasks: [],
  runningTaskId: null,
  plannerConfiguration: {
    revisionId: configurationRevision,
    contentHash: 'sha256:planner-span',
    models: [
      { id: 'model-fast', providerRef: 'openai', capabilities: ['coding', 'tools'], reasoning: 'low', region: 'international' },
      { id: 'model-deep', providerRef: 'openai', capabilities: ['coding', 'tools'], reasoning: 'high', region: 'international' },
    ],
    routingCatalog: {
      version: 2,
      configurationRevision,
      capabilities: [
        { id: 'workspace-engineering', deliveryContract: 'Modify and verify workspace files.' },
      ],
      agentClasses: [
        {
          id: 'codex-fast',
          routingCapabilities: ['workspace-engineering'],
          capabilityPreferences: [],
          profileFingerprint: 'fp-codex',
          modelPolicy: {
            mode: 'auto',
            allowedModelRefs: ['model-fast', 'model-deep'],
            defaultModelRef: 'model-fast',
          },
        },
        {
          id: 'pi-general',
          routingCapabilities: ['workspace-engineering'],
          capabilityPreferences: [],
          profileFingerprint: 'fp-pi',
          modelPolicy: {
            mode: 'auto',
            allowedModelRefs: ['model-fast', 'model-deep'],
            defaultModelRef: 'model-fast',
          },
        },
      ],
    },
  },
  kernelConfiguration,
  executorStatuses: [],
  v5WorkGraphTaskIds: [],
  eligibleContextRefKeys: ['current_user_input'],
  pendingAuthorizationRequest: null,
};

function subtaskCandidates() {
  const groups = planSubtaskCandidateGroups({
    configuration: kernelConfiguration,
    subtask: workGraph.subtasks[0]!,
  });
  return groups.flatMap(group => group.eligible.map(candidate => ({
    agentClassRef: group.agentClassRef,
    providerRef: candidate.providerRef,
    modelRef: candidate.modelRef,
  })));
}

function observation(
  probabilities: Record<string, number>,
  overrides: Partial<SpanRoutingObservation> = {},
): SpanRoutingObservation {
  const eligible = subtaskCandidates();
  return {
    schemaVersion: 1,
    policyVersion: 'span-routing-v1',
    questionVersion: SPAN_QUESTION_VERSION,
    model: 'inception/mercury-decide:free',
    eventId: event.id,
    proposalFingerprint,
    configurationRevision,
    generationId: event.generationId,
    targetGraphRevision: event.targetGraphRevision,
    usage: { inputTokens: 10, outputTokens: 0, cost: 0 },
    subtasks: [{
      subtaskId: 'subtask_execute',
      candidateSetFingerprint: planRoutingCandidateSetFingerprint(eligible),
      status: 'advised',
      resolvedModel: 'inception/mercury-decide-20260930',
      candidates: eligible.map((identity, index) => ({
        candidateId: `c${String(index).padStart(3, '0')}`,
        ...identity,
        probability: probabilities[`${identity.agentClassRef}:${identity.modelRef}`] ?? 0.5,
      })),
    }],
    ...overrides,
  };
}

function decide(spanRouting?: SpanRoutingObservation) {
  const kernel = new ControlKernel();
  const decision = kernel.decide(
    spanRouting ? { ...event, spanRouting } : event,
    snapshot,
  );
  if (decision.action.type !== 'authorize_task_plan') {
    throw new Error(`unexpected decision: ${decision.action.type} (${decision.reason})`);
  }
  return decision.action;
}

describe('ControlKernel Span routing consumption', () => {
  it('keeps the deterministic order and Model when no observation exists', () => {
    const action = decide();
    expect(action.authorizedBindingsBySubtask.subtask_execute!.map(binding => binding.agentClassRef))
      .toEqual(['codex-fast', 'pi-general']);
    expect(action.authorizedBindingsBySubtask.subtask_execute!.map(binding => binding.modelRef))
      .toEqual(['model-fast', 'model-fast']);
    expect(action.routing.subtask_execute!.every(audit => audit.policyVersion === 'auto-model-routing-v2'))
      .toBe(true);
    expect(action.routing.subtask_execute![0]!.spanRouting).toBeUndefined();
  });

  it('reorders only already-authorized bindings by validated probability', () => {
    const action = decide(observation({
      'codex-fast:model-fast': 0.2,
      'codex-fast:model-deep': 0.1,
      'pi-general:model-fast': 0.9,
      'pi-general:model-deep': 0.8,
    }));
    expect(action.authorizedBindingsBySubtask.subtask_execute!.map(binding => binding.agentClassRef))
      .toEqual(['pi-general', 'codex-fast']);
    expect(action.authorizedBindingsBySubtask.subtask_execute!.map(binding => binding.modelRef))
      .toEqual(['model-fast', 'model-fast']);
    expect(action.routing.subtask_execute![0]!.policyVersion).toBe('span-routing-v2');
    expect(action.routing.subtask_execute![0]!.spanRouting).toMatchObject({
      applied: true,
      probabilities: { 'model-fast': 0.9, 'model-deep': 0.8 },
    });
  });

  it('uses probability to pick the winning Model inside an AgentClass', () => {
    const action = decide(observation({
      'codex-fast:model-fast': 0.1,
      'codex-fast:model-deep': 0.95,
      'pi-general:model-fast': 0.2,
      'pi-general:model-deep': 0.3,
    }));
    expect(action.authorizedBindingsBySubtask.subtask_execute!.map(binding => binding.agentClassRef))
      .toEqual(['codex-fast', 'pi-general']);
    expect(action.authorizedBindingsBySubtask.subtask_execute![0]!.modelRef).toBe('model-deep');
    expect(action.authorizedBindingsBySubtask.subtask_execute![1]!.modelRef).toBe('model-deep');
  });

  it('is deterministic for the same event and snapshot', () => {
    const withObservation = observation({
      'codex-fast:model-fast': 0.2,
      'codex-fast:model-deep': 0.1,
      'pi-general:model-fast': 0.9,
      'pi-general:model-deep': 0.8,
    });
    const kernel = new ControlKernel();
    const first = kernel.decide({ ...event, spanRouting: withObservation }, snapshot);
    const second = kernel.decide({ ...event, spanRouting: withObservation }, snapshot);
    expect(first).toEqual(second);
  });

  it('rejects observations made under the former tag-oriented question contract', () => {
    const old = observation({
      'codex-fast:model-fast': 0.01, 'codex-fast:model-deep': 0.01,
      'pi-general:model-fast': 0.01, 'pi-general:model-deep': 0.97,
    });
    const action = decide({ ...old, questionVersion: 'span-fit-v4' } as unknown as SpanRoutingObservation);
    expect(action.routing.subtask_execute![0]!.spanRouting).toMatchObject({ applied: false, reason: 'stale_observation' });
    expect(action.authorizedBindingsBySubtask.subtask_execute![0]!.agentClassRef).toBe('codex-fast');
  });

  it('ignores an observation bound to a different event', () => {
    const action = decide(observation(
      { 'codex-fast:model-fast': 0.2, 'pi-general:model-fast': 0.9 },
      { eventId: 'event_other' },
    ));
    expect(action.authorizedBindingsBySubtask.subtask_execute!.map(binding => binding.agentClassRef))
      .toEqual(['codex-fast', 'pi-general']);
    expect(action.routing.subtask_execute![0]!.spanRouting).toMatchObject({
      applied: false,
      reason: 'stale_observation',
    });
  });

  it('ignores an observation whose candidate set no longer matches', () => {
    const action = decide(observation(
      { 'codex-fast:model-fast': 0.2, 'pi-general:model-fast': 0.9 },
      { subtasks: [{
        subtaskId: 'subtask_execute',
        candidateSetFingerprint: 'stale-fingerprint',
        status: 'advised',
        resolvedModel: 'inception/mercury-decide-20260930',
        candidates: [],
      }] },
    ));
    expect(action.routing.subtask_execute![0]!.spanRouting).toMatchObject({
      applied: false,
      reason: 'candidate_set_changed',
    });
  });

  it('fails closed when a probability is missing for an eligible candidate', () => {
    const incomplete = observation({ 'codex-fast:model-fast': 0.9, 'pi-general:model-fast': 0.9 });
    const subtask = incomplete.subtasks[0]!;
    if (subtask.status !== 'advised') throw new Error('expected advised');
    subtask.candidates = subtask.candidates.slice(0, 1);
    const action = decide(incomplete);
    expect(action.routing.subtask_execute![0]!.spanRouting).toMatchObject({
      applied: false,
      reason: 'incomplete_probabilities',
    });
  });

  it('ignores an out-of-range probability instead of trusting it', () => {
    const invalid = observation({ 'codex-fast:model-fast': 0.2, 'pi-general:model-fast': 0.9 });
    const subtask = invalid.subtasks[0]!;
    if (subtask.status !== 'advised') throw new Error('expected advised');
    subtask.candidates[0]!.probability = 5;
    const action = decide(invalid);
    expect(action.routing.subtask_execute![0]!.spanRouting).toMatchObject({
      applied: false,
      reason: 'candidate_identity_mismatch',
    });
  });

  it('honours a skipped Subtask observation as an explicit fallback', () => {
    const action = decide(observation(
      { 'codex-fast:model-fast': 0.2, 'pi-general:model-fast': 0.9 },
      { subtasks: [{ subtaskId: 'subtask_execute', status: 'skipped', reason: 'single_candidate' }] },
    ));
    expect(action.authorizedBindingsBySubtask.subtask_execute!.map(binding => binding.agentClassRef))
      .toEqual(['codex-fast', 'pi-general']);
    expect(action.routing.subtask_execute![0]!.spanRouting).toMatchObject({
      applied: false,
      reason: 'single_candidate',
    });
  });

  it('never lets Span pick a Model the AgentClass policy excludes', () => {
    const narrowedConfiguration: KernelConfigurationView = {
      ...kernelConfiguration,
      agentClasses: {
        ...kernelConfiguration.agentClasses,
        'pi-general': {
          ...kernelConfiguration.agentClasses['pi-general']!,
          modelPolicy: { mode: 'auto', allowedModelRefs: ['model-fast'] },
        },
      },
    };
    const kernel = new ControlKernel();
    const decision = kernel.decide(
      { ...event, spanRouting: observation({
        'codex-fast:model-fast': 0.2,
        'codex-fast:model-deep': 0.1,
        'pi-general:model-fast': 0.3,
        'pi-general:model-deep': 1,
      }) },
      { ...snapshot, kernelConfiguration: narrowedConfiguration },
    );
    if (decision.action.type !== 'authorize_task_plan') throw new Error(decision.reason);
    const pi = decision.action.authorizedBindingsBySubtask.subtask_execute!
      .find(binding => binding.agentClassRef === 'pi-general');
    expect(pi?.modelRef).toBe('model-fast');
  });
});
