import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { runMigrations as runSchema51 } from '../support/schema51-baseline.js';
import { ControlKernel } from '../../src/kernel/control-kernel.js';
import { SqliteTaskStateFactsReader } from '../../src/storage/task-state-facts-reader.js';
import { readTaskEvaluationInput, type TaskStateRawFacts } from '../../src/task/task-state-facts.js';
import { evaluateTaskState, NO_TASK_CLEANUP } from '../../src/task/task-state.js';
import { TaskStateAuthority } from '../../src/task/task-state-authority.js';
import { createTaskLifecyclePort, createTaskStateAuthority } from '../../src/account/task-state-composition.js';
import { TaskStateChangeRepo, TaskStateProjectionOutbox } from '../../src/storage/task-state-change-repo.js';
import { SqliteConversationActivityProjection } from '../../src/storage/conversation-activity-projection-repo.js';
import { selectTaskDispatches } from '../../src/kernel/task-scheduler.js';
import { createSqliteTaskStateTransaction } from '../../src/storage/task-lifecycle-port-adapter.js';
import { ConversationTaskSchedulerRepo } from '../../src/storage/conversation-task-scheduler-repo.js';
import { taskRecord, setTaskStatus } from '../support/task-state-fixture.js';
import { emptyMetaWorkClientState } from '../../planner/AnyFusion-Pi/packages/coding-agent/src/modes/metawork-tui/model.js';
import { reduceGatewayEvent } from '../../planner/AnyFusion-Pi/packages/coding-agent/src/modes/metawork-tui/reducer.js';

