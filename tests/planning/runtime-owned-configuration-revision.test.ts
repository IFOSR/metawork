import { describe, expect, it } from 'vitest';
import type { PlannerConfigurationView } from '../../src/configuration/index.js';
import { normalizePlanningAgentPlanInput } from '../../src/planning/planning-agent-plan-normalizer.js';
import { PlanningAgentPlanSchema } from '../../src/planning/planning-agent-plan-schema.js';
import { validatePlanningAgentPlan } from '../../src/planning/planning-agent-plan-validator.js';
import { workspaceIntentFixture } from '../support/planning-agent-plans.js';

/**
 * The configuration revision is a runtime identity fact.
 *
 * A rollback produced `rollback-0.1.21-local-final-0826-<uuid>` (69 characters with
 * dots). The Planner could not submit any plan: the proposal schema rejected the
 * authoritative value while the validator required it verbatim, so every retry was
 * rejected and the turn ended with "planning budget exhausted".
 */
const DOTTED_REVISION = 'rollback-0.1.21-local-final-0826-23c74b9f-e70d-4272-8526-484fce429ffa';

function workGraphPlan(configurationRevision: string | null) {
  return {
    id: 'plan_revision_ownership',
    schemaVersion: 9,
    action: 'plan_work_graph',
    confidence: 0.9,
    reason: '调研两个独立事实流',
    clarificationQuestion: null,
    task: {
      binding: 'new',
      taskId: null,
      control: 'none',
      scope: null,
      title: '办公 Agent 形态调研',
      goal: '调研办公类 Agent 的运行形态并给出建议',
      includeRecentConversationContext: false,
      priority: { level: 'normal', reason: 'normal scheduling' },
    },
    risk: { level: 'low', requiresConfirmation: false, reasons: [] },
    authorizationResolution: null,
    workGraph: {
      schemaVersion: 7,
      ...(configurationRevision === null ? {} : { configurationRevision }),
      reason: '两条独立调研合流',
      subtasks: [{
        id: 'research-cn',
        title: '国内办公 Agent 形态',
        goal: '调研国内办公 Agent 的运行形态',
        dependencies: [],
        contextRefs: [{ kind: 'current_user_input' }],
        requiredCapabilities: ['current-web-research'],
        deliveryKind: 'report',
        fileOutputs: [],
        acceptance: [{ key: 'evidence', description: '给出可追溯来源', requiredEvidence: [] }],
        riskLevel: 'low',
        workspaceEffect: 'read_only',
      }, {
        id: 'synthesis',
        title: '综合建议',
        goal: '汇总两条调研并给出建议',
        dependencies: [{ fromSubtaskId: 'research-cn', requiredItems: [{ key: 'findings', type: 'text', description: '国内调研结论' }] }],
        contextRefs: [{ kind: 'current_user_input' }],
        requiredCapabilities: ['current-web-research'],
        deliveryKind: 'report',
        fileOutputs: [],
        acceptance: [{ key: 'verdict', description: '给出取舍建议', requiredEvidence: [] }],
        riskLevel: 'low',
        workspaceEffect: 'read_only',
      }],
    },
    workspaceIntent: workspaceIntentFixture({ operation: 'read_only', targetPaths: [], reason: '只读调研' }),
    source: 'anyfusion-planner',
  };
}

function currentSchemaPlan() {
  return workGraphPlan(null) as Record<string, unknown> & {
    workGraph: { subtasks: Array<Record<string, unknown>> };
  };
}

