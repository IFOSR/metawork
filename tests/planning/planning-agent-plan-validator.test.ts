import { describe, expect, it } from 'vitest';
import { getPlannerExecutorCatalog } from '../../src/executor/builtin-executor-catalog.js';
import { validatePlanningAgentPlan } from '../../src/planning/planning-agent-plan-validator.js';
import type { PlanningAgentPlan, SubtaskProposal } from '../../src/planning/planning-types.js';

const catalog = getPlannerExecutorCatalog();

function subtask(overrides: Partial<SubtaskProposal> = {}): SubtaskProposal {
  return {
    id: 'impl',
    title: 'Implement',
    goal: 'Implement and verify the change',
    dependsOn: [],
    requiredCapabilities: ['workspace-engineering'],
    preferredAgentClassList: ['codex-cli'],
    expectedOutput: 'patch',
    acceptance: ['tests pass'],
    riskLevel: 'low',
    ...overrides,
  };
}

function plan(subtasks: SubtaskProposal[] = [subtask()]): PlanningAgentPlan {
  return {
    id: 'plan_1',
    schemaVersion: 3,
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
    workGraph: { reason: 'capability-minimal work graph', subtasks },
    source: 'codex-planner',
  };
}

describe('validatePlanningAgentPlan', () => {
  it('accepts a capability-minimal canonical work graph', () => {
    expect(validatePlanningAgentPlan(plan(), catalog)).toEqual({ valid: true, errors: [] });
  });

  it('rejects empty and duplicate routing lists', () => {
    const emptyCandidate = plan([
      subtask({
        requiredCapabilities: [] as never,
      }),
    ]);
    expect(validatePlanningAgentPlan(emptyCandidate, catalog)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.stringContaining('requiredCapabilities'),
      ]),
    });

    const duplicateCandidate = plan([
      subtask({
        preferredAgentClassList: ['codex-cli', 'codex-cli'],
      }),
    ]);

    expect(validatePlanningAgentPlan(duplicateCandidate, catalog)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        'subtask impl contains duplicate preferred AgentClass: codex-cli',
      ]),
    });
  });

  it('requires every preferred AgentClass to cover every required capability', () => {
    const candidate = plan([
      subtask({ preferredAgentClassList: ['pi-agent'] }),
    ]);

    expect(validatePlanningAgentPlan(candidate, catalog).errors).toEqual(expect.arrayContaining([
      'subtask impl AgentClass pi-agent does not cover required capabilities: workspace-engineering',
      'subtask impl preferred AgentClass set must equal eligible canonical set: codex-cli',
    ]));
  });

  it('requires the complete eligible canonical set while preserving Planner ordering freedom', () => {
    const expandedCatalog = {
      ...catalog,
      executors: catalog.executors.map(executor => executor.name === 'pi-agent'
        ? { ...executor, routingCapabilities: ['workspace-engineering'] as const }
        : executor),
    };
    const candidate = plan();

    expect(validatePlanningAgentPlan(candidate, expandedCatalog).errors).toContain(
      'subtask impl preferred AgentClass set must equal eligible canonical set: codex-cli, pi-agent',
    );

    candidate.workGraph!.subtasks[0].preferredAgentClassList = ['pi-agent', 'codex-cli'];
    expect(validatePlanningAgentPlan(candidate, expandedCatalog)).toEqual({ valid: true, errors: [] });
  });

  it('reports no capable AgentClass when a capability union requires a handoff', () => {
    const candidate = plan([
      subtask({
        requiredCapabilities: ['current-web-research', 'workspace-engineering'],
        preferredAgentClassList: ['codex-cli'],
      }),
    ]);

    expect(validatePlanningAgentPlan(candidate, catalog).errors).toContain(
      'no_capable_agent_class: subtask impl must be split at a Routing Capability handoff',
    );
  });

  it('includes pure work-graph structure violations', () => {
    const candidate = plan([
      subtask({ id: 'a' }),
      subtask({ id: 'b', dependsOn: ['a'] }),
    ]);

    expect(validatePlanningAgentPlan(candidate, catalog).errors).toContain(
      'mergeable_same_agent_chain: subtasks a -> b form a mergeable codex-cli single chain',
    );
  });
});
