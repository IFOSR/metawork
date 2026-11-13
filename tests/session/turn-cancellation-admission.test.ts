import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionControlRuntime } from '../../src/session/session-control-runtime.js';
import { SessionPresentationService } from '../../src/session/session-presentation-service.js';
import { ControlApplicationRejectionError, ControlApplicationSettledError } from '../../src/control/control-workflow.js';
import type { ControlDecision } from '../../src/control/control-contracts.js';
import { initializeDatabaseSchema } from '../../src/storage/schema.js';
import { PlanProposalRepo } from '../../src/storage/plan-proposal-repo.js';
import { SqliteTurnCancellationStore } from '../../src/storage/turn-cancellation-repo.js';
import { SqliteConversationDeletionStore } from '../../src/storage/conversation-deletion-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskRuntimeService } from '../../src/task/task-runtime-service.js';
import { ConversationTaskSchedulerRepo } from '../../src/storage/conversation-task-scheduler-repo.js';
import { event } from '../support/plan-admission-fixture.js';
import { testPlanAdmissionApplication } from '../support/plan-admission-application.js';
import { authorizedBindingsFor, workGraphPlan } from '../support/planning-agent-plans.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture(resolveWorkspace?: () => Promise<string | null>, abandon = false) {
  const db = new Database(':memory:');
  databases.push(db);
  initializeDatabaseSchema(db);
  const proposals = new PlanProposalRepo(db);
  const cancellations = new SqliteTurnCancellationStore(db, 'account');
  const taskRepo = new TaskRepo(db);
  const tasks = new TaskRuntimeService({ taskRepo, taskEngine: new TaskEngine(taskRepo, '/tmp/metawork-cancellation-tests') });
  const scheduler = new ConversationTaskSchedulerRepo(db);
  const plan = workGraphPlan({ goal: 'Implement parser', capabilityClass: 'code_edit' });
  const request = { ...structuredClone(event), proposal: plan, conversationId: 'conv', sourceTurnId: 'turn' };
  proposals.save({ request });
  if (abandon) tasks.createTask({ id: 'old', title: 'old', goal: 'old', accountId: 'account', conversationId: 'conv' });
  const callbacks = {
    appendOutput: vi.fn(), refreshRuntimeState: vi.fn(), prepareTaskExecution: vi.fn(),
    setCurrentTaskId: vi.fn(), getCurrentTaskId: () => null, setFocusContext: vi.fn(),
    resolveRequestText: () => 'Implement parser', deliverDirectReply: vi.fn(), onDecisionApplying: vi.fn(),
    cancelTask: vi.fn(async () => ({ taskId: 'old', status: 'cleared' as const, residue: [] })),
  };
  const application = testPlanAdmissionApplication({
    db, taskRuntimeService: tasks, planProposals: proposals,
    conversationTaskSchedulerRepo: scheduler,
  });
  const runtime = new SessionControlRuntime({
    sessionId: 'session_1', conversationId: 'conv', accountId: 'account', planProposals: proposals,
    planAdmissionResults: application.admissionResults,
    planAdmissionApplication: application.service,
    taskRuntimeService: tasks, conversationTaskSchedulerRepo: scheduler,
    resolveUserWorkspaceRoot: resolveWorkspace,
    taskStateAuthority: {} as never, orchestration: {} as never, activeExecutions: {} as never,
    presentation: new SessionPresentationService(), callbacks,
  });
  const decision = {
    schemaVersion: 5, configurationRevision: request.configurationRevision,
    id: 'decision', eventId: request.id, reason: 'authorized',
    action: {
      type: 'authorize_task_plan', taskId: `task_${request.id}`, task: plan.task,
      workGraph: plan.workGraph, generationId: request.generationId, graphRevision: 1,
      authorizedBindingsBySubtask: authorizedBindingsFor(plan), proposalSource: 'initial', scheduleState: 'queued',
      owner: { conversationId: 'conv', workspaceId: 'workspace', plannerSessionId: 'session_1' },
      workspaceExecution: { executionMode: 'conversation_git', source: 'planner', reason: 'test', deliveryPolicy: 'none', targetPaths: [] },
      ...(abandon ? { conflictResolution: { oldTaskId: 'old' } } : {}),
    },
  } as ControlDecision;
  return { db, proposals, cancellations, tasks, callbacks, runtime, request, decision };
}