describe('runtime-owned configuration revision', () => {
  it('reports the invalid graph key without asking the Manager to remove valid workspaceIntent', () => {
    const plan = currentSchemaPlan();
    Object.assign(plan.workGraph, { subtasksOrderHint: [] });
    const normalized = normalizePlanningAgentPlanInput(plan, { configurationRevision: DOTTED_REVISION });
    const result = validatePlanningAgentPlan(normalized, {} as PlannerConfigurationView);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('subtasksOrderHint');
    expect(result.errors.join('\n')).not.toContain('workspaceIntent');
  });

  it('defaults an omitted nullable clarification question to null', () => {
    const plan = currentSchemaPlan();
    delete (plan as { clarificationQuestion?: string | null }).clarificationQuestion;
    const normalized = normalizePlanningAgentPlanInput(plan, {
      configurationRevision: DOTTED_REVISION,
    });
    expect(normalized).toMatchObject({ clarificationQuestion: null });
    expect(PlanningAgentPlanSchema.safeParse(normalized).success).toBe(true);
  });

  it('keeps clarification actions subject to the semantic question requirement', () => {
    const plan = currentSchemaPlan();
    plan.action = 'clarification';
    plan.workGraph = null;
    plan.workspaceIntent = null;
    const normalized = normalizePlanningAgentPlanInput(plan, {
      configurationRevision: DOTTED_REVISION,
    });
    const parsed = PlanningAgentPlanSchema.safeParse(normalized);
    expect(parsed.success).toBe(true);
    const configuration = {
      revisionId: DOTTED_REVISION,
      routingCatalog: {
        configurationRevision: DOTTED_REVISION,
        capabilities: [{ id: 'current-web-research' }],
        agentClasses: [{ id: 'pi-research', routingCapabilities: ['current-web-research'] }],
      },
    } as unknown as PlannerConfigurationView;
    expect(validatePlanningAgentPlan(parsed.data, configuration).errors)
      .toContain('clarification requires clarificationQuestion');
  });

  it('replaces whatever the model sent with the active revision', () => {
    const normalized = normalizePlanningAgentPlanInput(workGraphPlan('some-model-guess'), {
      configurationRevision: DOTTED_REVISION,
    }) as { workGraph: { configurationRevision: string } };
    expect(normalized.workGraph.configurationRevision).toBe(DOTTED_REVISION);
  });

  it('fills the field when the model omitted it entirely', () => {
    const normalized = normalizePlanningAgentPlanInput(workGraphPlan(null), {
      configurationRevision: DOTTED_REVISION,
    }) as { workGraph: { configurationRevision: string } };
    expect(normalized.workGraph.configurationRevision).toBe(DOTTED_REVISION);
  });

  it('accepts an authoritative id outside the reference grammar', () => {
    // The proposal schema no longer re-validates this field as a reference, and
    // the validator requires exact equality with the active revision.
    const normalized = normalizePlanningAgentPlanInput(workGraphPlan(null), {
      configurationRevision: DOTTED_REVISION,
    });
    const parsed = PlanningAgentPlanSchema.safeParse(normalized);
    expect(parsed.success).toBe(true);
    const configuration: PlannerConfigurationView = {
      revisionId: DOTTED_REVISION,
      contentHash: 'sha256:planner-view',
      models: [{ id: 'research-model', capabilities: ['tools'], reasoning: 'high', region: 'international' }],
      routingCatalog: {
        version: 2,
        configurationRevision: DOTTED_REVISION,
        capabilities: [{ id: 'current-web-research', deliveryContract: '研究当前公开网络信息。' }],
        agentClasses: [{
          id: 'pi-research',
          routingCapabilities: ['current-web-research'],
          primaryUseCases: ['research'],
          avoidUseCases: [],
          affordances: ['public-web-search'],
          modelPolicy: { mode: 'fixed', modelRef: 'research-model' },
        }],
      },
    } as unknown as PlannerConfigurationView;
    const validation = validatePlanningAgentPlan(normalized as never, configuration);
    expect(validation.errors.join('\n')).not.toMatch(/configurationRevision/u);
  });

  it('does not replace the graph revision when no active revision is supplied', () => {
    const plan = workGraphPlan('model-value');
    const normalized = normalizePlanningAgentPlanInput(plan, {}) as {
      workGraph: { configurationRevision: string };
    };
    expect(normalized.workGraph.configurationRevision).toBe('model-value');
  });

  it('keeps normalizing the task id alongside the revision', () => {
    const plan = workGraphPlan(null);
    plan.task.taskId = '   ';
    const normalized = normalizePlanningAgentPlanInput(plan, {
      configurationRevision: DOTTED_REVISION,
    }) as { task: { taskId: string | null } };
    expect(normalized.task.taskId).toBeNull();
  });
});
