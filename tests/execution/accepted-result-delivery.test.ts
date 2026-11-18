import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabaseSchema } from '../../src/storage/schema.js';
import { createTaskStateAuthority } from '../../src/account/task-state-composition.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { WorkGraphRevisionRepo } from '../../src/storage/work-graph-revision-repo.js';
import { ConversationTaskSchedulerRepo } from '../../src/storage/conversation-task-scheduler-repo.js';
import { ControlEffectOutboxRepo } from '../../src/storage/effect-outbox-repo.js';
import { readAcceptedResultContinuations, readPendingTaskResult } from '../../src/storage/pending-task-result.js';
import { SqliteTaskActivityFacts } from '../../src/storage/task-activity-facts-repo.js';
import { projectTaskView } from '../../src/task/task-view.js';
import { ControlExecutionRuntime, type TaskControlDecision } from '../../src/execution/control-execution-runtime.js';
import { TaskCancellationCoordinator } from '../../src/execution/task-cancellation-coordinator.js';
import { WorkspacePublicationRepo } from '../../src/storage/workspace-publication-repo.js';
import { decideTaskControl } from '../../src/execution/task-control-policy.js';
import type { PendingResultIdentity } from '../../src/task/safe-result-identity.js';

const result: PendingResultIdentity = { taskId: 'task', generationId: 'generation', graphRevision: 1,
  subtaskId: 'final', attemptId: 'attempt', resultId: 'safe' };
const action = { type: 'accept_uncertified_result' as const, ...result };
const acceptanceKey = 'accept_result:attempt:safe';
const effectId = `result_continuation:${acceptanceKey}`;
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); });

function fixture() {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  initializeDatabaseSchema(db);
  db.exec(`
    INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
      VALUES ('revision', 'hash', 'native', 'now');
    INSERT INTO work_units (id, agent_class_name, agent_class_kind, created_at, updated_at)
      VALUES ('unit', 'pi', 'executor', 'now', 'now');
    INSERT INTO tasks (id, title, goal, status, account_id, conversation_id, created_at, updated_at)
      VALUES ('task', 'Report', 'Report', 'needs_action', 'local-default', 'conversation', 'now', 'now');
    INSERT INTO work_graph_revisions (id, task_id, revision, generation_id, status, configuration_revision, created_at, updated_at)
      VALUES ('graph', 'task', 1, 'generation', 'active', 'revision', 'now', 'now');
    INSERT INTO subtasks (id, task_id, generation_id, graph_revision, title, goal, status,
      dependencies_json, context_refs_json, required_capabilities_json, executor_bindings_json,
      file_outputs_json, acceptance_json, risk_level, created_at, updated_at)
      VALUES ('final', 'task', 'generation', 1, 'Report', 'Report', 'awaiting_decision',
        '[]', '[]', '[]', '[]', '[]', '[]', 'low', 'now', 'now');
    INSERT INTO executor_attempt_receipts (attempt_id, execution_id, task_id, subtask_id, work_unit_id, agent_class_name,
      started_at, completed_at, terminal_state, raw_response, parsing_json, verification_json,
      attempt_kind, generation_id, graph_revision, configuration_revision, authorized_binding_json, binding_fingerprint)
      VALUES ('attempt', 'execution', 'task', 'final', 'unit', 'pi', 'start', 'settled', 'uncertified_result', '',
        '{"resultObjects":{"safeProjectionId":"safe"}}', '{}', 'primary', 'generation', 1, 'revision', '{}', 'fingerprint');
    INSERT INTO result_objects (result_id, account_id, task_id, generation_id, source_subtask_id, attempt_id,
      kind, media_type, byte_length, completeness, content_hash, storage_uri, retention_class, created_at)
      VALUES ('safe', 'local-default', 'task', 'generation', 'final', 'attempt', 'safe_projection',
        'text/markdown', 20, 'partial', 'hash', 'memory://safe', 'task', 'now');
  `);
  const taskRepo = new TaskRepo(db);
  const subtasks = new SubtaskRepo(db);
  const scheduler = new ConversationTaskSchedulerRepo(db);
  const effects = new ControlEffectOutboxRepo(db);
  const authority = createTaskStateAuthority({ db, workUnitClaimService: { hasClaimedByTask: () => false } });
  const stage = vi.fn(async () => { throw new Error('封存文件校验失败'); });
  const coordinator = new TaskCancellationCoordinator({ db, subtaskRepo: subtasks,
    taskRuntimeService: { findTask: (id: string) => taskRepo.findById(id) },
    workGraphRevisionRepo: new WorkGraphRevisionRepo(db), publicationRepo: new WorkspacePublicationRepo(db),
  } as never);
  vi.spyOn(coordinator, 'completionBlockedReasons').mockReturnValue([]);
  const snapshot = vi.spyOn(coordinator, 'buildSnapshot');
  const runtime = new ControlExecutionRuntime({
    taskStateAuthority: authority, taskRuntimeService: { findTask: (id: string) => taskRepo.findById(id) },
    subtaskRepo: subtasks, workGraphRevisionRepo: new WorkGraphRevisionRepo(db),
    conversationTaskSchedulerRepo: scheduler, cancellationCoordinator: coordinator,
    effectOutboxRepo: effects, attemptRunner: { stageAcceptedResult: stage },
    taskEventRepo: {}, dispatchItemRepo: {}, sessionId: 'conversation', callbacks: {},
  } as never);
  const seam = runtime as unknown as {
    applyResultDecision(decision: TaskControlDecision): void;
    drainResultContinuations(taskId: string): Promise<boolean>;
  };
  const accept = (id: string) => {
    expect(decideTaskControl(coordinator.buildSnapshot('task', result),
      { kind: 'accept_result', taskId: 'task', expectedResult: result }).authorized).toBe(true);
    seam.applyResultDecision({ id, eventId: id, configurationRevision: 'revision',
      reason: 'explicit acceptance', action });
  };
  const view = () => projectTaskView(new SqliteTaskActivityFacts(db).read(taskRepo.findById('task')!, null));
  return { db, taskRepo, subtasks, scheduler, effects, stage, snapshot, coordinator, seam, accept, view };
}