function raw(overrides: Partial<TaskStateRawFacts> = {}): TaskStateRawFacts {
  return { task: taskRecord(), activeGraph: null, subtasks: [], dispatches: [], receipts: [], publications: [],
    retryWakes: [], replans: [], pendingResult: null, pendingPermission: null, service: null, serviceRequired: false,
    slot: 'none', cleanup: NO_TASK_CLEANUP, completionRequirements: [], capacityWaiting: false,
    externalOutcomeUnknown: false, operationResults: [], cancelFence: false, partialAcceptancePending: false,
    ...overrides };
}
function evaluate(facts: TaskStateRawFacts) {
  return evaluateTaskState({ ...readTaskEvaluationInput(facts), taskId: facts.task.id,
    currentStatus: facts.task.status, cancelFence: facts.cancelFence, observedAt: '2026-10-22T00:00:00Z' });
}
describe('task state review regressions', () => {
  it('rejects a lower task version delivered later at the same conversation watermark', () => {
    const event = (sequence: number, status: string, stateVersion: number) => ({
      protocolVersion: 2, eventId: `event-${sequence}`, sequence, accountId: 'account', conversationId: 'connection',
      requestId: `request-${sequence}`, turnId: null, kind: 'task_view_snapshot', occurredAt: '2026-10-22T00:00:00Z',
      payload: { queryVersion: 'task_view_v2', requestId: `request-${sequence}`, targetConversationId: 'conv',
        turnId: 'turn', taskId: 'task', title: 'Task', status, asOfSequence: 10,
        state: { status, stateVersion }, lifecycle: { status, stateVersion, pendingActions: [], reason: { code: 'none' } },
        subtasks: [], pendingPermission: null } });
    let state = reduceGatewayEvent(emptyMetaWorkClientState(), event(1, 'succeeded', 5) as never);
    state = reduceGatewayEvent(state, event(2, 'running', 4) as never);
    expect(state.conversations.conv!.turns.turn!.taskStatus).toBe('succeeded');
  });
  it('scopes delivery evidence to the required subtask', () => {
    const facts = raw({ subtasks: [{ id: 'b', title: 'B', status: 'done', dependencySubtaskIds: [] }],
      completionRequirements: [{ key: 'delivery:b', kind: 'delivery', label: 'B', subtaskId: 'b', serviceId: null }],
      publications: [{ id: 'publication_b', subtaskId: 'b', status: 'integrated', deliveryStatus: 'failed' }],
      operationResults: [{ operationKey: 'delivery:publication_z_for_a', operationKind: 'delivery', outcome: 'success',
        reasonCode: null, message: 'A delivered', evidenceRefs: ['publication:a'] }] });
    expect(readTaskEvaluationInput(facts).requiredWork[0]!.state).not.toBe('completed');
  });
  it('requires delivery success rather than absence of failure', () => {
    const facts = raw({ subtasks: [{ id: 'a', title: 'A', status: 'done', dependencySubtaskIds: [] }],
      completionRequirements: [{ key: 'delivery:a', kind: 'delivery', label: 'A', subtaskId: 'a', serviceId: null }],
      publications: [{ id: 'publication_a', subtaskId: 'a', status: 'integrated', deliveryStatus: null }] });
    expect(evaluate(facts).status).not.toBe('succeeded');
  });
  it('ends definite delivery failure instead of offering same-task resume', () => {
    const facts = raw({ subtasks: [{ id: 'a', title: 'A', status: 'done', dependencySubtaskIds: [] }],
      completionRequirements: [{ key: 'delivery:a', kind: 'delivery', label: 'A', subtaskId: 'a', serviceId: null }],
      publications: [{ id: 'publication_a', subtaskId: 'a', status: 'integrated', deliveryStatus: 'failed' }],
      operationResults: [{ operationKey: 'delivery:publication_a', operationKind: 'delivery', outcome: 'definite_failure',
        reasonCode: 'delivery_failed', message: 'permission denied', evidenceRefs: [] }] });
    expect(evaluate(facts).status).toBe('failed');
  });
  it('does not treat a cancelled subtask as a task-wide cancellation fence', () => {
    const db = new Database(':memory:');
    try {
      db.exec("CREATE TABLE kernel_decisions (id TEXT, task_id TEXT, action TEXT); CREATE TABLE kernel_decision_applications (decision_id TEXT, status TEXT); INSERT INTO kernel_decisions VALUES ('d', 'task_fixture', 'cancel_subtasks'); INSERT INTO kernel_decision_applications VALUES ('d', 'applied');");
      const reader = new SqliteTaskStateFactsReader({ db } as never);
      const fence = (reader as unknown as { readCancelFence(id: string): boolean }).readCancelFence('task_fixture');
      expect(fence).toBe(false);
    } finally { db.close(); }
  });
  it('does not automatically complete a task waiting for user confirmation', () => {
    const db = new Database(':memory:'); runMigrations(db);
    try {
      const repo = new TaskRepo(db);
      const task = new TaskEngine(repo, '/tmp/review-state').create({ title: 'Review', goal: 'Review' });
      setTaskStatus(db, task.id, 'needs_action');
      const authority = new TaskStateAuthority({ taskRepo: repo, lifecycle: createTaskLifecyclePort(db),
        transaction: createSqliteTaskStateTransaction(db), facts: { read: () => raw({ task: repo.findById(task.id)!,
          subtasks: [{ id: 'a', title: 'A', status: 'done', dependencySubtaskIds: [] }],
          completionRequirements: [{ key: 'execution:a', kind: 'execution', label: 'A', subtaskId: 'a', serviceId: null }] }) } });
      authority.reconcile({ taskId: task.id, decisionId: 'passive_observation', operationKey: 'passive_observation',
        actor: 'account-startup-recovery', reason: 'passively observed complete evidence' });
      expect(repo.findById(task.id)!.status).toBe('needs_action');
    } finally { db.close(); }
  });
  it('fences each new reservation of the same task with a new token', () => {
    const db = new Database(':memory:'); runMigrations(db);
    try {
      const task = new TaskEngine(new TaskRepo(db), '/tmp/review-state').create({ title: 'Review', goal: 'Review', conversationId: 'conv' });
      const scheduler = new ConversationTaskSchedulerRepo(db);
      scheduler.enqueueTask(task.id, 'conv', '2026-10-22T00:00:00Z');
      const first = scheduler.promoteNextQueued('conv', '2026-10-22T00:00:01Z');
      const firstSlot = scheduler.getSlot('conv');
      scheduler.releaseSlot('conv', task.id, '2026-10-22T00:00:02Z');
      scheduler.enqueueTask(task.id, 'conv', '2026-10-22T00:00:03Z');
      const second = scheduler.promoteNextQueued('conv', '2026-10-22T00:00:04Z');
      expect(second!.reservationId).not.toBe(first!.reservationId);
      expect(scheduler.releaseSlot('conv', task.id, '2026-10-22T00:00:05Z', firstSlot)).toBe(false);
      expect(scheduler.getSlot('conv').reservationId).toBe(second!.reservationId);
      const taskVersion = new TaskRepo(db).findById(task.id)!.stateVersion;
      scheduler.releaseSlotAndPromote('conv', task.id, '2026-10-22T00:00:06Z', () => false, true,
        { ...scheduler.getSlot('conv'), taskVersion: taskVersion + 1 });
      expect(scheduler.getSlot('conv').activeTaskId).toBe(task.id);
    } finally { db.close(); }
  });
  it('commits two user blockers atomically, preserves both and rolls back failed facts', () => {
    const db = new Database(':memory:'); runMigrations(db);
    try {
      const repo = new TaskRepo(db);
      const task = new TaskEngine(repo, '/tmp/review-state').create({ title: 'Two inputs', goal: 'Wait for inputs' });
      const authority = createTaskStateAuthority({ db, workUnitClaimService: { hasClaimedByTask: () => false } });
      for (const reason of ['缺少材料 A', '缺少权限 B']) authority.reconcile({
        taskId: task.id, decisionId: reason, operationKey: reason, actor: 'session-kernel-runtime', reason,
        facts: () => {
          repo.update(task.id, { dependencies: [...repo.findById(task.id)!.dependencies,
            { taskId: task.id, type: 'manual', description: reason, status: 'waiting', createdAt: reason }] });
          return [];
        },
      });
      expect(repo.findById(task.id)!.stateDetail.pendingActions.map(action => action.label)).toEqual(['缺少材料 A', '缺少权限 B']);
      const before = repo.findById(task.id)!;
      expect(() => authority.reconcile({ taskId: task.id, decisionId: 'broken', operationKey: 'broken',
        actor: 'session-kernel-runtime', reason: 'failure injection', facts: () => {
          repo.update(task.id, { dependencies: [] });
          throw new Error('injected persistence failure');
        } })).toThrow('injected persistence failure');
      expect(repo.findById(task.id)).toEqual(before);
      expect(new TaskStateChangeRepo(db).findByOperationKey(task.id, 'broken')).toBeNull();
      const outbox = new TaskStateProjectionOutbox(db);
      expect(outbox.listPending()).toHaveLength(2);
      const projection = new SqliteConversationActivityProjection(db);
      expect(projection.nextDirty()?.task.id).toBe(task.id);
      expect(outbox.listPending()).toHaveLength(0);
    } finally { db.close(); }
  });
  it('projects a structural kernel blocker as a system anomaly, never as a user input request', () => {
    const db = new Database(':memory:'); runMigrations(db);
    try {
      const repo = new TaskRepo(db);
      const task = new TaskEngine(repo, '/tmp/review-state').create({ title: 'Edges', goal: 'Deliver' });
      const authority = createTaskStateAuthority({ db, workUnitClaimService: { hasClaimedByTask: () => false } });
      authority.reconcile({
        taskId: task.id,
        decisionId: 'structure',
        operationKey: 'structure',
        actor: 'kernel-execution-runtime',
        reason: '上游结果未能交接给下游节点（系统问题）',
        facts: () => {
          repo.update(task.id, { dependencies: [{
            taskId: task.id,
            type: 'kernel_anomaly',
            description: '上游结果未能交接给下游节点（系统问题）',
            status: 'waiting',
            createdAt: '2026-10-28T00:00:00.000Z',
          }] });
          return [];
        },
      });
      const projected = repo.findById(task.id)!;
      expect(projected.status).toBe('needs_action');
      expect(projected.stateDetail.reason.code).toBe('system_anomaly');
      expect(projected.stateDetail.pendingActions).toEqual([]);
    } finally { db.close(); }
  });

  it('schedules remaining service work even when every Executor slot is busy', () => {
    expect(selectTaskDispatches({ account: { maxConcurrentTasks: 2, activeTaskCount: 1,
      maxConcurrentAttempts: 1, activeAttemptCount: 1, maxConcurrentAttemptsPerTask: 1 },
      conversations: [{ conversationId: 'conv', slotState: 'free', fairnessSequence: 0 }],
      candidates: [{ taskId: 'service', conversationId: 'conv', eligibleSince: 'now', priority: 'normal',
        aged: false, runnableAttemptCount: 0, runnableOperation: true, activeAttemptCount: 0, resourceConflict: false }],
    }).dispatches).toEqual([{ taskId: 'service', attemptCount: 0 }]);
  });
  it('classifies an old running row without a driver during migration', () => {
    const db = new Database(':memory:'); runSchema51(db);
    try {
      db.exec("INSERT INTO tasks (id,title,status,created_at,updated_at) VALUES ('legacy','Legacy','running','then','then');");
      runMigrations(db);
      expect(new TaskRepo(db).findById('legacy')!.status).toBe('needs_action');
    } finally { db.close(); }
  });
  it('quarantines a pending legacy event while preserving its original payload', () => {
    const db = new Database(':memory:'); runSchema51(db);
    try {
      db.pragma('foreign_keys = OFF');
      db.exec("INSERT INTO tasks (id,title,status,created_at,updated_at) VALUES ('legacy','Legacy','ready','then','then');");
      const payload = JSON.stringify({ type: 'dispatch_requested', taskId: 'legacy', schemaVersion: 5 });
      db.prepare(`INSERT INTO kernel_events (id,schema_version,event_type,correlation_id,session_id,task_id,event_json,
        available_at,status,configuration_revision,created_at,updated_at)
        VALUES ('legacy-event',5,'dispatch_requested','legacy','session','legacy',?,'then','pending','config','then','then')`).run(payload);
      runMigrations(db);
      expect(new TaskRepo(db).findById('legacy')?.status).toBe('needs_action');
      expect(db.prepare('SELECT status,last_error,event_json FROM kernel_events WHERE id = ?').get('legacy-event'))
        .toEqual({ status: 'failed', last_error: 'task_state_upgrade_requires_reauthorization', event_json: payload });
      expect(new TaskStateChangeRepo(db).listForTask('legacy')[0]?.evidenceRefs).toContain('legacy_status:ready');
    } finally { db.close(); }
  });
  it('does not infer all required work from done labels during legacy migration', () => {
    const db = new Database(':memory:'); runSchema51(db);
    try {
      db.exec("INSERT INTO tasks (id,title,status,start_service_after_publish,created_at,updated_at) VALUES ('legacy','Legacy','done',1,'then','then'); INSERT INTO subtasks (id,task_id,title,goal,status,required_capabilities_json,executor_bindings_json,created_at,updated_at) VALUES ('a','legacy','A','A','done','[]','[]','then','then');");
      runMigrations(db);
      expect(new TaskRepo(db).findById('legacy')!.status).not.toBe('succeeded');
    } finally { db.close(); }
  });
  it('permits explicit restart of a service handed over by a succeeded task', () => {
    const decision = new ControlKernel().decide({ schemaVersion: 5, configurationRevision: 'config',
      type: 'managed_service_requested', id: 'restart', correlationId: 'restart', causationId: null,
      occurredAt: '2026-10-22T00:00:00Z', sessionId: 'session', taskId: 'task_fixture',
      operation: 'restart', serviceId: 'service' }, { type: 'service_control',
      task: taskRecord({ status: 'succeeded' }), serviceTaskId: 'task_fixture', published: true } as never);
    expect(decision.action.type).toBe('control_managed_service');
  });
});

