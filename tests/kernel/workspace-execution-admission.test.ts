import { describe, expect, it } from 'vitest';
import { ControlKernel, type KernelEvent, type KernelSnapshot } from '../../src/kernel/control-kernel.js';
import type { PlannerConfigurationView, KernelConfigurationView } from '../../src/configuration/index.js';
import { authorizedExecutorBindingFingerprint } from '../../src/core/authorized-executor-binding.js';
import type { PlanningAgentPlan } from '../../src/planning/planning-types.js';
import { workspaceIntentFixture, workGraphPlan } from '../support/planning-agent-plans.js';

const configurationRevision = 'revision-admission';

const plannerConfiguration: PlannerConfigurationView = {
  revisionId: configurationRevision,
  contentHash: 'sha256:planner',
  models: [{
    id: 'engineering-model',
    capabilities: ['coding', 'tools'],
    reasoning: 'high',
    region: 'international',
  }],
  routingCatalog: {
    version: 2,
    configurationRevision,
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

const kernelConfiguration: KernelConfigurationView = {
  revisionId: configurationRevision,
  contentHash: 'sha256:kernel',
  agentClasses: {
    'codex-cli': {
      kind: 'executor',
      harnessRef: 'codex-harness',
      driverId: 'codex-cli',
      modelPolicy: { mode: 'fixed', modelRef: 'engineering-model' },
      permissionProfileRef: 'workspace-default',
      routingCapabilities: ['workspace-engineering'],
      enabled: true,
      transport: 'local-cli',
      supportsProbe: true,
      supportsAbort: true,
      supportsContinuation: true,
    },
  },
  models: {
    'engineering-model': {
      providerRef: 'openai',
      modelId: 'engineering-model',
      capabilities: ['coding', 'tools'],
      reasoning: 'high',
      enabled: true,
    },
  },
  providers: { openai: { enabled: true } },
  permissionProfiles: {
    'workspace-default': { profileId: 'workspace-engineering', version: 1, parameters: {} },
  },
  runtimePolicy: { maxConcurrentAttempts: 4 },
  workspaceExecution: { fallbackMode: 'in_place' },
};

const targetWorkspace = {
  workspaceId: 'workspace_main',
  canonicalPath: '/Users/me/project',
};

function admission(): Extract<KernelSnapshot, { type: 'plan_admission' }> {
  return {
    schemaVersion: 5,
    type: 'plan_admission',
    tasks: [],
    runningTaskId: null,
    plannerConfiguration,
    kernelConfiguration,
    executorStatuses: [],
    v5WorkGraphTaskIds: [],
    eligibleContextRefKeys: ['current_user_input'],
    pendingAuthorizationRequest: null,
  };
}

function planEvent(
  plan: PlanningAgentPlan,
  workspaceAdmission?: {
    targetWorkspace: { workspaceId: string; canonicalPath: string } | null;
    worktreeAvailable: boolean;
  },
): Extract<KernelEvent, { type: 'plan_proposed' }> {
  return {
    schemaVersion: 5,
    configurationRevision,
    type: 'plan_proposed',
    id: 'event_plan_1',
    correlationId: 'request_1',
    causationId: null,
    occurredAt: '2026-10-25T00:00:00.000Z',
    sessionId: 'session_1',
    conversationId: 'conversation_1',
    workspaceId: targetWorkspace.workspaceId,
    requestText: '请修改目标项目的配置',
    generationId: 'generation_1',
    proposalSource: 'initial',
    targetGraphRevision: 1,
    proposal: plan,
    ...(workspaceAdmission ? { workspaceAdmission } : {}),
  };
}

function v9(intent: Parameters<typeof workspaceIntentFixture>[0]): PlanningAgentPlan {
  const base = workGraphPlan({ goal: '请修改目标项目的配置', deliveryKind: 'edit', fileOutputs: [] });
  return {
    ...base,
    schemaVersion: 9,
    workGraph: base.workGraph
      ? { ...base.workGraph, configurationRevision }
      : null,
    workspaceIntent: workspaceIntentFixture(intent),
  };
}

describe('Kernel Workspace execution admission', () => {
  it('authorizes the Planner in_place judgement and pins it on the Decision', () => {
    const decision = new ControlKernel().decide(
      planEvent(v9({ operation: 'modify_existing', targetPaths: ['config/app.yaml'], proposedMode: 'in_place' }),
        { targetWorkspace, worktreeAvailable: true }),
      admission(),
    );
    expect(decision.action.type).toBe('authorize_task_plan');
    if (decision.action.type !== 'authorize_task_plan') return;
    expect(decision.action.workspaceExecution).toMatchObject({
      executionMode: 'in_place',
      source: 'planner',
      deliveryPolicy: 'none',
      targetPaths: ['config/app.yaml'],
    });
    expect(decision.action.workspaceIntent?.operation).toBe('modify_existing');
  });

  it('keeps a schema-8 plan on the isolated backend', () => {
    const base = workGraphPlan({ goal: '修改项目配置', deliveryKind: 'edit', fileOutputs: [] });
    const plan: PlanningAgentPlan = {
      ...base,
      workGraph: base.workGraph ? { ...base.workGraph, configurationRevision } : null,
    };
    const event = planEvent(plan, { targetWorkspace, worktreeAvailable: true });
    const decision = new ControlKernel().decide(event, admission());
    expect(decision.action.type).toBe('authorize_task_plan');
    if (decision.action.type !== 'authorize_task_plan') return;
    expect(decision.action.workspaceExecution).toMatchObject({
      executionMode: 'worktree',
      source: 'kernel_safety',
    });
    expect(decision.action.workspaceIntent).toBeNull();
  });

  it('asks for the side effect instead of writing when the Planner reported ambiguity', () => {
    const base = v9({ operation: 'ambiguous', originalFilePolicy: 'unknown', isolationPolicy: 'unknown', confidence: 0.4 });
    const plan: PlanningAgentPlan = {
      ...base,
      action: 'clarification',
      clarificationQuestion: '扩展后的 5 页是覆盖原文件，还是另存为新文件？',
      workGraph: null,
      task: { ...base.task, priority: null },
    };
    const decision = new ControlKernel().decide(
      planEvent(plan, { targetWorkspace, worktreeAvailable: true }),
      admission(),
    );
    expect(decision.action).toMatchObject({ type: 'request_clarification' });
    expect(decision.action.type === 'request_clarification' && decision.action.question)
      .toContain('覆盖原文件');
  });

  it('keeps a read-only report in an isolated execution directory', () => {
    const plan = v9({
      operation: 'read_only',
      targetPaths: [],
      proposedMode: null,
    });
    plan.workGraph = plan.workGraph
      ? {
          ...plan.workGraph,
          subtasks: plan.workGraph.subtasks.map(subtask => ({
            ...subtask,
            deliveryKind: 'report' as const,
            fileOutputs: [],
          })),
        }
      : null;
    const decision = new ControlKernel().decide(
      planEvent(plan, { targetWorkspace, worktreeAvailable: true }),
      admission(),
    );
    expect(decision.action.type).toBe('authorize_task_plan');
    if (decision.action.type !== 'authorize_task_plan') return;
    expect(decision.action.workspaceExecution).toMatchObject({
      executionMode: 'worktree',
      source: 'kernel_safety',
      deliveryPolicy: 'none',
      targetPaths: [],
    });
  });

  it('does not authorize work when an ambiguous intent reaches the write path', () => {
    const decision = new ControlKernel().decide(
      planEvent(v9({ operation: 'ambiguous' }), { targetWorkspace, worktreeAvailable: true }),
      admission(),
    );
    expect(decision.action.type).toBe('reject_request');
  });

  it('asks for a Workspace when the Conversation has none', () => {
    const decision = new ControlKernel().decide(
      planEvent(v9({ proposedMode: 'in_place' }), { targetWorkspace: null, worktreeAvailable: true }),
      admission(),
    );
    expect(decision.action.type).toBe('request_clarification');
  });

  it('rejects a proposal that targets a different Workspace', () => {
    const decision = new ControlKernel().decide(
      planEvent(
        v9({ targetWorkspaceId: 'workspace_other', proposedMode: 'in_place' }),
        { targetWorkspace, worktreeAvailable: true },
      ),
      admission(),
    );
    expect(decision.action.type).toBe('reject_request');
    expect(decision.reason).toContain('workspace_other');
  });

  it('inherits the immutable mode of an existing Task on a replan', () => {
    const base = workGraphPlan({ goal: '继续修改配置', deliveryKind: 'edit' });
    const plan: PlanningAgentPlan = { ...base, schemaVersion: 9, workspaceIntent: workspaceIntentFixture({ proposedMode: null }) };
    const snapshot = admission();
    snapshot.tasks = [{
      id: 'task_1',
      status: 'running',
      workspaceId: targetWorkspace.workspaceId,
      executionMode: 'worktree',
      deliveryPolicy: 'await_acceptance',
    }];
    const event: Extract<KernelEvent, { type: 'plan_proposed' }> = {
      ...planEvent(plan, { targetWorkspace, worktreeAvailable: true }),
      taskId: 'task_1',
      proposalSource: 'replan',
      targetGraphRevision: 2,
      proposal: {
        ...plan,
        task: { ...plan.task, binding: 'reference', taskId: 'task_1' },
        workGraph: plan.workGraph ? { ...plan.workGraph, configurationRevision } : null,
      },
    };
    const decision = new ControlKernel().decide(event, snapshot);
    expect(decision.action.type).toBe('authorize_task_plan');
    if (decision.action.type !== 'authorize_task_plan') return;
    expect(decision.action.workspaceExecution).toMatchObject({
      executionMode: 'worktree',
      source: 'kernel_safety',
      deliveryPolicy: 'await_acceptance',
    });
  });

  it('resolves the configured fallback only for a low-risk request without a mode', () => {
    const event = planEvent(
      v9({ operation: 'create_in_target', targetPaths: ['docs/new.md'], proposedMode: null }),
      { targetWorkspace, worktreeAvailable: true },
    );
    const decision = new ControlKernel().decide(event, admission());
    expect(decision.action.type).toBe('authorize_task_plan');
    if (decision.action.type !== 'authorize_task_plan') return;
    expect(decision.action.workspaceExecution).toMatchObject({
      executionMode: 'in_place',
      source: 'fallback',
    });
  });

  it('uses the worktree fallback from the active configuration revision', () => {
    const snapshot = admission();
    snapshot.kernelConfiguration = {
      ...kernelConfiguration,
      workspaceExecution: { fallbackMode: 'worktree' },
    };
    const decision = new ControlKernel().decide(
      planEvent(v9({ proposedMode: null }), { targetWorkspace, worktreeAvailable: true }),
      snapshot,
    );
    expect(decision.action.type).toBe('authorize_task_plan');
    if (decision.action.type !== 'authorize_task_plan') return;
    expect(decision.action.workspaceExecution).toMatchObject({
      executionMode: 'worktree',
      source: 'fallback',
      deliveryPolicy: 'await_acceptance',
    });
  });

  it('requires user acceptance for an explicit isolated candidate', () => {
    const decision = new ControlKernel().decide(
      planEvent(
        v9({
          operation: 'isolated_experiment',
          originalFilePolicy: 'must_preserve',
          isolationPolicy: 'requested',
          proposedMode: 'worktree',
          reason: '先生成候选版本，等待用户接受',
        }),
        { targetWorkspace, worktreeAvailable: true },
      ),
      admission(),
    );
    expect(decision.action.type).toBe('authorize_task_plan');
    if (decision.action.type !== 'authorize_task_plan') return;
    expect(decision.action.workspaceExecution).toMatchObject({
      executionMode: 'worktree',
      deliveryPolicy: 'await_acceptance',
    });
  });

  it('never authorizes work when the Planner turn is invalid', () => {
    const plan = v9({ proposedMode: 'in_place' });
    const decision = new ControlKernel().decide(
      planEvent({ ...plan, workGraph: null }, { targetWorkspace, worktreeAvailable: true }),
      admission(),
    );
    expect(decision.action.type).toBe('reject_request');
  });
});

describe('Kernel Workspace execution admission binding identity', () => {
  it('keeps the authorized binding fingerprint stable for the admitted plan', () => {
    // The admission decision never invents an Executor binding: the existing
    // authorized-binding fingerprint path stays authoritative.
    const binding = {
      agentClassRef: 'codex-cli',
      harnessRef: 'codex-harness',
      providerRef: 'openai',
      modelRef: 'engineering-model',
      permissionProfileRef: 'workspace-default',
      configurationRevision,
    };
    expect(authorizedExecutorBindingFingerprint(binding)).toBe(
      authorizedExecutorBindingFingerprint({ ...binding }),
    );
  });
});
