import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { GenerationReplanRequestRepo } from '../../src/storage/generation-replan-request-repo.js';
import { decideDeferredPlanActivation } from '../../src/execution/deferred-plan-activation-policy.js';
import { codexBinding, event } from '../support/plan-admission-fixture.js';
import { workGraphPlan } from '../support/planning-agent-plans.js';
import { createV31RepositoryDb, REVISION } from './v31-repository-fixture.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); });

function setup() {
  const db = createV31RepositoryDb();
  databases.push(db);
  const repo = new GenerationReplanRequestRepo(db);
  repo.enqueue({ id: 'replan_1', taskId: 'task_1', generationId: 'generation_1', sourceRevision: 1,
    configurationRevision: REVISION, triggerDecisionId: 'trigger_1', now: event.occurredAt });
  repo.markPlanning('replan_1', 'token_1', event.occurredAt);
  const plan = workGraphPlan({ goal: 'Finish the task', capabilityClass: 'code_edit' });
  plan.task.taskId = 'task_1';
  plan.task.binding = 'reference';
  plan.workGraph!.configurationRevision = REVISION;
  const proposal = {
    ...structuredClone(event), id: 'proposal_1', proposal: plan, configurationRevision: REVISION,
    taskId: 'task_1', generationId: 'generation_1', targetGraphRevision: 2, proposalSource: 'replan' as const,
    schemaVersion: 5, type: 'plan_proposed', correlationId: 'replan_1', causationId: 'trigger_1',
  };
  const bindings = [{ ...codexBinding, configurationRevision: REVISION }];
  const defer = () => repo.deferForAvailability('replan_1', proposal, 'Wait for Executor', { subtask_execute: bindings }, event.occurredAt);
  return { db, repo, proposal, bindings, defer };
}

describe('durable deferred proposal owner', () => {
  it('persists activation facts without a Kernel envelope and reconstructs after connection replacement', () => {
    const { db, bindings, defer } = setup();
    expect(defer()).toBe(true);
    const stored = JSON.parse((db.prepare('SELECT deferred_plan_json FROM generation_replan_requests').get() as { deferred_plan_json: string }).deferred_plan_json);
    expect(stored).not.toHaveProperty('type');
    expect(stored).not.toHaveProperty('schemaVersion');
    expect(stored).not.toHaveProperty('correlationId');
    expect(stored).not.toHaveProperty('causationId');
    expect(stored).toMatchObject({ taskId: 'task_1', generationId: 'generation_1', targetGraphRevision: 2, requestText: event.requestText });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('kernel_events', 'kernel_decisions')").all()).toEqual([]);
    const saved = db.serialize();
    db.close();
    const restarted = new Database(saved);
    databases.push(restarted);
    const recovered = new GenerationReplanRequestRepo(restarted).listWaitingForAvailability()[0]!;
    expect(recovered.deferredPlan).toEqual(stored);
    expect(decideDeferredPlanActivation({
      replanRequestId: recovered.id, observedAt: event.occurredAt,
      snapshot: {
        task: { id: 'task_1', status: 'needs_action' }, activeGenerationId: 'generation_1', activeGraphRevision: 1,
        deferredPlan: recovered.deferredPlan, deferredBindings: recovered.deferredBindings, executorStatuses: [],
      },
    })).toMatchObject({ authorized: true, activation: { authorizedBindingsBySubtask: { subtask_execute: bindings } } });
  });

  it.each(['task', 'generation', 'revision', 'configuration', 'binding'] as const)(
    'refuses a mismatched %s before writing', field => {
      const { repo, proposal, bindings, defer } = setup();
      if (field === 'task') { proposal.taskId = 'other'; proposal.proposal.task.taskId = 'other'; }
      if (field === 'generation') proposal.generationId = 'other';
      if (field === 'revision') proposal.targetGraphRevision = 3;
      if (field === 'configuration') { proposal.configurationRevision = 'other'; proposal.proposal.workGraph!.configurationRevision = 'other'; }
      if (field === 'binding') bindings[0]!.configurationRevision = 'other';
      expect(defer).toThrow(/mismatch/);
      expect(repo.find('replan_1')).toMatchObject({ status: 'planning', deferredPlan: null, deferredBindings: {} });
    },
  );

  it('keeps the accepted proposal immutable across duplicate deferral', () => {
    const { repo, proposal, defer } = setup();
    expect(defer()).toBe(true);
    const first = repo.find('replan_1');
    proposal.proposal.reason = 'A different proposal';
    expect(defer()).toBe(false);
    expect(repo.find('replan_1')).toEqual(first);
  });

  it('cannot reopen a cancelled replan with a late deferral', () => {
    const { repo, defer } = setup();
    repo.cancelTask('task_1', 'cancel_1', event.occurredAt);
    expect(defer()).toBe(false);
    expect(repo.find('replan_1')).toMatchObject({ status: 'cancelled', deferredPlan: null });
  });

  it.each(['cancelled', 'failed'] as const)('retires only the observed waiting output as %s', outcome => {
    const { repo, defer } = setup();
    expect(repo.rejectDeferredProposal('replan_1', 'proposal_1', outcome, 'unavailable', event.occurredAt)).toBe(false);
    expect(defer()).toBe(true);
    expect(repo.rejectDeferredProposal('replan_1', 'other-output', outcome, 'unavailable', event.occurredAt)).toBe(false);
    expect(repo.listWaitingForAvailability()).toHaveLength(1);
    expect(repo.rejectDeferredProposal('replan_1', 'proposal_1', outcome, 'unavailable', event.occurredAt)).toBe(true);
    expect(repo.find('replan_1')).toMatchObject({ status: outcome, errorSummary: 'unavailable' });
    expect(repo.listWaitingForAvailability()).toEqual([]);
    expect(repo.rejectDeferredProposal('replan_1', 'proposal_1', outcome, 'second reason', event.occurredAt)).toBe(false);
    expect(repo.find('replan_1')?.errorSummary).toBe('unavailable');
    expect(defer()).toBe(false);
  });
});