describe('service failure is repairable, not final', () => {
  const serviceRequirement = {
    key: 'service', kind: 'service' as const, label: '启动服务', subtaskId: null, serviceId: null,
  };
  const serviceOperation = (outcome: 'repair_pending' | 'definite_failure' | 'success') => ({
    operationKey: `service:start:backend:service_revision_x:attempt-1:0`,
    operationKind: 'service',
    outcome,
    reasonCode: outcome === 'success' ? null : 'service_start_failed',
    message: outcome === 'success' ? '服务已通过健康检查。' : '服务进程已退出，需显式重启',
    evidenceRefs: ['service:backend', 'attempt:attempt-1'],
  });

  it('keeps the Task running while a Kernel-authorized repair round is queued', () => {
    const facts = raw({
      subtasks: [{ id: 'a', title: 'A', status: 'done', dependencySubtaskIds: [] }],
      service: { serviceId: 'backend', state: 'failed', healthMessage: '服务进程已退出，需显式重启' },
      serviceRequired: true,
      completionRequirements: [
        { key: 'execution:a', kind: 'execution', label: 'A', subtaskId: 'a', serviceId: null },
        serviceRequirement,
      ],
      operationResults: [serviceOperation('repair_pending')],
    });
    const input = readTaskEvaluationInput(facts);
    expect(input.requiredWork.find(work => work.kind === 'service')).toMatchObject({ state: 'running' });
    expect(input.activeOperation?.phase).toBe('retrying');
    const evaluation = evaluate(facts);
    expect(evaluation.status).toBe('running');
    expect(evaluation.detail.reason.message).toContain('服务进程已退出');
    expect(evaluation.detail.phase).toBe('retrying');
    expect(evaluation.detail.pendingActions).toEqual([]);
  });

  it('reports a definite service failure only after the repair budget is spent', () => {
    const facts = raw({
      subtasks: [{ id: 'a', title: 'A', status: 'done', dependencySubtaskIds: [] }],
      service: { serviceId: 'backend', state: 'failed', healthMessage: '服务进程已退出，需显式重启' },
      serviceRequired: true,
      completionRequirements: [
        { key: 'execution:a', kind: 'execution', label: 'A', subtaskId: 'a', serviceId: null },
        serviceRequirement,
      ],
      operationResults: [serviceOperation('definite_failure')],
    });
    expect(readTaskEvaluationInput(facts).requiredWork.find(work => work.kind === 'service'))
      .toMatchObject({ state: 'failed' });
    expect(evaluate(facts).status).toBe('failed');
  });

  it('reads the latest service operation instead of one fixed key', () => {
    const facts = raw({
      subtasks: [{ id: 'a', title: 'A', status: 'done', dependencySubtaskIds: [] }],
      service: { serviceId: 'backend', state: 'failed', healthMessage: '服务进程已退出，需显式重启' },
      serviceRequired: true,
      completionRequirements: [
        { key: 'execution:a', kind: 'execution', label: 'A', subtaskId: 'a', serviceId: null },
        serviceRequirement,
      ],
      operationResults: [
        { ...serviceOperation('success'), operationKey: 'service:start:backend:revision_old:attempt-0:0' },
        { ...serviceOperation('repair_pending'), operationKey: 'service:start:backend:revision_new:attempt-1:1' },
      ],
    });
    // The newest round decides: the older success belongs to a superseded spec.
    expect(readTaskEvaluationInput(facts).requiredWork.find(work => work.kind === 'service'))
      .toMatchObject({ state: 'running' });
  });
});

