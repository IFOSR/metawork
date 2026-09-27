import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecoveryReplanner } from '../../src/session/recovery-replanner.js';
import { DurableKernelWorkflow, KernelApplicationInterruptedError } from '../../src/kernel/kernel-workflow.js';
import { ControlKernel, type KernelSnapshot } from '../../src/kernel/control-kernel.js';
import { buildKernelConfigurationView, buildPlannerConfigurationView } from '../../src/configuration/projections.js';
import { KernelWorkflowRepo } from '../../src/storage/kernel-workflow-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { spanSnapshot } from '../support/span-configuration.js';
import { workGraphPlan } from '../support/planning-agent-plans.js';
import type { SpanRoutingEvaluator } from '../../src/routing/span-routing-types.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const snapshot = spanSnapshot();
  const db = new Database(':memory:'); databases.push(db); runMigrations(db);
  db.prepare(`INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
    VALUES (?, 'hash', 'native', '2026-09-27T00:00:00.000Z')`).run(snapshot.revisionId);
  const store = new KernelWorkflowRepo(db);
  const proposal = workGraphPlan({ goal: 'Remaining parser work', capabilityClass: 'code_edit', contextRefs: [] });
  proposal.task.binding = 'reference'; proposal.task.taskId = 'task';
  proposal.workGraph!.configurationRevision = snapshot.revisionId;
  proposal.workGraph!.subtasks[0]!.executorBindings[0]!.modelSelection = { mode: 'agent-class-default' };
  const plan = vi.fn(async () => proposal);
  const evaluate = vi.fn<SpanRoutingEvaluator['evaluate']>(async input => ({
    subtasks: input.requests.map(request => ({ subtaskId: request.subtaskId,
      candidateSetFingerprint: request.candidateSetFingerprint, status: 'advised',
      resolvedModel: 'respan/span-01-lite-20260925', candidates: request.request.candidates.map(candidate => ({
        ...candidate, candidateId: candidate.questionId, probability: candidate.modelRef === 'deep' ? 0.9 : 0.2,
      })),
    })),
  }));
  const task = { id: 'task', goal: 'Parser', status: 'running', conversationId: 'conversation', ownerPlannerSessionId: 'owner' };
  const port = {
    queries: {
      findTask: () => task, listTasks: () => [task], listTaskEvidence: () => [], listAttemptReceipts: () => [],
      listKernelDecisionsByTask: () => [], findKernelEvent: (id: string) => store.findEvent(id),
      findActiveWorkGraphRevision: () => ({ generationId: 'gen', revision: 1, configurationRevision: snapshot.revisionId }),
      listExecutorStatuses: () => [], listWorkGraphTaskIds: () => [], findOldestPendingPermission: () => null,
    },
    commands: { materializeCompletedEvidence: () => undefined },
  };
  const controller = new AbortController();
  const getSnapshot = vi.fn(async (revisionId: string) => {
    if (revisionId !== snapshot.revisionId) throw new Error('unknown revision');
    return snapshot;
  });
  const replan = createRecoveryReplanner({ db, getPort: () => port as never, getSnapshot,
    plan, evaluator: { evaluate }, signal: controller.signal });
  return { replan, plan, evaluate, snapshot, store, controller, getSnapshot };
}

function decision(type: 'request_replan' | 'request_merge_replan') {
  return { id: `decision-${type}`, eventId: 'trigger', configurationRevision: 'revision-test',
    action: { type, taskId: 'task', generationId: 'gen', sourceRevision: 1,
      subtaskId: 'subtask_execute', publicationId: 'publication', conflictChainId: 'chain' } } as never;
}

describe('recovery replan without a client', () => {
  it.each(['request_replan', 'request_merge_replan'] as const)('scores and replays %s using its pinned revision', async type => {
    const { replan, plan, evaluate, store, snapshot } = fixture();
    const event = await replan('owner', decision(type));
    expect(event).toMatchObject({ type: 'plan_proposed', sessionId: 'owner', conversationId: 'conversation',
      configurationRevision: 'revision-test', generationId: 'gen', targetGraphRevision: 2,
      spanRouting: { subtasks: [{ status: 'advised' }] } });
    expect(plan.mock.calls[0]?.[0].configuration.revisionId).toBe('revision-test');
    expect(evaluate.mock.calls[0]?.[0].configurationRevision).toBe('revision-test');
    const admission: KernelSnapshot = { schemaVersion: 5, type: 'plan_admission',
      tasks: [{ id: 'task', status: 'running' }], runningTaskId: 'task',
      plannerConfiguration: buildPlannerConfigurationView(snapshot), kernelConfiguration: buildKernelConfigurationView(snapshot),
      executorStatuses: [], v5WorkGraphTaskIds: ['task'], eligibleContextRefKeys: [], pendingAuthorizationRequest: null };
    const workflow = new DurableKernelWorkflow({ kernel: new ControlKernel(), buildSnapshot: () => admission,
      store, runtime: { apply: async () => null }, clock: { now: () => event!.occurredAt } });
    const result = await workflow.submit(event!);
    expect(result.decisions[0]?.action.type, result.decisions[0]?.reason).toBe('authorize_task_plan');
    if (result.decisions[0]?.action.type === 'authorize_task_plan') {
      expect(result.decisions[0].action.authorizedBindingsBySubtask.subtask_execute?.[0]?.modelRef).toBe('deep');
    }
    expect(await replan('owner', decision(type))).toEqual(event);
    expect(plan).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('refuses a mismatched owner before invoking Planner or Span', async () => {
    const { replan, plan, evaluate } = fixture();
    await expect(replan('other-owner', decision('request_replan'))).rejects.toThrow(/owner/);
    expect(plan).not.toHaveBeenCalled(); expect(evaluate).not.toHaveBeenCalled();
  });

  it('keeps shutdown interruption distinct from user cancellation', async () => {
    const { replan, controller, plan } = fixture(); controller.abort();
    await expect(replan('owner', decision('request_replan'))).rejects.toBeInstanceOf(KernelApplicationInterruptedError);
    expect(plan).not.toHaveBeenCalled();
  });
});
