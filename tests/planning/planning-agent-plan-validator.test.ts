import { describe, expect, it } from 'vitest';
import type { PlannerConfigurationView } from '../../src/configuration/index.js';
import { validatePlanningAgentPlan } from '../../src/planning/planning-agent-plan-validator.js';
import type { PlanningAgentPlan, SubtaskProposal } from '../../src/planning/planning-types.js';

const configuration: PlannerConfigurationView = {
  revisionId: 'revision-1', contentHash: 'sha256:planner-view', models: [],
  routingCatalog: {
    version: 2, configurationRevision: 'revision-1',
    capabilities: [{ id: 'workspace-engineering', deliveryContract: 'Modify workspace files.' },
      { id: 'current-web-research', deliveryContract: 'Research public sources.' }],
    agentClasses: [{ id: 'engineering', routingCapabilities: ['workspace-engineering'],
      primaryUseCases: ['implementation'], avoidUseCases: [], affordances: [],
      modelPolicy: { mode: 'fixed', modelRef: 'engineering-model' } }],
  },
};

function subtask(overrides: Partial<SubtaskProposal> = {}): SubtaskProposal {
  return { id: 'impl', title: 'Implement', goal: 'Implement and verify', dependencies: [],
    contextRefs: [{ kind: 'current_user_input' }], requiredCapabilities: ['workspace-engineering'],
    deliveryKind: 'edit', fileOutputs: ['report.md'],
    acceptance: [{ key: 'verified', description: 'Requested content is present', requiredEvidence: ['file contents'] }],
    riskLevel: 'low', ...overrides };
}

function plan(subtasks = [subtask()]): PlanningAgentPlan {
  return { id: 'plan-1', schemaVersion: 9, action: 'plan_work_graph', confidence: 0.9,
    reason: 'User requested a file', clarificationQuestion: null,
    task: { binding: 'new', taskId: null, control: 'none', scope: null, title: 'Create report',
      goal: 'Deliver the requested report', includeRecentConversationContext: false,
      priority: { level: 'normal', reason: 'User request' } },
    risk: { level: 'low', requiresConfirmation: false, reasons: [] }, authorizationResolution: null,
    workspaceIntent: { targetWorkspaceId: null, targetPaths: ['report.md'], operation: 'create_in_target',
      confidence: 0.9, reason: 'User requested this target file' },
    workGraph: { schemaVersion: 7, configurationRevision: configuration.revisionId,
      reason: 'Capability-minimal work', subtasks }, source: 'anyfusion-planner' };
}

function runPlan(workspaceEffect: SubtaskProposal['workspaceEffect']): PlanningAgentPlan {
  const candidate = plan([subtask({
    deliveryKind: 'report', fileOutputs: [], workspaceEffect,
  })]);
  candidate.workspaceIntent = {
    ...candidate.workspaceIntent!,
    operation: 'run_in_target',
    targetPaths: ['price-in-service/'],
    reason: '停止 8000 端口的服务',
  };
  return candidate;
}