describe('durable lifecycle fencing at proposal application', () => {
  it.each(['authorize_task_plan', 'deliver_direct_reply', 'request_clarification'] as const)(
    'rejects cancelled %s before presentation or Task effects', async type => {
      const f = fixture();
      f.cancellations.request('conv', 'turn', event.occurredAt);
      const decision = type === 'authorize_task_plan' ? f.decision : {
        ...f.decision, action: type === 'deliver_direct_reply'
          ? { type, response: 'late answer' } : { type, question: 'late question' },
      } as ControlDecision;
      await expect(f.runtime.forInput().apply(decision)).rejects.toBeInstanceOf(ControlApplicationRejectionError);
      expect(f.callbacks.onDecisionApplying).not.toHaveBeenCalled();
      expect(f.callbacks.appendOutput).not.toHaveBeenCalled();
      expect(f.callbacks.deliverDirectReply).not.toHaveBeenCalled();
      expect(f.callbacks.prepareTaskExecution).not.toHaveBeenCalled();
      expect(f.tasks.findTask(`task_${event.id}`)).toBeNull();
    },
  );

  it.each(['cancel', 'delete', 'erase'] as const)('rechecks %s during Workspace IO before creating or queueing a Task', async kind => {
    let entered!: () => void;
    let resume!: (root: string | null) => void;
    const started = new Promise<void>(done => { entered = done; });
    const waiting = new Promise<string | null>(done => { resume = done; });
    const f = fixture(() => { entered(); return waiting; });
    const application = f.runtime.forInput().apply(f.decision);
    await started;
    if (kind === 'cancel') f.cancellations.request('conv', 'turn', event.occurredAt);
    else if (kind === 'delete') new SqliteConversationDeletionStore(f.db).begin('account', 'conv');
    else f.db.prepare('DELETE FROM task_plan_proposals WHERE proposal_id = ?').run(event.id);
    const assertion = expect(application).rejects.toBeInstanceOf(ControlApplicationRejectionError);
    resume(null);
    await assertion;
    expect(f.tasks.findTask(`task_${event.id}`)).toBeNull();
    expect(f.proposals.findInitialForTask(`task_${event.id}`)).toBeNull();
    expect(f.db.prepare('SELECT count(*) AS count FROM task_schedule_entries').get()).toEqual({ count: 0 });
    expect(f.callbacks.prepareTaskExecution).not.toHaveBeenCalled();
  });

  it('records an already applied abandonment as settled when cancellation arrives during later IO', async () => {
    let f!: ReturnType<typeof fixture>;
    f = fixture(async () => { f.cancellations.request('conv', 'turn', event.occurredAt); return null; }, true);
    await expect(f.runtime.forInput().apply(f.decision)).rejects.toBeInstanceOf(ControlApplicationSettledError);
    expect(f.callbacks.cancelTask).toHaveBeenCalledTimes(1);
    expect(f.tasks.findTask(`task_${event.id}`)).toBeNull();
    expect(f.callbacks.prepareTaskExecution).not.toHaveBeenCalled();
  });

  it('does not replay an erased proposal as an unowned raw plan', async () => {
    const f = fixture();
    new SqliteConversationDeletionStore(f.db).begin('account', 'conv');
    new SqliteConversationDeletionStore(f.db).cleanLocal('account', 'conv');
    await expect(f.runtime.forInput().apply(f.decision)).rejects.toMatchObject({ code: 'proposal_missing' });
    expect(f.callbacks.onDecisionApplying).not.toHaveBeenCalled();
    expect(f.tasks.findTask(`task_${event.id}`)).toBeNull();
  });
});