describe('accepted result delivery with durable SQLite facts', () => {
  it('blocks on delivery failure, preserves acceptance, and explicitly retries only delivery', async () => {
    const f = fixture();
    f.accept('first-accept');
    f.accept('duplicate-before-delivery');
    expect(f.taskRepo.findById('task')?.status).toBe('queued');
    expect(readPendingTaskResult(f.db, 'task')).toBeNull();
    expect(readAcceptedResultContinuations(f.db, 'task')).toMatchObject([{ result, status: 'pending' }]);
    expect(await f.seam.drainResultContinuations('task')).toBe(false);
    expect(f.effects.find(effectId)).toMatchObject({ status: 'uncertain', deliveryAttempts: 1 });
    expect(f.view()).toMatchObject({ status: 'needs_action', state: { reason: { code: 'delivery_failed' } },
      pendingActions: [{ label: '重试已接受结果的交付', result }] });
    expect(f.view().state.reason.message).toContain('封存文件校验失败');
    await f.seam.drainResultContinuations('task');
    expect(f.stage).toHaveBeenCalledTimes(1);

    f.stage.mockImplementation(async () => { f.subtasks.updateStatus('final', 'done'); });
    f.accept('retry-delivery');
    expect(f.taskRepo.findById('task')?.status).toBe('queued');
    expect(await f.seam.drainResultContinuations('task')).toBe(true);
    expect(f.effects.find(effectId)).toMatchObject({ status: 'sent', deliveryAttempts: 2 });
    expect(f.subtasks.findById('final')?.status).toBe('done');
    expect(f.view().pendingActions).toEqual([]);
    expect(decideTaskControl(f.coordinator.buildSnapshot('task', result),
      { kind: 'accept_result', taskId: 'task', expectedResult: result }).authorized).toBe(false);
    expect(await f.seam.drainResultContinuations('task')).toBe(true);
    expect(f.stage).toHaveBeenCalledTimes(2);
    expect(f.db.prepare('SELECT decision_id FROM task_state_changes WHERE operation_key=?').get(acceptanceKey))
      .toEqual({ decision_id: 'first-accept' });
    expect(f.db.prepare('SELECT count(*) AS n FROM executor_attempt_receipts').get()).toEqual({ n: 1 });
    expect(f.snapshot).toHaveBeenCalledWith('task', expect.objectContaining(result));
  });

  it.each(['result', 'generation', 'cancelled', 'done', 'superseded'] as const)('does not expose stale accepted delivery controls (%s)', async mismatch => {
    const f = fixture();
    f.accept('first-accept');
    await f.seam.drainResultContinuations('task');
    if (mismatch === 'result') f.db.prepare("UPDATE effect_outbox SET payload_json=json_set(payload_json, '$.action.resultId', 'wrong')").run();
    if (mismatch === 'generation') f.db.prepare("UPDATE work_graph_revisions SET status='completed'").run();
    if (mismatch === 'cancelled') f.db.prepare("UPDATE tasks SET status='cancelled'").run();
    if (mismatch === 'done') f.subtasks.updateStatus('final', 'done');
    if (mismatch === 'superseded') {
      f.db.exec(`INSERT INTO executor_attempt_receipts (attempt_id, execution_id, task_id, subtask_id, work_unit_id, agent_class_name,
        started_at, completed_at, terminal_state, raw_response, parsing_json, verification_json,
        attempt_kind, generation_id, graph_revision, configuration_revision, authorized_binding_json, binding_fingerprint)
        VALUES ('newer', 'execution', 'task', 'final', 'unit', 'pi', 'start', 'zz-settled', 'executor_failed', '',
          '{}', '{}', 'primary', 'generation', 1, 'revision', '{}', 'fingerprint')`);
      expect(decideTaskControl(f.coordinator.buildSnapshot('task', result),
        { kind: 'accept_result', taskId: 'task', expectedResult: result }).authorized).toBe(false);
    }
    expect(readAcceptedResultContinuations(f.db, 'task')).toEqual([]);
    expect(f.view().pendingActions).toEqual([]);
  });
});
