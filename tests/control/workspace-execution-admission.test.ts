import { describe, expect, it } from 'vitest';
import { resolveWorkspaceAdmission } from '../../src/control/workspace-execution-decision.js';
import { authorizedExecutorBindingFingerprint } from '../../src/core/authorized-executor-binding.js';
import { workspaceIntentFixture } from '../support/planning-agent-plans.js';

const targetWorkspace = { workspaceId: 'workspace_main', canonicalPath: '/Users/me/project' };

function resolve(input: Partial<Parameters<typeof resolveWorkspaceAdmission>[0]> = {}) {
  return resolveWorkspaceAdmission({
    intent: workspaceIntentFixture(),
    facts: { targetWorkspace },
    riskLevel: 'low',
    writes: true,
    ...input,
  });
}

describe('Kernel Workspace admission', () => {
  it('authorizes ordinary edits as Conversation Git Worktree writes', () => {
    const result = resolve({ intent: workspaceIntentFixture({ operation: 'modify_existing', targetPaths: ['src/app.ts'] }) });
    expect(result).toMatchObject({
      status: 'resolved',
      admission: { kind: 'write', workspaceId: 'workspace_main', targetPaths: ['src/app.ts'] },
      decision: { executionMode: 'conversation_git', deliveryPolicy: 'none' },
    });
  });

  it('authorizes reports as reads without a Workspace write admission', () => {
    const result = resolve({
      intent: workspaceIntentFixture({ operation: 'read_only', targetPaths: [] }),
      writes: false,
    });
    expect(result).toMatchObject({ status: 'resolved', admission: { kind: 'read', workspaceId: 'workspace_main' } });
  });

  it('rejects read-only plans that declare file outputs', () => {
    const result = resolve({
      intent: workspaceIntentFixture({ operation: 'read_only', targetPaths: [] }),
      writes: false,
      declaredOutputPaths: ['report.md'],
    });
    expect(result).toMatchObject({ status: 'rejected' });
  });

  it('asks for clarification when a write has no Workspace or target path', () => {
    expect(resolve({ facts: { targetWorkspace: null } })).toMatchObject({ status: 'clarification' });
    expect(resolve({ intent: workspaceIntentFixture({ targetPaths: [] }) })).toMatchObject({ status: 'clarification' });
  });

  it('rejects unsafe and cross-Workspace declarations', () => {
    expect(resolve({ intent: workspaceIntentFixture({ targetPaths: ['../escape'] }) })).toMatchObject({ status: 'rejected' });
    expect(resolve({ intent: workspaceIntentFixture({ targetWorkspaceId: 'workspace_other' }) })).toMatchObject({ status: 'rejected' });
  });

  it('rejects historical Worktree bindings instead of switching directories', () => {
    expect(resolve({ facts: {
      targetWorkspace,
      existingTaskBinding: { workspaceId: targetWorkspace.workspaceId, executionMode: 'worktree' },
    } })).toMatchObject({ status: 'rejected' });
  });
});

describe('Workspace binding identity', () => {
  it('keeps authorized Executor binding fingerprints stable', () => {
    const binding = {
      agentClassRef: 'pi-engineering-fixture', harnessRef: 'codex-harness', providerRef: 'openai',
      modelRef: 'engineering-model', permissionProfileRef: 'workspace-default',
      configurationRevision: 'revision-admission',
    };
    expect(authorizedExecutorBindingFingerprint(binding)).toBe(authorizedExecutorBindingFingerprint({ ...binding }));
  });
});

// Convergence review B-03: the Planner schema, the plan validator and Kernel
// admission must agree on the `directory/` spelling. This contract test feeds a
// schema-parsed plan straight into admission without rewriting the input.
describe('directory target contract', () => {
  it('admits the directory spelling the Planner schema accepts', async () => {
    const { PlanningAgentPlanSchema } = await import('../../src/planning/planning-agent-plan-schema.js');
    const { workGraphPlan } = await import('../support/planning-agent-plans.js');
    const proposal = workGraphPlan({
      goal: '交付网站目录', deliveryKind: 'edit', fileOutputs: ['site/'],
    });
    // The Manager proposes semantics; host admission owns the eligible bindings.
    const { response: _retiredResponse, ...current } = proposal as typeof proposal & { response?: string };
    const parsed = PlanningAgentPlanSchema.safeParse({ ...current, workGraph: { ...current.workGraph,
      subtasks: current.workGraph!.subtasks.map(({ executorBindings: _bindings, ...subtask }) => subtask),
    } });
    expect(parsed.success, JSON.stringify(parsed.success ? [] : parsed.error.issues)).toBe(true);
    const plan = parsed.success ? parsed.data : null;
    expect(plan!.workspaceIntent!.targetPaths).toEqual(['site/']);
    const result = resolve({
      intent: plan!.workspaceIntent as Parameters<typeof resolveWorkspaceAdmission>[0]['intent'],
      writes: true,
      declaredOutputPaths: plan!.workGraph!.subtasks.flatMap(subtask => subtask.fileOutputs ?? []),
    });
    expect(result).toMatchObject({
      status: 'resolved',
      admission: { kind: 'write', targetPaths: ['site'] },
      decision: { executionMode: 'conversation_git' },
    });
  });

  it('normalizes a trailing slash in intent targets instead of rejecting it', () => {
    expect(resolve({ intent: workspaceIntentFixture({ operation: 'create_in_target', targetPaths: ['site/'] }) }))
      .toMatchObject({ status: 'resolved', admission: { targetPaths: ['site'] } });
    expect(resolve({ intent: workspaceIntentFixture({ operation: 'create_in_target', targetPaths: ['a//b'] }) }))
      .toMatchObject({ status: 'rejected' });
  });
});