describe('accepted result survives a newer failed metadata correction', () => {
  const acceptedReceipt = {
    attemptId: 'attempt_primary',
    subtaskId: 'a',
    terminalState: 'uncertified_result' as const,
    failureCode: 'completion_malformed',
    failureKind: 'completion_malformed',
    completedAt: '2026-10-28T14:29:59.000Z',
    accepted: true,
  };
  const failedCorrection = {
    attemptId: 'attempt_correction',
    subtaskId: 'a',
    terminalState: 'executor_failed' as const,
    failureCode: 'correction_exception',
    failureKind: 'correction_exception',
    completedAt: '2026-10-28T14:30:02.000Z',
    accepted: false,
  };

  it('closes the execution requirement from the accepted result, not the newest attempt', () => {
    const facts = raw({
      subtasks: [{ id: 'a', title: 'A', status: 'done', dependencySubtaskIds: [] }],
      receipts: [acceptedReceipt, failedCorrection],
      completionRequirements: [
        { key: 'execution:a', kind: 'execution', label: 'A', subtaskId: 'a', serviceId: null },
      ],
    });
    expect(readTaskEvaluationInput(facts).requiredWork[0]!.state).toBe('completed');
    expect(evaluate(facts).status).toBe('succeeded');
  });

  it('still requires action when nothing was accepted', () => {
    const facts = raw({
      subtasks: [{ id: 'a', title: 'A', status: 'awaiting_decision', dependencySubtaskIds: [] }],
      receipts: [{ ...acceptedReceipt, accepted: false }, failedCorrection],
      completionRequirements: [
        { key: 'execution:a', kind: 'execution', label: 'A', subtaskId: 'a', serviceId: null },
      ],
    });
    expect(readTaskEvaluationInput(facts).requiredWork[0]!.state).not.toBe('completed');
    expect(evaluate(facts).status).not.toBe('succeeded');
  });
});