// ADR-0055: Manager proposes semantics/capabilities. Runtime admission and Router
// own bindings/models; the retired schema-8 selection tests cannot certify v9.
describe('validatePlanningAgentPlan schema 9', () => {
  it('accepts a capability-only proposal without selecting an Executor or Model', () => {
    expect(validatePlanningAgentPlan(plan(), configuration)).toEqual({ valid: true, errors: [] });
  });

  it('rejects a run_in_target plan whose subtasks are all shared readers', () => {
    // Running or terminating a process needs exclusive Workspace access even
    // when it changes no file (2026-11-11: "stop the service" was admitted as a
    // read plan and rejected deep in admission with an internal invariant).
    const errors = validatePlanningAgentPlan(runPlan('read_only'), configuration).errors;
    expect(errors.join('\n')).toContain('run_in_target requires at least one subtask');
  });

  it('accepts a run_in_target plan that declares exclusive access without file outputs', () => {
    expect(validatePlanningAgentPlan(runPlan('write'), configuration))
      .toEqual({ valid: true, errors: [] });
  });

  it('tolerates the retired originalFilePolicy on a persisted proposal', () => {
    const candidate = plan();
    candidate.workspaceIntent = {
      ...candidate.workspaceIntent!,
      originalFilePolicy: 'unknown',
    } as PlanningAgentPlan['workspaceIntent'];
    expect(validatePlanningAgentPlan(candidate, configuration)).toEqual({ valid: true, errors: [] });
  });

  it.each(['executorBindings', 'agentClassRef', 'modelRef'])('rejects Manager-owned %s at the exact subtask path', key => {
    const candidate = plan();
    Object.assign(candidate.workGraph!.subtasks[0], { [key]: [] });
    expect(validatePlanningAgentPlan(candidate, configuration).errors).toEqual([
      `workGraph.subtasks.0: Unrecognized key: "${key}"`,
    ]);
  });

  it('reports the invalid nested graph field without rejecting valid workspaceIntent', () => {
    const candidate = plan();
    Object.assign(candidate.workGraph!, { subtasksOrderHint: ['impl'] });
    expect(validatePlanningAgentPlan(candidate, configuration).errors).toEqual([
      'workGraph: Unrecognized key: "subtasksOrderHint"',
    ]);
  });

  it('rejects the retired direct response envelope', () => {
    expect(validatePlanningAgentPlan({ ...plan(), response: { directReply: null } }, configuration).errors)
      .toEqual(['plan: Unrecognized key: "response"']);
  });

  it('rejects an empty required capability list', () => {
    expect(validatePlanningAgentPlan(plan([subtask({ requiredCapabilities: [] })]), configuration).errors)
      .toEqual([expect.stringContaining('workGraph.subtasks.0.requiredCapabilities')]);
  });

  it('rejects duplicate required capabilities', () => {
    expect(validatePlanningAgentPlan(plan([subtask({ requiredCapabilities: ['workspace-engineering', 'workspace-engineering'] })]), configuration).errors)
      .toContain('subtask impl contains duplicate Routing Capability: workspace-engineering');
  });

  it('requires one eligible AgentClass to cover every capability', () => {
    expect(validatePlanningAgentPlan(plan([subtask({ requiredCapabilities: ['workspace-engineering', 'current-web-research'] })]), configuration).errors)
      .toContain('no_capable_agent_class: subtask impl must be split at a Routing Capability handoff');
  });

  it('rejects a known capability missing from the pinned catalog', () => {
    const config = structuredClone(configuration);
    config.routingCatalog.capabilities = [];
    expect(validatePlanningAgentPlan(plan(), config).errors)
      .toContain('subtask impl references unknown Routing Capability: workspace-engineering');
  });

  it('rejects a graph pinned to a different configuration', () => {
    const candidate = plan(); candidate.workGraph!.configurationRevision = 'other';
    expect(validatePlanningAgentPlan(candidate, configuration).errors)
      .toContain('work graph configurationRevision other does not match Planner configuration revision revision-1');
  });

  it('rejects a mismatched routing catalog revision', () => {
    const config = structuredClone(configuration); config.routingCatalog.configurationRevision = 'other';
    expect(validatePlanningAgentPlan(plan(), config).errors)
      .toContain('Planner configuration view revision revision-1 does not match routing catalog revision other');
  });

  it('includes pure graph dependency violations', () => {
    const candidate = plan([subtask(), subtask({ id: 'second', dependencies: [{ fromSubtaskId: 'missing',
      requiredItems: [{ key: 'input', type: 'text', description: 'Input facts' }] }] })]);
    expect(validatePlanningAgentPlan(candidate, configuration).errors)
      .toContain('unknown_dependency: subtasks.1.dependencies.0.fromSubtaskId: subtask second depends on unknown subtask missing');
  });

  it('rejects file deliveries outside the declared Workspace targets', () => {
    const candidate = plan(); candidate.workspaceIntent!.targetPaths = ['other.md'];
    expect(validatePlanningAgentPlan(candidate, configuration).errors)
      .toContain('subtask.fileOutputs must be covered by workspaceIntent.targetPaths: report.md');
  });

  it('rejects writes under a read-only Workspace intent', () => {
    const candidate = plan(); candidate.workspaceIntent!.operation = 'read_only';
    expect(validatePlanningAgentPlan(candidate, configuration).errors)
      .toContain('a read-only Workspace intent cannot authorize a write Work Graph');
  });

  it('rejects an ambiguous intent authorizing work', () => {
    const candidate = plan(); candidate.workspaceIntent!.operation = 'ambiguous';
    expect(validatePlanningAgentPlan(candidate, configuration).errors)
      .toContain('an ambiguous Workspace intent cannot authorize plan_work_graph');
  });

  it('requires explicit read effects when independent text reports could run in parallel', () => {
    const candidate = plan([subtask({ deliveryKind: 'report', fileOutputs: [] }),
      subtask({ id: 'second', deliveryKind: 'report', fileOutputs: [] })]);
    candidate.workspaceIntent!.operation = 'read_only'; candidate.workspaceIntent!.targetPaths = [];
    expect(validatePlanningAgentPlan(candidate, configuration).errors)
      .toEqual([expect.stringContaining('must declare workspaceEffect')]);
  });
});
