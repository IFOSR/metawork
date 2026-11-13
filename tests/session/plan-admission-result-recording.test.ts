import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initializeDatabaseSchema } from '../../src/storage/schema.js';
import { PlanProposalRepo } from '../../src/storage/plan-proposal-repo.js';
import { PlanAdmissionResultRepo } from '../../src/storage/plan-admission-result-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { ConversationTaskSchedulerRepo } from '../../src/storage/conversation-task-scheduler-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskRuntimeService } from '../../src/task/task-runtime-service.js';
import { SessionControlRuntime } from '../../src/session/session-control-runtime.js';
import { SessionPresentationService } from '../../src/session/session-presentation-service.js';
import type { ControlDecision } from '../../src/control/control-contracts.js';
import type { PlanAdmissionRequest } from '../../src/execution/plan-admission-policy.js';
import { proposedTaskId } from '../../src/execution/plan-proposal-store.js';
import { testPlanAdmissionDeps } from '../support/plan-admission-application.js';
import { authorizedBindingsFor, workGraphPlan } from '../support/planning-agent-plans.js';

function harness(planId = 'plan_admission_result') {
  const database = new Database(':memory:');
  initializeDatabaseSchema(database);
  database.prepare(`INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
    VALUES ('revision-test', 'sha256:test', 'native', '2026-11-09T00:00:00.000Z')`).run();
  const taskRepo = new TaskRepo(database);
  const taskRuntimeService = new TaskRuntimeService({
    taskEngine: new TaskEngine(taskRepo, '/tmp/metawork-test-snapshots'),
    taskRepo,
  });
  const proposals = new PlanProposalRepo(database);
  const results = new PlanAdmissionResultRepo(database);
  const admissionDeps = testPlanAdmissionDeps(
    database,
    taskRuntimeService,
    new ConversationTaskSchedulerRepo(database),
  );
  const plan = workGraphPlan({ goal: 'record the admission outcome', capabilityClass: 'general' });
  plan.id = planId;
  plan.workGraph!.subtasks[0]!.contextRefs = [];
  const request: PlanAdmissionRequest = {
    id: `event_${planId}`,
    configurationRevision: 'revision-test',
    occurredAt: '2026-11-09T00:00:00.000Z',
    sessionId: 'planner-record',
    conversationId: 'conversation-record',
    sourceTurnId: 'turn-record',
    proposal: plan,
    requestText: 'record the admission outcome',
    generationId: 'generation-record',
    proposalSource: 'initial',
    targetGraphRevision: 1,
  };
  proposals.save({ request });
  const output: string[] = [];
  const replies: string[] = [];
  const prepared: string[] = [];
  const runtime = new SessionControlRuntime({
    planProposals: proposals,
    planAdmissionResults: results,
    planAdmissionApplication: admissionDeps.planAdmissionApplication,
    sessionId: 'planner-record',
    conversationId: 'conversation-record',
    accountId: 'account-record',
    taskRuntimeService,
    conversationTaskSchedulerRepo: new ConversationTaskSchedulerRepo(database),
    orchestration: {} as never,
    activeExecutions: {} as never,
    presentation: new SessionPresentationService(),
    callbacks: {
      appendOutput: (...lines: string[]) => output.push(...lines),
      prepareTaskExecution: taskId => prepared.push(taskId),
      refreshRuntimeState: () => undefined,
      setCurrentTaskId: () => undefined,
      getCurrentTaskId: () => null,
      setFocusContext: () => undefined,
      resolveRequestText: () => request.requestText,
      deliverDirectReply: (_input, reply) => replies.push(reply),
      cancelTask: async () => undefined,
    },
  });
  return {
    database, plan, request, proposals, results, runtime, output, replies, prepared,
    taskRuntimeService, taskId: proposedTaskId(request),
  };
}

function authorizedDecision(input: {
  plan: ReturnType<typeof workGraphPlan>;
  eventId: string;
  taskId: string;
  scheduleState?: 'eligible' | 'queued';
}): ControlDecision {
  return {
    schemaVersion: 5,
    configurationRevision: 'revision-test',
    id: `decision_${input.eventId}`,
    eventId: input.eventId,
    reason: 'work graph authorized',
    action: {
      type: 'authorize_task_plan',
      taskId: input.taskId,
      task: input.plan.task,
      workGraph: input.plan.workGraph!,
      scheduleState: input.scheduleState ?? 'eligible',
      owner: {
        conversationId: 'conversation-record',
        workspaceId: null,
        plannerSessionId: 'planner-record',
      },
      authorizedBindingsBySubtask: authorizedBindingsFor(input.plan),
      generationId: 'generation-record',
      graphRevision: 1,
      proposalSource: 'initial',
      workspaceExecution: {
        executionMode: 'in_place', source: 'planner', reason: 'test',
        deliveryPolicy: 'none', targetPaths: [],
      },
    },
  } as ControlDecision;
}

