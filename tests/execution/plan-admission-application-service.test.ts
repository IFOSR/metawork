import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initializeDatabaseSchema } from '../../src/storage/schema.js';
import { PlanProposalRepo } from '../../src/storage/plan-proposal-repo.js';
import { PlanAdmissionResultRepo } from '../../src/storage/plan-admission-result-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskRuntimeService } from '../../src/task/task-runtime-service.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { WorkGraphRevisionRepo } from '../../src/storage/work-graph-revision-repo.js';
import { ConversationTaskSchedulerRepo } from '../../src/storage/conversation-task-scheduler-repo.js';
import {
  PlanAdmissionApplicationService,
  type PlanAdmissionApplication,
} from '../../src/execution/plan-admission-application-service.js';
import { PlanProposalUnavailableError } from '../../src/execution/plan-proposal-store.js';
import { WorkGraphRuntimeService } from '../../src/execution/work-graph-runtime-service.js';
import { TaskEventRepo } from '../../src/storage/task-event-repo.js';
import { TaskExecutionEvidenceRepo } from '../../src/execution/execution-evidence-port.js';
import { authorizedBindingsFor, workGraphPlan } from '../support/planning-agent-plans.js';

function harness(options: { eraseProposal?: boolean } = {}) {
  const db = new Database(':memory:');
  initializeDatabaseSchema(db);
  db.prepare(`INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
    VALUES ('revision-test', 'sha256:test', 'native', '2026-11-09T00:00:00.000Z')`).run();
  const taskRepo = new TaskRepo(db);
  const taskRuntimeService = new TaskRuntimeService({
    taskEngine: new TaskEngine(taskRepo, '/tmp/metawork-test-snapshots'),
    taskRepo,
  });
  const proposals = new PlanProposalRepo(db);
  const results = new PlanAdmissionResultRepo(db);
  const scheduler = new ConversationTaskSchedulerRepo(db);
  const subtaskRepo = new SubtaskRepo(db);
  const revisionRepo = new WorkGraphRevisionRepo(db);
  const workGraphRuntimeService = new WorkGraphRuntimeService(
    subtaskRepo,
    new TaskEventRepo(db),
    revisionRepo,
    new TaskExecutionEvidenceRepo(db),
  );
  const service = new PlanAdmissionApplicationService({
    db,
    taskRuntimeService,
    workGraphRuntimeService,
    planProposals: proposals,
    admissionResults: results,
    conversationTaskSchedulerRepo: scheduler,
  });
  const plan = workGraphPlan({ goal: 'atomic admission', capabilityClass: 'general' });
  plan.id = 'plan_atomic';
  plan.workGraph!.subtasks[0]!.contextRefs = [];
  const proposal = {
    id: 'event_plan_atomic',
    configurationRevision: 'revision-test',
    occurredAt: '2026-11-09T00:00:00.000Z',
    sessionId: 'planner-atomic',
    conversationId: 'conversation-atomic',
    sourceTurnId: 'turn-atomic',
    proposal: plan,
    requestText: 'atomic admission',
    generationId: 'generation-atomic',
    proposalSource: 'initial' as const,
    targetGraphRevision: 1,
  };
  proposals.save({ request: proposal });
  if (options.eraseProposal) db.prepare('DELETE FROM task_plan_proposals WHERE proposal_id = ?').run(proposal.id);
  const input = (overrides: Partial<PlanAdmissionApplication> = {}): PlanAdmissionApplication => ({
    taskId: 'task_event_plan_atomic',
    existingTaskId: null,
    owner: {
      conversationId: 'conversation-atomic',
      workspaceId: 'workspace-atomic',
      plannerSessionId: 'planner-atomic',
    },
    workspaceExecution: {
      executionMode: 'conversation_git', source: 'planner', reason: 'test',
      deliveryPolicy: 'none', targetPaths: [],
    },
    workspaceIntent: null,
    proposalSource: 'initial',
    generationId: 'generation-atomic',
    graphRevision: 1,
    scheduleState: 'eligible',
    schedulingReason: null,
    workGraph: plan.workGraph!,
    authorizedBindingsBySubtask: authorizedBindingsFor(plan),
    operationId: 'decision_atomic',
    proposalId: proposal.id,
    requestText: 'atomic admission',
    queryId: 'query-atomic',
    task: {
      title: 'atomic admission',
      goal: 'atomic admission',
      resources: [],
      publicDeliveryBaseline: {},
      startServiceAfterPublish: false,
      accountId: 'account-atomic',
    },
    ...overrides,
  });
  return {
    db, proposals, results, scheduler, subtaskRepo, revisionRepo,
    taskRuntimeService, workGraphRuntimeService, service, plan, proposal, input,
  };
}

