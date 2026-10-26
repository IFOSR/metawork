import { describe, expect, it } from 'vitest';
import type { PlannerConfigurationView } from '../../src/configuration/index.js';
import { PlanningAgentPlanSchema } from '../../src/planning/planning-agent-plan-schema.js';
import { validatePlanningAgentPlan } from '../../src/planning/planning-agent-plan-validator.js';
import type { PlanningAgentPlan } from '../../src/planning/planning-types.js';
import { workspaceIntentFixture, workGraphPlan } from '../support/planning-agent-plans.js';

const configuration: PlannerConfigurationView = {
  revisionId: 'revision-test',
  contentHash: 'sha256:planner-view',
  models: [{
    id: 'engineering-model',
    capabilities: ['coding', 'tools'],
    reasoning: 'high',
    region: 'international',
  }],
  routingCatalog: {
    version: 2,
    configurationRevision: 'revision-test',
    capabilities: [{ id: 'workspace-engineering', deliveryContract: 'Modify workspace files.' }],
    agentClasses: [{
      id: 'codex-cli',
      routingCapabilities: ['workspace-engineering'],
      primaryUseCases: ['implementation'],
      avoidUseCases: [],
      affordances: ['workspace-read-write'],
      modelPolicy: { mode: 'fixed', modelRef: 'engineering-model' },
    }],
  },
};

function v9Plan(intent: ReturnType<typeof workspaceIntentFixture>): PlanningAgentPlan {
  const plan = workGraphPlan({ goal: '修改目标项目配置', deliveryKind: 'edit', fileOutputs: [] });
  return {
    ...plan,
    schemaVersion: 9,
    workGraph: plan.workGraph ? { ...plan.workGraph, configurationRevision: 'revision-test' } : null,
    workspaceIntent: intent,
  };
}

function errorsFor(plan: PlanningAgentPlan): string[] {
  return validatePlanningAgentPlan(plan, configuration).errors;
}

describe('Planner Workspace intent contract (schema 9)', () => {
  it('accepts a plan that declares how it will execute in the target Workspace', () => {
    const plan = v9Plan(workspaceIntentFixture({
      operation: 'modify_existing',
      targetPaths: ['config/app.yaml'],
      reason: '直接修改目标项目中的配置',
    }));
    expect(PlanShapeV9Acceptance(plan)).toBe(true);
    expect(validatePlanningAgentPlan(plan, configuration)).toEqual({ valid: true, errors: [] });
  });

  it('rejects a declared output that is outside the Workspace intent scope', () => {
    const base = workGraphPlan({ goal: '修改目标项目配置', deliveryKind: 'edit', fileOutputs: ['secrets.env'] });
    const plan: PlanningAgentPlan = {
      ...base,
      schemaVersion: 9,
      workGraph: base.workGraph ? { ...base.workGraph, configurationRevision: 'revision-test' } : null,
      workspaceIntent: workspaceIntentFixture({
        operation: 'modify_existing',
        targetPaths: ['src'],
          reason: '直接修改 src 目录中的文件',
      }),
    };
    expect(errorsFor(plan).join('\n')).toContain('secrets.env');
  });

  it('accepts a legacy schema-8 plan for replay validation', () => {
    const current = workGraphPlan({ goal: '修改目标项目配置', deliveryKind: 'edit' });
    const { workspaceIntent: _intent, ...legacy } = current;
    const plan: PlanningAgentPlan = { ...legacy, schemaVersion: 8 };
    expect(plan.schemaVersion).toBe(8);
    expect(validatePlanningAgentPlan(plan, configuration)).toEqual({ valid: true, errors: [] });
  });

  it('requires workspaceIntent for a schema-9 write plan', () => {
    const plan = v9Plan(workspaceIntentFixture());
    const withoutIntent = { ...plan, workspaceIntent: null };
    const parsed = PlanningAgentPlanSchema.safeParse(withoutIntent);
    expect(parsed.success).toBe(false);
  });

  it('requires the schema-9 plan to declare workspaceIntent at all', () => {
    const plan = v9Plan(workspaceIntentFixture());
    const { workspaceIntent: _intent, ...withoutField } = plan;
    expect(PlanningAgentPlanSchema.safeParse(withoutField).success).toBe(false);
  });

  it('rejects an ambiguous intent that still authorizes work', () => {
    const errors = errorsFor(v9Plan(workspaceIntentFixture({ operation: 'ambiguous' })));
    expect(errors.join('\n')).toContain('ambiguous Workspace intent');
  });

  it('rejects a read-only intent that carries a write delivery', () => {
    const plan = v9Plan(workspaceIntentFixture({ operation: 'read_only' }));
    const errors = errorsFor(plan);
    expect(errors.join('\n')).toContain('read-only Workspace intent');
  });

  it('allows a read-only intent when the plan only reports', () => {
    const base = workGraphPlan({ goal: '分析依赖', deliveryKind: 'report', fileOutputs: [] });
    const plan: PlanningAgentPlan = {
      ...base,
      schemaVersion: 9,
      workGraph: base.workGraph ? { ...base.workGraph, configurationRevision: 'revision-test' } : null,
      workspaceIntent: workspaceIntentFixture({ operation: 'read_only' }),
    };
    expect(validatePlanningAgentPlan(plan, configuration)).toEqual({ valid: true, errors: [] });
  });

  it('rejects a fabricated target Workspace identity', () => {
    const errors = errorsFor(v9Plan(workspaceIntentFixture({
      targetWorkspaceId: '/Users/me/project',
    })));
    expect(errors.join('\n')).toContain('Workspace identity');
  });

  it('keeps Workspace intent out of the non-work action contract', () => {
    const plan: PlanningAgentPlan = {
      ...workGraphPlan({ goal: '回答问题' }),
      schemaVersion: 9,
      action: 'clarification',
      clarificationQuestion: '要覆盖原文件吗？',
      workGraph: null,
      workspaceIntent: workspaceIntentFixture({
        operation: 'ambiguous',
        }),
    };
    expect(PlanningAgentPlanSchema.safeParse(plan).success).toBe(true);
  });

  it('keeps the turn on the clarification path for an ambiguous request', () => {
    const base = workGraphPlan({ goal: '把 3 页 PPT 扩展成 5 页' });
    const plan: PlanningAgentPlan = {
      ...base,
      schemaVersion: 9,
      action: 'clarification',
      clarificationQuestion: '扩展后的 5 页是覆盖原文件，还是另存为新文件？',
      workGraph: null,
      task: { ...base.task, priority: null },
      workspaceIntent: workspaceIntentFixture({
        operation: 'ambiguous',
        originalFilePolicy: 'unknown',
          confidence: 0.4,
      }),
    };
    expect(validatePlanningAgentPlan(plan, configuration)).toEqual({ valid: true, errors: [] });
  });
});

function PlanShapeV9Acceptance(plan: PlanningAgentPlan): boolean {
  return PlanningAgentPlanSchema.safeParse(plan).success;
}
