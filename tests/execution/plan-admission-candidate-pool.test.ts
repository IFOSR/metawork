import { describe, expect, it } from 'vitest';
import { authorizePlanAdmission, type PlanAdmissionRequest, type PlanAdmissionSnapshot } from '../../src/execution/plan-admission-policy.js';
import type { ControlConfigurationView } from '../../src/configuration/index.js';
import type { PlanningAgentPlan } from '../../src/planning/planning-types.js';
import type { WorkGraphProposal } from '../../src/work-graph/types.js';
import { workspaceIntentFixture } from '../support/planning-agent-plans.js';

/**
 * ADR-0055 D6: admission keeps the hard-eligible Router candidate pool and
 * never selects a binding itself. There is no pre-admission Span scoring and no
 * Manager-supplied preference; every hard-eligible AgentClass/Provider/Model
 * binding survives admission so the single Router can choose at dispatch.
 */

const configurationRevision = 'revision-candidate-pool';

const kernelConfiguration: ControlConfigurationView = {
  revisionId: configurationRevision,
  contentHash: 'sha256:candidate-pool',
  agentClasses: {
    'codex-fast': {
      kind: 'executor',
      harnessRef: 'codex-harness',
      driverId: 'pi-cli',
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
  reason: 'candidate pool test',
  subtasks: [{
    id: 'subtask_execute',
    title: 'Implement parser',
    goal: 'Implement the parser',
    dependencies: [],
    contextRefs: [{ kind: 'current_user_input' }],
    requiredCapabilities: ['workspace-engineering'],
    deliveryKind: 'edit',
    fileOutputs: [],
    acceptance: [{ key: 'c1', description: 'Parser works', requiredEvidence: [] }],
    riskLevel: 'low',
  }],
};

const proposal: PlanningAgentPlan = {
  id: 'plan_candidate_pool',
  schemaVersion: 9,
  action: 'plan_work_graph',
  confidence: 0.9,
  reason: 'candidate pool test',
  clarificationQuestion: null,
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
  workspaceIntent: workspaceIntentFixture({ targetPaths: ['workspace-target'] }),
  workGraph,
  source: 'anyfusion-planner',
};

const event: PlanAdmissionRequest = {
  configurationRevision,
  id: 'event_plan_candidate_pool',
  occurredAt: '2026-09-27T00:00:00.000Z',
  sessionId: 'session_pool',
  conversationId: 'conversation_pool',
  proposal,
  requestText: 'Implement the parser',
  generationId: 'generation_pool',
  proposalSource: 'initial',
  targetGraphRevision: 1,
  attachmentIds: [],
  workspaceAdmission: {
    targetWorkspace: { workspaceId: 'workspace_pool', canonicalPath: '/workspace' },
  },
};

const snapshot: PlanAdmissionSnapshot = {

  tasks: [],
  runningTaskId: null,
  plannerConfiguration: {
    revisionId: configurationRevision,
    contentHash: 'sha256:planner-pool',
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
  configuration: kernelConfiguration,
  executorStatuses: [],
  v5WorkGraphTaskIds: [],
  eligibleContextRefKeys: ['current_user_input'],
  pendingAuthorizationRequest: null,
};

function decide(
  request: PlanAdmissionRequest = event,
  admissionSnapshot: PlanAdmissionSnapshot = snapshot,
) {
  const decision = authorizePlanAdmission(request, admissionSnapshot);
  if (decision.status !== 'authorized') {
    throw new Error(`unexpected decision: ${decision.status} (${decision.reason})`);
  }
  return decision;
}

describe('Plan admission Router candidate pool', () => {
  it('keeps every hard-eligible binding instead of selecting one', () => {
    const action = decide();
    const bindings = action.authorizedBindingsBySubtask.subtask_execute!;
    // Stable configuration order: AgentClass by ref, then model ref.
    expect(bindings.map(binding => `${binding.agentClassRef}:${binding.modelRef}`)).toEqual([
      'codex-fast:model-deep',
      'codex-fast:model-fast',
      'pi-general:model-deep',
      'pi-general:model-fast',
    ]);
    // The audit records hard eligibility only: no score, no Span observation,
    // and no policy that claims the choice was already made.
    expect(action.routing.subtask_execute!.every(audit =>
      audit.policyVersion === 'router-hard-eligibility-v1'
      && audit.scoreBreakdown === null
      && audit.spanRouting === undefined)).toBe(true);
  });

  it('is deterministic for the same request and snapshot', () => {
    expect(authorizePlanAdmission(event, snapshot)).toEqual(authorizePlanAdmission(event, snapshot));
  });

  it('rejects Manager-supplied selection fields instead of letting them narrow the pool', () => {
    // A Manager proposal may only describe work. Selection-shaped keys are not
    // part of the strict proposal contract, so they fail validation rather than
    // silently pre-empting the Router.
    const tampered = {
      ...proposal,
      executorBindings: [{ agentClassRef: 'pi-general', providerRef: 'openai', modelRef: 'model-deep' }],
      modelSelection: { agentClassRef: 'pi-general', modelRef: 'model-deep' },
    } as PlanningAgentPlan;
    const decision = authorizePlanAdmission({ ...event, proposal: tampered }, snapshot);
    expect(decision.status).toBe('rejected');
    expect(decision.reason).toContain('Unrecognized keys');
    expect(decision.reason).toContain('executorBindings');
    expect(decision.reason).toContain('modelSelection');
  });

  it('drops only the unavailable AgentClass from the pool', () => {
    const action = decide(event, {
      ...snapshot,
      executorStatuses: [{
        agentClassName: 'codex-fast',
        classHealth: 'disabled',
        recentAttempts: [],
        recentRecoveryChecks: [],
        updatedAt: '2026-09-26T23:00:00.000Z',
      }],
    });
    expect(action.authorizedBindingsBySubtask.subtask_execute!.map(binding => `${binding.agentClassRef}:${binding.modelRef}`))
      .toEqual(['pi-general:model-deep', 'pi-general:model-fast']);
  });

  it('defers a replan when no healthy AgentClass remains instead of falling back', () => {
    const replan: PlanAdmissionRequest = {
      ...event,
      proposalSource: 'replan',
      targetGraphRevision: 2,
      proposal: { ...proposal, task: { ...proposal.task, binding: 'reference', taskId: 'task_existing' } },
    };
    const decision = authorizePlanAdmission(replan, {
      ...snapshot,
      tasks: [{ id: 'task_existing', status: 'needs_action', conversationId: 'conversation_pool' }],
      executorStatuses: ['codex-fast', 'pi-general'].map(agentClassName => ({
        agentClassName,
        classHealth: 'disabled' as const,
        recentAttempts: [],
        recentRecoveryChecks: [],
        updatedAt: '2026-09-26T23:00:00.000Z',
      })),
    });
    expect(decision.status).toBe('deferred');
    if (decision.status !== 'deferred') return;
    // The deferred pool is retained so recovery can resume the same candidates.
    expect(decision.authorizedBindingsBySubtask.subtask_execute).toHaveLength(4);
    expect(decision.unavailableAgentClassNames).toEqual(['codex-fast', 'pi-general']);
  });

  it('never authorizes a Model the AgentClass policy excludes', () => {
    const narrowed: ControlConfigurationView = {
      ...kernelConfiguration,
      agentClasses: {
        ...kernelConfiguration.agentClasses,
        'pi-general': {
          ...kernelConfiguration.agentClasses['pi-general']!,
          modelPolicy: { mode: 'auto', allowedModelRefs: ['model-fast'] },
        },
      },
    };
    const action = decide(event, { ...snapshot, configuration: narrowed });
    expect(action.authorizedBindingsBySubtask.subtask_execute!
      .filter(binding => binding.agentClassRef === 'pi-general')
      .map(binding => binding.modelRef)).toEqual(['model-fast']);
  });

  it('rejects a Subtask whose capabilities no AgentClass satisfies', () => {
    // Both configured AgentClasses lose the required Routing Capability, so the
    // Subtask has no hard-eligible binding at all.
    const withoutCapability: ControlConfigurationView = {
      ...kernelConfiguration,
      agentClasses: Object.fromEntries(Object.entries(kernelConfiguration.agentClasses).map(
        ([ref, agentClass]) => [ref, { ...agentClass, routingCapabilities: [] }],
      )),
    };
    const decision = authorizePlanAdmission(event, { ...snapshot, configuration: withoutCapability });
    expect(decision.status).toBe('rejected');
    expect(decision.reason).toContain('no authorized executor binding');
  });
});