describe('system block corrected to its proven conclusion', () => {
  it('concludes success when a system block is disproved by durable work evidence', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    try {
      const repo = new TaskRepo(db);
      const task = new TaskEngine(repo, '/tmp/review-state-converge').create({ title: 'Delivered', goal: 'Deliver' });
      const authority = createTaskStateAuthority({ db, workUnitClaimService: { hasClaimedByTask: () => false } });

      // 1. A system-caused block before any work is admitted or proven.
      authority.reconcile({
        taskId: task.id, decisionId: 'structure', operationKey: 'structure',
        actor: 'kernel-execution-runtime', reason: 'no authorized driver',
        facts: () => {
          repo.update(task.id, { dependencies: [{
            taskId: task.id, type: 'kernel_anomaly', description: '系统问题',
            status: 'waiting', createdAt: '2026-10-28T00:00:00Z',
          }] });
          return [];
        },
      });
      expect(repo.findById(task.id)!.status).toBe('needs_action');
      expect(repo.findById(task.id)!.stateDetail.reason.code).toBe('system_anomaly');

      // 2. The work completes. A later failed metadata correction is newer but
      //    proves nothing, so the certified result still closes the requirement.
      const configRevision = 'cfg';
      db.prepare(`INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
        VALUES (?, 'hash', 'native', '2026-10-28T00:00:00Z')`).run(configRevision);
      db.prepare(`INSERT INTO work_units (id, agent_class_name, agent_class_kind, created_at, updated_at)
        VALUES ('wu', 'pi-agent', 'executor', '2026-10-28T00:00:00Z', '2026-10-28T00:00:00Z')`).run();
      db.prepare(`INSERT INTO work_graph_revisions
        (id, task_id, revision, generation_id, configuration_revision, proposal_source, automatic_replan,
          status, created_at, updated_at, completion_requirements_json)
        VALUES ('rev_1', ?, 1, 'gen_1', ?, 'initial', 0, 'active',
          '2026-10-28T00:00:00Z', '2026-10-28T00:00:00Z', ?)`)
        .run(task.id, configRevision, JSON.stringify([
          { key: 'execution:a', kind: 'execution', label: 'A', subtaskId: 'a', serviceId: null },
        ]));
      db.prepare(`INSERT INTO subtasks (id, task_id, generation_id, graph_revision, title, goal, status,
        dependencies_json, context_refs_json, required_capabilities_json, executor_bindings_json,
        file_outputs_json, acceptance_json, risk_level, created_at, updated_at)
        VALUES ('a', ?, 'gen_1', 1, 'A', 'Deliver', 'done', '[]', '[]', '[]', '[]', '[]', '[]', 'low',
          '2026-10-28T00:00:00Z', '2026-10-28T00:00:00Z')`).run(task.id);
      const insertReceipt = (attemptId: string, terminalState: string, kind: string, completedAt: string) => {
        db.prepare(`INSERT INTO executor_attempt_receipts (
          attempt_id, execution_id, task_id, subtask_id, work_unit_id, agent_class_name,
          started_at, completed_at, terminal_state, raw_response, parsing_json, verification_json,
          attempt_kind, generation_id, graph_revision, configuration_revision,
          authorized_binding_json, binding_fingerprint)
          VALUES (?, 'exec', ?, 'a', 'wu', 'pi-agent', 'start', ?, ?, 'body', '{}', '{}', ?, 'gen_1', 1, ?,
            '{}', 'fp')`)
          .run(attemptId, task.id, completedAt, terminalState, kind, configRevision);
      };
      insertReceipt('attempt_primary', 'completed', 'primary', '2026-10-28T01:00:00Z');
      insertReceipt('attempt_correction', 'executor_failed', 'contract_correction', '2026-10-28T01:02:00Z');

      // 3. Recovery converges: every required item is proven, nothing waits.
      repo.update(task.id, { dependencies: [] });
      const result = authority.reconcile({
        taskId: task.id, decisionId: 'recovery:1', operationKey: 'recovery:1',
        actor: 'task-state-authority', reason: 'durable facts prove completion',
      });
      expect(result?.task.status).toBe('succeeded');
    } finally { db.close(); }
  });
});

