import { describe, expect, it } from 'vitest';
import {
  decideDeferredPlanActivation,
  deferredPlanProposal,
  type DeferredPlanActivationSnapshot,
} from '../../src/execution/deferred-plan-activation-policy.js';
import type { PlanAdmissionRequest } from '../../src/execution/plan-admission-policy.js';
import { codexBinding, event } from '../support/plan-admission-fixture.js';
import { workGraphPlan } from '../support/planning-agent-plans.js';

function proposal(): PlanAdmissionRequest {
  const plan = workGraphPlan({ goal: 'Finish remaining work', capabilityClass: 'code_edit' });
  plan.task.taskId = 'task_1';
  plan.task.binding = 'reference';
  plan.workGraph!.subtasks[0]!.contextRefs = [];
  return {
    ...structuredClone(event),
    id: 'replan_1', taskId: 'task_1', proposal: plan,
    generationId: 'generation_1', targetGraphRevision: 2, proposalSource: 'replan',
  };
}

function facts(): DeferredPlanActivationSnapshot {
  return {
    task: { id: 'task_1', status: 'needs_action' },
    activeGenerationId: 'generation_1', activeGraphRevision: 1,
    deferredPlan: deferredPlanProposal(proposal()),
    // Durable deferred scope is keyed by Subtask id, exactly like admission.
    deferredBindings: { subtask_execute: [structuredClone(codexBinding)] },
    executorStatuses: [],
  };
}

function activate(snapshot: DeferredPlanActivationSnapshot) {
  return decideDeferredPlanActivation({
    replanRequestId: 'replan_1', observedAt: event.occurredAt, snapshot,
  });
}

describe('deferred plan activation owner', () => {
  it('accepts a durable proposal without a Kernel envelope and retains its exact graph', () => {
    const snapshot = facts();
    const before = structuredClone(snapshot);
    expect(activate(snapshot)).toMatchObject({
      authorized: true,
      activation: {
        taskId: 'task_1', replanRequestId: 'replan_1', graphRevision: 2,
        generationId: 'generation_1', proposalSource: 'replan',
        workGraph: snapshot.deferredPlan!.proposal.workGraph,
        authorizedBindingsBySubtask: { subtask_execute: [codexBinding] },
      },
    });
    expect(snapshot).toEqual(before);
  });

  it.each(['succeeded', 'failed', 'cancelled', 'created'] as const)(
    'refuses a Task in %s', status => {
      const snapshot = facts();
      snapshot.task!.status = status;
      expect(activate(snapshot).authorized).toBe(false);
    },
  );

  it.each(['task', 'deferredPlan', 'activeGenerationId', 'activeGraphRevision'] as const)(
    'refuses missing %s facts', field => {
      const snapshot = facts();
      snapshot[field] = null;
      expect(activate(snapshot).authorized).toBe(false);
    },
  );

  it('does not activate the same revision twice or a proposal for another generation', () => {
    const snapshot = facts();
    snapshot.activeGraphRevision = 2;
    expect(activate(snapshot).authorized).toBe(false);
    snapshot.activeGraphRevision = 1;
    snapshot.activeGenerationId = 'generation_other';
    expect(activate(snapshot).authorized).toBe(false);
    snapshot.activeGenerationId = 'generation_1';
    snapshot.task!.id = 'task_other';
    expect(activate(snapshot).authorized).toBe(false);
  });

  it.each(['error', 'disabled'] as const)('waits while the only eligible Executor is %s', classHealth => {
    const snapshot = facts();
    snapshot.executorStatuses = [{
      agentClassName: codexBinding.agentClassRef, classHealth,
      recentAttempts: [], recentRecoveryChecks: [], updatedAt: event.occurredAt,
    }];
    expect(activate(snapshot)).toMatchObject({ authorized: false, reason: 'recovered Executor does not make the deferred frontier executable' });
    snapshot.executorStatuses[0] = { ...snapshot.executorStatuses[0]!, classHealth: 'healthy' };
    expect(activate(snapshot).authorized).toBe(true);
  });

  it('refuses an empty deferred scope and bindings from another configuration', () => {
    const empty = facts();
    empty.deferredBindings = {};
    expect(activate(empty)).toMatchObject({
      authorized: false,
      reason: 'deferred candidate scope or configuration is invalid',
    });
    const noBindings = facts();
    noBindings.deferredBindings = { subtask_execute: [] };
    expect(activate(noBindings).authorized).toBe(false);
    const staleRevision = facts();
    staleRevision.deferredBindings = {
      subtask_execute: [{ ...codexBinding, configurationRevision: 'other-revision' }],
    };
    expect(activate(staleRevision)).toMatchObject({
      authorized: false,
      reason: 'deferred candidate scope or configuration is invalid',
    });
  });

  it('revalidates the graph and Workspace facts', () => {
    const snapshot = facts();
    const subtask = snapshot.deferredPlan!.proposal.workGraph!.subtasks[0]!;
    // Keep the same Subtask ids so the deferred scope still matches, then break
    // the graph structure itself.
    subtask.dependencies = [{
      fromSubtaskId: 'missing_subtask',
      requiredItems: [{ key: 'item', description: 'missing handoff' }],
    }];
    expect(activate(snapshot)).toMatchObject({ authorized: false, reason: 'deferred availability proposal no longer validates' });
    const missingWorkspace = facts();
    missingWorkspace.deferredPlan!.workspaceAdmission = { targetWorkspace: null };
    expect(activate(missingWorkspace).authorized).toBe(false);
    const changedWorkspace = facts();
    changedWorkspace.task!.executionMode = 'worktree';
    expect(activate(changedWorkspace).authorized).toBe(false);
  });

  it('removes transport metadata when creating the durable proposal', () => {
    const input = { ...proposal(), schemaVersion: 5, type: 'plan_proposed', correlationId: 'transport', causationId: 'decision' };
    const stored = deferredPlanProposal(input);
    expect(stored).toEqual({
      id: input.id, taskId: input.taskId, configurationRevision: input.configurationRevision,
      requestText: input.requestText, generationId: input.generationId,
      targetGraphRevision: 2, proposalSource: 'replan', proposal: input.proposal,
      workspaceAdmission: input.workspaceAdmission,
    });
  });

  it.each([
    { proposalSource: 'initial' }, { taskId: 'other' }, { generationId: '' },
    { targetGraphRevision: 1 }, { targetGraphRevision: 2.5 }, { configurationRevision: 'other' },
  ] as const)('refuses invalid persisted identity %j', override => {
    expect(() => deferredPlanProposal({ ...proposal(), ...override })).toThrow('invalid deferred replan proposal');
  });
});
