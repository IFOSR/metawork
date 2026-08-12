import { describe, expect, it } from 'vitest';
import type { PlannerConfigurationView } from '../../src/configuration/index.js';
import { validatePlanningAgentPlan } from '../../src/planning/planning-agent-plan-validator.js';
import type { PlanningAgentPlan, SubtaskProposal } from '../../src/planning/planning-types.js';

const configuration: PlannerConfigurationView = {
  revisionId: 'revision-2026-08-12',
  contentHash: 'sha256:planner-view',
  models: [
    {
      id: 'engineering-model',
      capabilities: ['coding', 'tools'],
      reasoning: 'high',
      region: 'international',
    },
    {
      id: 'review-model',
      capabilities: ['coding', 'tools'],
      reasoning: 'medium',
      region: 'international',
    },
  ],
  routingCatalog: {
    version: 2,
    configurationRevision: 'revision-2026-08-12',
    capabilities: [
      {
        id: 'current-web-research',
        deliveryContract: 'Research public web sources.',
      },
      {
        id: 'workspace-engineering',
        deliveryContract: 'Modify and verify workspace files.',
      },
    ],
    agentClasses: [
      {
        id: 'fixed-engineering',
        routingCapabilities: ['workspace-engineering'],
        primaryUseCases: ['implementation'],
        avoidUseCases: [],
        affordances: ['workspace-command-validation', 'workspace-read-write'],
        modelPolicy: { mode: 'fixed', modelRef: 'engineering-model' },
      },
      {
        id: 'auto-engineering',
        routingCapabilities: ['workspace-engineering'],
        primaryUseCases: ['implementation and review'],
        avoidUseCases: [],
        affordances: ['workspace-command-validation', 'workspace-read-write'],
        modelPolicy: {
          mode: 'auto',
          allowedModelRefs: ['engineering-model', 'review-model'],
          defaultModelRef: 'engineering-model',
        },
      },
    ],
  },
};

function binding(
  agentClassRef = 'fixed-engineering',
  modelSelection: SubtaskProposal['executorBindings'][number]['modelSelection'] = {
    mode: 'fixed-by-agent-class',
  },
): SubtaskProposal['executorBindings'][number] {
  return { agentClassRef, modelSelection };
}

function subtask(overrides: Partial<SubtaskProposal> = {}): SubtaskProposal {
  return {
    id: 'impl',
    title: 'Implement',
    goal: 'Implement and verify the change',
    dependencies: [],
    contextRefs: [{ kind: 'current_user_input' }],
    requiredCapabilities: ['workspace-engineering'],
    executorBindings: [binding()],
    deliveryKind: 'edit',
    acceptance: [{ key: 'tests_pass', description: 'tests pass', requiredEvidence: ['test result'] }],
    riskLevel: 'low',
    ...overrides,
  };
}

function plan(subtasks: SubtaskProposal[] = [subtask()]): PlanningAgentPlan {
  return {
    id: 'plan_1',
    schemaVersion: 8,
    action: 'plan_work_graph',
    confidence: 0.9,
    reason: 'work is required',
    clarificationQuestion: null,
    response: { directReply: null },
    task: {
      binding: 'new',
      taskId: null,
      control: 'none',
      scope: null,
      title: 'Implement change',
      goal: 'Implement and test the requested change',
      includeRecentConversationContext: false,
      priority: { level: 'normal', reason: 'normal scheduling' },
    },
    risk: { level: 'low', requiresConfirmation: false, reasons: [] },
    authorizationResolution: null,
    workGraph: {
      schemaVersion: 7,
      configurationRevision: configuration.revisionId,
      reason: 'capability-minimal work graph',
      subtasks,
    },
    source: 'anyfusion-planner',
  };
}