describe('plan admission outcome recording', () => {
  it('records an authorized outcome under the admission operation identity', async () => {
    const setup = harness();
    const decision = authorizedDecision({
      plan: setup.plan,
      eventId: setup.request.id,
      taskId: setup.taskId,
    });
    await setup.runtime.forInput(setup.request.requestText, 'conversation-record').apply(decision);
    expect(setup.results.find(setup.request.id)).toMatchObject({
      operationId: `admission_${setup.plan.id}`,
      proposalId: setup.request.id,
      status: 'authorized',
      taskId: setup.taskId,
      generationId: 'generation-record',
      graphRevision: 1,
      detail: { proposalSource: 'initial' },
    });
    expect(setup.prepared).toEqual([setup.taskId]);
    // The proposal keeps its transport receipt independent of the applied result.
    expect(setup.proposals.find(setup.request.id)?.delivery).toBe('pending');
  });

  it('records a queued outcome with the scheduling reason', async () => {
    const setup = harness('plan_admission_queued');
    setup.taskRuntimeService.createTask({
      id: 'task_blocking', title: 'blocking task', goal: 'blocking task',
      accountId: 'account-record', conversationId: 'conversation-record',
    });
    setup.database.prepare(`INSERT INTO conversation_task_slots
      (conversation_id, active_task_id, state, reservation_id, updated_at)
      VALUES ('conversation-record', ?, 'occupied', 'reservation-1', '2026-11-09T00:00:00.000Z')`)
      .run('task_blocking');
    const decision = authorizedDecision({
      plan: setup.plan,
      eventId: setup.request.id,
      taskId: setup.taskId,
      scheduleState: 'queued',
    });
    decision.action.type === 'authorize_task_plan'
      ? decision.action.schedulingReason = 'conversation_slot_occupied'
      : undefined;
    await setup.runtime.forInput(setup.request.requestText, 'conversation-record').apply(decision);
    expect(setup.results.find(setup.request.id)).toMatchObject({
      status: 'queued',
      taskId: setup.taskId,
      detail: { schedulingReason: 'conversation_slot_occupied' },
    });
  });

  it('records rejection, clarification and no-action once per proposal', async () => {
    for (const [status, action] of [
      ['rejected', { type: 'reject_request' }],
      ['clarification', { type: 'request_clarification', question: '请补充目标文件' }],
      ['no_action', { type: 'no_op' }],
    ] as const) {
      const setup = harness(`plan_${status}`);
      const decision = {
        schemaVersion: 5,
        configurationRevision: 'revision-test',
        id: `decision_${setup.request.id}`,
        eventId: setup.request.id,
        reason: `${status} reason`,
        action,
      } as ControlDecision;
      await setup.runtime.forInput(setup.request.requestText, 'conversation-record').apply(decision);
      expect(setup.results.find(setup.request.id)).toMatchObject({ status });
      const outputAfterFirst = setup.output.length;
      // A replayed decision must not emit the same user-visible conclusion twice.
      await setup.runtime.forInput(setup.request.requestText, 'conversation-record').apply(decision);
      expect(setup.output).toHaveLength(outputAfterFirst);
      expect(setup.replies).toHaveLength(0);
    }
  });

  it('refuses a second, different conclusion for the same proposal', async () => {
    const setup = harness('plan_admission_conflict');
    const reply = {
      schemaVersion: 5,
      configurationRevision: 'revision-test',
      id: `decision_reply_${setup.request.id}`,
      eventId: setup.request.id,
      reason: 'no runtime action required',
      action: { type: 'no_op' },
    } as ControlDecision;
    await setup.runtime.forInput(setup.request.requestText, 'conversation-record').apply(reply);
    const reject = {
      ...reply,
      id: `decision_reject_${setup.request.id}`,
      action: { type: 'reject_request' },
    } as ControlDecision;
    await expect(
      setup.runtime.forInput(setup.request.requestText, 'conversation-record').apply(reject),
    ).rejects.toThrow(`plan admission result conflict: ${setup.request.id}`);
    expect(setup.results.find(setup.request.id)).toMatchObject({ status: 'no_action' });
  });

  it('keeps the current behavior when no result store is configured', async () => {
    const setup = harness('plan_admission_without_store');
    const runtime = new SessionControlRuntime({
      planProposals: setup.proposals,
      planAdmissionApplication: testPlanAdmissionDeps(
        setup.database,
        setup.taskRuntimeService,
      ).planAdmissionApplication,
      sessionId: 'planner-record',
      conversationId: 'conversation-record',
      accountId: 'account-record',
      taskRuntimeService: new TaskRuntimeService({
        taskEngine: new TaskEngine(new TaskRepo(setup.database), '/tmp/metawork-test-snapshots'),
        taskRepo: new TaskRepo(setup.database),
      }),
      orchestration: {} as never,
      activeExecutions: {} as never,
      presentation: new SessionPresentationService(),
      callbacks: {
        appendOutput: () => undefined,
        prepareTaskExecution: () => undefined,
        refreshRuntimeState: () => undefined,
        setCurrentTaskId: () => undefined,
        getCurrentTaskId: () => null,
        setFocusContext: () => undefined,
        resolveRequestText: () => '',
        deliverDirectReply: () => undefined,
        cancelTask: async () => undefined,
      },
    });
    await runtime.forInput('record the admission outcome').apply({
      schemaVersion: 5,
      configurationRevision: 'revision-test',
      id: `decision_${setup.request.id}`,
      eventId: setup.request.id,
      reason: 'rejected',
      action: { type: 'reject_request' },
    } as ControlDecision);
    expect(setup.results.find(setup.request.id)).toBeNull();
  });
});