describe('a stale input blocker does not outlive the work', () => {
  it('concludes success when every required item is complete and only a login blocker remains', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    try {
      const repo = new TaskRepo(db);
      const task = new TaskEngine(repo, '/tmp/review-state-stale-input').create({ title: 'PPT', goal: 'Deliver' });
      const authority = createTaskStateAuthority({ db, workUnitClaimService: { hasClaimedByTask: () => false } });
      // 1. The official-account gate blocks the Task before work starts.
      authority.reconcile({
        taskId: task.id, decisionId: 'gate', operationKey: 'gate',
        actor: 'kernel-execution-runtime', reason: 'official authorization state: logged_out',
        facts: () => {
          repo.update(task.id, { dependencies: [{
            taskId: task.id, type: 'manual', description: 'official authorization state: logged_out',
            status: 'waiting', createdAt: '2026-10-29T01:18:26.977Z',
          }] });
          return [];
        },
      });
      expect(repo.findById(task.id)!.status).toBe('needs_action');
      expect(repo.findById(task.id)!.stateDetail.pendingActions.map(action => action.kind))
        .toEqual(['provide_input']);

      // 2. The user resumed anyway and the Executor finished the work.
      const configRevision = 'cfg';
      db.prepare(`INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
        VALUES (?, 'hash', 'native', '2026-10-29T00:00:00Z')`).run(configRevision);
      db.prepare(`INSERT INTO work_units (id, agent_class_name, agent_class_kind, created_at, updated_at)
        VALUES ('wu', 'pi-agent', 'executor', '2026-10-29T00:00:00Z', '2026-10-29T00:00:00Z')`).run();
      db.prepare(`INSERT INTO work_graph_revisions
        (id, task_id, revision, generation_id, configuration_revision, proposal_source, automatic_replan,
          status, created_at, updated_at, completion_requirements_json)
        VALUES ('rev_1', ?, 1, 'gen_1', ?, 'initial', 0, 'active',
          '2026-10-29T00:00:00Z', '2026-10-29T00:00:00Z', ?)`)
        .run(task.id, configRevision, JSON.stringify([
          { key: 'execution:a', kind: 'execution', label: 'A', subtaskId: 'a', serviceId: null },
        ]));
      db.prepare(`INSERT INTO subtasks (id, task_id, generation_id, graph_revision, title, goal, status,
        dependencies_json, context_refs_json, required_capabilities_json, executor_bindings_json,
        file_outputs_json, acceptance_json, risk_level, created_at, updated_at)
        VALUES ('a', ?, 'gen_1', 1, 'A', 'Deliver', 'done', '[]', '[]', '[]', '[]', '[]', '[]', 'low',
          '2026-10-29T00:00:00Z', '2026-10-29T00:00:00Z')`).run(task.id);
      db.prepare(`INSERT INTO executor_attempt_receipts (
        attempt_id, execution_id, task_id, subtask_id, work_unit_id, agent_class_name,
        started_at, completed_at, terminal_state, raw_response, parsing_json, verification_json,
        attempt_kind, generation_id, graph_revision, configuration_revision,
        authorized_binding_json, binding_fingerprint)
        VALUES ('attempt_primary', 'exec', ?, 'a', 'wu', 'pi-agent', 'start', '2026-10-29T01:38:52Z',
          'completed', 'body', '{}', '{}', 'primary', 'gen_1', 1, ?, '{}', 'fp')`).run(task.id, configRevision);

      // 3. Recovery re-evaluates; the stale login blocker no longer asks for input.
      const result = authority.reconcile({
        taskId: task.id, decisionId: 'recovery:1', operationKey: 'recovery:1',
        actor: 'task-state-authority', reason: 'durable facts prove completion',
      });
      expect(result?.task.status).toBe('succeeded');
    } finally { db.close(); }
  });
});