const count = (db: Database.Database, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;

describe('atomic plan admission application', () => {
  it('commits the Task, its initial origin, the graph revision and the applied outcome together', () => {
    const f = harness();
    const applied = f.service.apply(f.input());
    expect(applied).toMatchObject({ status: 'authorized', taskId: 'task_event_plan_atomic', replayed: false });
    expect(f.revisionRepo.findActive('task_event_plan_atomic')).toMatchObject({
      revision: 1,
      generationId: 'generation-atomic',
      authorizedOperationId: 'decision_atomic',
      status: 'active',
    });
    expect(f.subtaskRepo.listActiveByTask('task_event_plan_atomic')).toHaveLength(1);
    expect(f.proposals.findInitialForTask('task_event_plan_atomic')?.request.id).toBe(f.proposal.id);
    expect(f.results.find(f.proposal.id)).toMatchObject({
      operationId: 'admission_plan_atomic',
      status: 'authorized',
      taskId: 'task_event_plan_atomic',
      graphRevision: 1,
    });
    expect(f.scheduler.getSlot('conversation-atomic').activeTaskId).toBe('task_event_plan_atomic');
    // The Task starts executing only after admission returns to the Session.
    expect(f.taskRuntimeService.findTask('task_event_plan_atomic')?.status).toBe('queued');
  });

  it('records queued admission without preparing execution or losing the graph', () => {
    const f = harness();
    f.taskRuntimeService.createTask({
      id: 'task_blocking', title: 'blocking', goal: 'blocking',
      accountId: 'account-atomic', conversationId: 'conversation-atomic',
    });
    f.scheduler.claimSlot('conversation-atomic', 'task_blocking', 'reservation-1', '2026-11-09T00:00:00.000Z');
    // Admission was authorized as eligible, but the slot is gone by commit time.
    const applied = f.service.apply(f.input());
    expect(applied).toMatchObject({ status: 'queued', taskId: 'task_event_plan_atomic' });
    expect(f.subtaskRepo.listActiveByTask('task_event_plan_atomic')).toHaveLength(1);
    expect(f.results.find(f.proposal.id)).toMatchObject({
      status: 'queued',
      detail: { schedulingReason: 'work graph authorized' },
    });
    expect(f.scheduler.listQueuedTasks('conversation-atomic')).toEqual(['task_event_plan_atomic']);
  });

  it('replays the durable outcome instead of applying a second Task or graph revision', () => {
    const f = harness();
    f.service.apply(f.input());
    const replay = f.service.apply(f.input({ operationId: 'decision_other' }));
    expect(replay).toMatchObject({ status: 'authorized', taskId: 'task_event_plan_atomic', replayed: true });
    expect(count(f.db, 'tasks')).toBe(1);
    expect(count(f.db, 'work_graph_revisions')).toBe(1);
    expect(count(f.db, 'task_plan_admission_results')).toBe(1);
    expect(f.revisionRepo.findActive('task_event_plan_atomic')?.authorizedOperationId).toBe('decision_atomic');
  });

  it('rolls the Task and origin back when the authorized graph cannot be persisted', () => {
    const f = harness();
    expect(() => f.service.apply(f.input({ graphRevision: 2 })))
      .toThrow('authorized Work Graph could not be persisted: revision_conflict');
    expect(f.taskRuntimeService.findTask('task_event_plan_atomic')).toBeNull();
    expect(count(f.db, 'task_plan_origins')).toBe(0);
    expect(count(f.db, 'work_graph_revisions')).toBe(0);
    expect(count(f.db, 'task_plan_admission_results')).toBe(0);
    expect(f.scheduler.getSlot('conversation-atomic').activeTaskId).toBeNull();
  });

  it('refuses to apply a proposal that was erased after preparation', () => {
    const f = harness({ eraseProposal: true });
    expect(() => f.service.apply(f.input())).toThrow(PlanProposalUnavailableError);
    expect(count(f.db, 'tasks')).toBe(0);
  });

  it('refuses a Turn cancelled between preparation and commit', () => {
    const f = harness();
    f.db.prepare(`INSERT INTO conversation_turn_cancellations
      (account_id, conversation_id, turn_id, requested_at)
      VALUES ('account-atomic', 'conversation-atomic', 'turn-atomic', '2026-11-09T00:00:01.000Z')`).run();
    expect(() => f.service.apply(f.input())).toThrow(PlanProposalUnavailableError);
    expect(count(f.db, 'tasks')).toBe(0);
  });

  it('applies a replan to the existing Task without creating another one', () => {
    const f = harness();
    f.service.apply(f.input());
    const replan = harness();
    // Replan needs the same Task and a newer revision on the same generation.
    const first = replan.service.apply(replan.input());
    expect(first.status).toBe('authorized');
    const next = replan.service.apply(replan.input({
      existingTaskId: 'task_event_plan_atomic',
      proposalSource: 'replan',
      graphRevision: 2,
      operationId: 'decision_replan',
      proposalId: null,
      scheduleState: 'eligible',
    }));
    expect(next).toMatchObject({ status: 'authorized', taskId: 'task_event_plan_atomic' });
    expect(count(replan.db, 'tasks')).toBe(1);
    expect(replan.revisionRepo.findActive('task_event_plan_atomic')).toMatchObject({
      revision: 2,
      authorizedOperationId: 'decision_replan',
    });
  });
});