describe('validatePlanningAgentPlan', () => {
  it('accepts a revision-scoped capability-minimal work graph', () => {
    expect(validatePlanningAgentPlan(plan(), configuration)).toEqual({ valid: true, errors: [] });
  });

  it('rejects empty and exact duplicate routing bindings', () => {
    const emptyCandidate = plan([
      subtask({ requiredCapabilities: [] as never }),
    ]);
    expect(validatePlanningAgentPlan(emptyCandidate, configuration)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.stringContaining('requiredCapabilities'),
      ]),
    });

    const duplicateCandidate = plan([
      subtask({ executorBindings: [binding(), binding()] }),
    ]);
    expect(validatePlanningAgentPlan(duplicateCandidate, configuration)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        'subtask impl contains duplicate executor binding: fixed-engineering:fixed-by-agent-class',
      ]),
    });
  });

  it('allows the same AgentClass with distinct proposed Models in fallback order', () => {
    const candidate = plan([
      subtask({
        executorBindings: [
          binding('auto-engineering', {
            mode: 'proposed',
            modelRef: 'engineering-model',
            reason: 'primary implementation model',
          }),
          binding('auto-engineering', {
            mode: 'proposed',
            modelRef: 'review-model',
            reason: 'secondary review model',
          }),
        ],
      }),
    ]);

    expect(validatePlanningAgentPlan(candidate, configuration)).toEqual({ valid: true, errors: [] });
  });

  it('rejects AgentClasses unavailable in the pinned revision', () => {
    const candidate = plan([
      subtask({ executorBindings: [binding('research')] }),
    ]);

    expect(validatePlanningAgentPlan(candidate, configuration).errors).toContain(
      'subtask impl references unavailable AgentClass in revision revision-2026-08-12: research',
    );
  });

  it('accepts an ordered subset of eligible bindings instead of requiring the full catalog', () => {
    const candidate = plan([
      subtask({
        executorBindings: [binding('auto-engineering', {
          mode: 'proposed',
          modelRef: 'review-model',
          reason: 'review-oriented model',
        })],
      }),
    ]);

    expect(validatePlanningAgentPlan(candidate, configuration)).toEqual({ valid: true, errors: [] });
  });

  it('requires every binding to cover all required Routing Capabilities', () => {
    const candidate = plan([
      subtask({
        requiredCapabilities: ['current-web-research', 'workspace-engineering'],
      }),
    ]);

    expect(validatePlanningAgentPlan(candidate, configuration).errors).toEqual(expect.arrayContaining([
      'no_capable_agent_class: subtask impl must be split at a Routing Capability handoff',
      'subtask impl AgentClass fixed-engineering does not cover required capabilities: current-web-research',
    ]));
  });

  it('rejects a graph pinned to a different configuration revision', () => {
    const candidate = plan();
    candidate.workGraph!.configurationRevision = 'revision-stale';

    expect(validatePlanningAgentPlan(candidate, configuration).errors).toContain(
      'work graph configurationRevision revision-stale does not match Planner configuration revision revision-2026-08-12',
    );
  });

  it('rejects a Planner view whose catalog belongs to another revision', () => {
    const mismatchedConfiguration: PlannerConfigurationView = {
      ...configuration,
      routingCatalog: {
        ...configuration.routingCatalog,
        configurationRevision: 'revision-stale',
      },
    };

    expect(validatePlanningAgentPlan(plan(), mismatchedConfiguration).errors).toContain(
      'Planner configuration view revision revision-2026-08-12 does not match routing catalog revision revision-stale',
    );
  });

  it('enforces fixed and auto ModelPolicy selection modes', () => {
    const fixedProposed = plan([
      subtask({
        executorBindings: [binding('fixed-engineering', {
          mode: 'proposed',
          modelRef: 'engineering-model',
          reason: 'attempt to override fixed policy',
        })],
      }),
    ]);
    const autoFixed = plan([
      subtask({
        executorBindings: [binding('auto-engineering')],
      }),
    ]);

    expect(validatePlanningAgentPlan(fixedProposed, configuration).errors).toContain(
      'subtask impl AgentClass fixed-engineering uses fixed ModelPolicy and requires fixed-by-agent-class selection',
    );
    expect(validatePlanningAgentPlan(autoFixed, configuration).errors).toContain(
      'subtask impl AgentClass auto-engineering uses auto ModelPolicy and cannot use fixed-by-agent-class selection',
    );
  });

  it('rejects proposed Models outside the revision-scoped ModelPolicy', () => {
    const candidate = plan([
      subtask({
        executorBindings: [binding('auto-engineering', {
          mode: 'proposed',
          modelRef: 'unlisted-model',
          reason: 'not authorized by policy',
        })],
      }),
    ]);

    expect(validatePlanningAgentPlan(candidate, configuration).errors).toEqual(expect.arrayContaining([
      'subtask impl references unavailable Model in revision revision-2026-08-12: unlisted-model',
      'subtask impl Model unlisted-model is not allowed by AgentClass auto-engineering',
    ]));
  });

  it('rejects agent-class-default when the auto policy has no explicit default', () => {
    const noDefaultConfiguration: PlannerConfigurationView = {
      ...configuration,
      routingCatalog: {
        ...configuration.routingCatalog,
        agentClasses: configuration.routingCatalog.agentClasses.map(agentClass =>
          agentClass.id === 'auto-engineering'
            ? {
                ...agentClass,
                modelPolicy: {
                  mode: 'auto' as const,
                  allowedModelRefs: ['engineering-model', 'review-model'],
                },
              }
            : agentClass),
      },
    };
    const candidate = plan([
      subtask({
        executorBindings: [binding('auto-engineering', { mode: 'agent-class-default' })],
      }),
    ]);

    expect(validatePlanningAgentPlan(candidate, noDefaultConfiguration).errors).toContain(
      'subtask impl AgentClass auto-engineering has no default Model',
    );
  });

  it('rejects fixed or default Models unavailable in the pinned revision', () => {
    const missingModels: PlannerConfigurationView = {
      ...configuration,
      models: [],
    };
    const autoDefault = plan([
      subtask({
        executorBindings: [binding('auto-engineering', { mode: 'agent-class-default' })],
      }),
    ]);

    expect(validatePlanningAgentPlan(plan(), missingModels).errors).toContain(
      'subtask impl references unavailable Model in revision revision-2026-08-12: engineering-model',
    );
    expect(validatePlanningAgentPlan(autoDefault, missingModels).errors).toContain(
      'subtask impl references unavailable Model in revision revision-2026-08-12: engineering-model',
    );
  });

  it('includes pure work-graph structure violations', () => {
    const candidate = plan([
      subtask({ id: 'a' }),
      subtask({
        id: 'b',
        executorBindings: [binding('auto-engineering', { mode: 'agent-class-default' })],
        dependencies: [{
          fromSubtaskId: 'missing',
          requiredItems: [{ key: 'result', type: 'text', description: 'upstream result' }],
        }],
      }),
    ]);

    expect(validatePlanningAgentPlan(candidate, configuration).errors).toContain(
      'unknown_dependency: subtasks.1.dependencies.0.fromSubtaskId: subtask b depends on unknown subtask missing',
    );
  });

  it('rejects a mergeable same-AgentClass chain through shared Work Graph validation', () => {
    const candidate = plan([
      subtask({ id: 'implement' }),
      subtask({
        id: 'verify',
        dependencies: [{
          fromSubtaskId: 'implement',
          requiredItems: [{ key: 'result', type: 'text', description: 'implementation result' }],
        }],
      }),
    ]);

    expect(validatePlanningAgentPlan(candidate, configuration).errors).toContain(
      'mergeable_same_agent_chain: subtasks.1.dependencies.0: subtasks implement -> verify form a mergeable fixed-engineering single chain',
    );
  });
});
