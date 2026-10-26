import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskStateChangeRepo, TaskStateProjectionOutbox } from '../../src/storage/task-state-change-repo.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { WorkGraphRevisionRepo } from '../../src/storage/work-graph-revision-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';
import {
  createSqliteTaskLifecyclePort,
  createSqliteTaskStateTransaction,
} from '../../src/storage/task-lifecycle-port-adapter.js';
import {
  createTaskLifecyclePort,
  type ApplyTaskChangeCommand,
  type TaskLifecycleStorePort,
  type TaskLifecycleTransitionRecord,
} from '../../src/task/task-lifecycle-transition-port.js';
import {
  createTaskReason,
  EMPTY_TASK_STATE_DETAIL,
  type TaskStateDetail,
} from '../../src/task/task-state.js';

const databases: Database.Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function detailed(reason = createTaskReason('none', '')): TaskStateDetail {
  return { ...EMPTY_TASK_STATE_DETAIL, reason };
}

function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const taskRepo = new TaskRepo(db);
  const subtaskRepo = new SubtaskRepo(db);
  const workGraphRevisionRepo = new WorkGraphRevisionRepo(db);
  const stateChanges = new TaskStateChangeRepo(db);
  const projectionOutbox = new TaskStateProjectionOutbox(db);
  const taskEngine = new TaskEngine({
    taskRepo,
    snapshotDir: '/tmp/metawork-task-state-port',
    stateChanges,
  });
  const applied: TaskLifecycleTransitionRecord[] = [];
  const port = createSqliteTaskLifecyclePort(db, {
    taskRepo,
    subtaskRepo,
    stateChanges,
    projectionOutbox,
    workGraphRevisionRepo,
    onApplied: record => applied.push(record),
  });
  const task = taskEngine.create({
    id: 'task_state',
    title: 'State task',
    goal: 'Exercise the durable port',
    accountId: 'acct',
    conversationId: 'conv',
  });
  return {
    db, taskEngine, taskRepo, subtaskRepo, stateChanges, projectionOutbox, port, applied, task,
  };
}

function command(overrides: Partial<ApplyTaskChangeCommand> = {}): ApplyTaskChangeCommand {
  return {
    taskId: 'task_state',
    decisionId: 'decision_1',
    operationKey: 'dispatch:attempt_1',
    expectedVersion: 1,
    generationId: null,
    graphRevision: null,
    to: 'running',
    detail: detailed(),
    actor: 'kernel-execution-runtime',
    reason: 'authorized dispatch',
    ...overrides,
  };
}

describe('durable Task state entry', () => {
  it('writes state, detail, version and audit in one commit', () => {
    const fx = fixture();
    const result = fx.port.applyTaskChange(command());
    expect(result.applied).toBe(true);
    expect(result.task.status).toBe('running');
    expect(result.task.stateVersion).toBe(2);
    const history = fx.stateChanges.listForTask('task_state');
    expect(history.map(entry => entry.version)).toEqual([2, 1]);
    expect(history[0]!.operationKey).toBe('dispatch:attempt_1');
    expect(history[0]!.decisionId).toBe('decision_1');
    expect(history[0]!.fromStatus).toBe('queued');
    expect(history[0]!.toStatus).toBe('running');
    expect(fx.projectionOutbox.listPending()).toHaveLength(1);
    expect(fx.applied).toHaveLength(1);
  });

  it('treats the same operation key and payload as a replay without a new version', () => {
    const fx = fixture();
    fx.port.applyTaskChange(command());
    const replay = fx.port.applyTaskChange(command());
    expect(replay.applied).toBe(false);
    expect(fx.taskRepo.findById('task_state')!.stateVersion).toBe(2);
    expect(fx.stateChanges.listForTask('task_state')).toHaveLength(2);
  });

  it('rejects the same operation key with a different payload', () => {
    const fx = fixture();
    fx.port.applyTaskChange(command());
    expect(() => fx.port.applyTaskChange(command({
      to: 'needs_action',
      detail: detailed(createTaskReason('input_required', 'needs input')),
    }))).toThrow(/already applied a different payload/u);
    expect(fx.taskRepo.findById('task_state')!.status).toBe('running');
  });

  it('rolls back a stale expected version', () => {
    const fx = fixture();
    fx.port.applyTaskChange(command());
    expect(() => fx.port.applyTaskChange(command({
      operationKey: 'dispatch:attempt_2',
      decisionId: 'decision_2',
      expectedVersion: 1,
      to: 'succeeded',
    }))).toThrow(/state version moved/u);
    expect(fx.taskRepo.findById('task_state')!.status).toBe('running');
    expect(fx.stateChanges.findByOperationKey('task_state', 'dispatch:attempt_2')).toBeNull();
  });

  it('rejects a transition outside the one table', () => {
    const fx = fixture();
    // `queued` may not jump straight to a success conclusion.
    expect(() => fx.port.applyTaskChange(command({ to: 'succeeded' })))
      .toThrow(/rejected cross-layer lifecycle transition/u);
    fx.port.applyTaskChange(command());
    fx.port.applyTaskChange(command({
      operationKey: 'complete:d1',
      decisionId: 'd1',
      expectedVersion: 2,
      to: 'succeeded',
    }));
    // A terminal Task can never be reopened.
    expect(() => fx.port.applyTaskChange(command({
      operationKey: 'reopen',
      decisionId: 'decision_reopen',
      expectedVersion: 3,
      to: 'running',
    }))).toThrow(/rejected cross-layer lifecycle transition/u);
  });

  it('keeps the first terminal timestamp and never resets completed_at', () => {
    const fx = fixture();
    fx.port.applyTaskChange(command());
    fx.port.applyTaskChange(command({
      operationKey: 'complete:d1',
      decisionId: 'd1',
      expectedVersion: 2,
      to: 'succeeded',
    }));
    const completed = fx.taskRepo.findById('task_state')!.completedAt;
    expect(completed).not.toBeNull();
    // A same-state reason update keeps the original completion time.
    fx.port.applyTaskChange(command({
      operationKey: 'complete:detail_refresh',
      decisionId: 'decision_detail',
      expectedVersion: 3,
      to: 'succeeded',
      detail: detailed(createTaskReason('none', 'refreshed')),
    }));
    expect(fx.taskRepo.findById('task_state')!.completedAt).toBe(completed);
    expect(fx.taskRepo.findById('task_state')!.stateVersion).toBe(4);
  });

  it('commits narrowly scoped facts with the state change and rolls them back on failure', () => {
    const fx = fixture();
    let appliedFacts = 0;
    fx.port.applyTaskChange(command({
      facts: () => {
        appliedFacts += 1;
        return ['fact:one'];
      },
    }));
    expect(appliedFacts).toBe(1);
    expect(fx.stateChanges.findByOperationKey('task_state', 'dispatch:attempt_1')!.evidenceRefs)
      .toContain('fact:one');

    // The fact callback must not run when the CAS rejects the write.
    expect(() => fx.port.applyTaskChange(command({
      operationKey: 'dispatch:attempt_2',
      decisionId: 'decision_2',
      expectedVersion: 1,
      facts: () => {
        appliedFacts += 1;
        return [];
      },
    }))).toThrow(/state version moved/u);
    expect(appliedFacts).toBe(1);
  });

  it('records the creation baseline as version 1', () => {
    const fx = fixture();
    const history = fx.stateChanges.listForTask('task_state');
    expect(history).toHaveLength(1);
    expect(history[0]!.version).toBe(1);
    expect(history[0]!.operationKey).toBe('create:task_state');
    expect(fx.taskRepo.findById('task_state')!.stateVersion).toBe(1);
  });

  it('refuses a graph revision that no longer matches the active one', () => {
    const fx = fixture();
    fx.db.prepare(`INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
      VALUES ('cfg', 'hash', 'native', '2026-10-22T00:00:00.000Z')`).run();
    fx.db.prepare(`INSERT INTO work_graph_revisions
      (id, task_id, revision, generation_id, configuration_revision, proposal_source, automatic_replan,
        status, created_at, updated_at, completion_requirements_json)
      VALUES ('rev_1', 'task_state', 1, 'gen_1', 'cfg', 'initial', 0, 'active',
        '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z', '[]')`).run();
    expect(() => fx.port.applyTaskChange(command({
      generationId: 'gen_other',
      graphRevision: 1,
    }))).toThrow(/state version moved/u);
    expect(fx.taskRepo.findById('task_state')!.status).toBe('queued');
  });

  it('rejects a business conclusion after the cancellation fence', () => {
    const fx = fixture();
    fx.port.applyTaskChange(command({ to: 'cancelled', operationKey: 'cancel:d1', decisionId: 'd1' }));
    expect(() => fx.port.applyTaskChange(command({
      operationKey: 'complete:d2',
      decisionId: 'd2',
      expectedVersion: 2,
      to: 'succeeded',
    }))).toThrow(/rejected cross-layer lifecycle transition/u);
  });
});

describe('in-process port over a fake store', () => {
  it('reports durable history through listTransitions', () => {
    const records: Array<{ version: number; operationKey: string; decisionId: string; fromStatus: 'queued'; toStatus: 'running'; detail: TaskStateDetail; createdAt: string }> = [];
    let version = 1;
    let status: 'queued' | 'running' = 'queued';
    const store: TaskLifecycleStorePort = {
      findTask: () => ({
        id: 'task_state',
        title: 't',
        goal: 'g',
        status,
        stateVersion: version,
        stateDetail: EMPTY_TASK_STATE_DETAIL,
        completedAt: null,
        archivedAt: null,
        retryOfTaskId: null,
        summary: '',
        snapshots: [],
        resources: [],
        artifacts: [],
        dependencies: [],
        prioritySignals: { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
          lastSchedulingReason: '',
        lastInterruptionReason: '',
        interruptionCount: 0,
        createdAt: '2026-10-22T00:00:00.000Z',
        updatedAt: '2026-10-22T00:00:00.000Z',
      }),
      findChangeByOperationKey: (_taskId, operationKey) => {
        const found = records.find(record => record.operationKey === operationKey);
        return found ? { ...found } : null;
      },
      applyTaskState: input => {
        if (input.expectedVersion !== version) return null;
        version += 1;
        status = input.to as 'running';
        return store.findTask(input.taskId);
      },
      appendChange: record => records.unshift({
        version: record.version,
        operationKey: record.operationKey,
        decisionId: record.decisionId,
        fromStatus: record.fromStatus as 'queued',
        toStatus: record.toStatus as 'running',
        detail: record.detail,
        createdAt: record.createdAt,
      }),
      appendProjection: () => undefined,
      activeGraph: () => null,
      listChanges: () => records,
    };
    const port = createTaskLifecyclePort({
      store,
      transaction: { run: operation => operation() },
      now: () => '2026-10-22T00:00:00.000Z',
    });
    port.applyTaskChange(command());
    expect(port.listTransitions('task_state')).toHaveLength(1);
    expect(port.listTransitions('task_state')[0]!.to).toBe('running');
    expect(version).toBe(2);
    // The transaction port is the only writer: no direct repo access exists.
    expect(createSqliteTaskStateTransaction).toBeTypeOf('function');
  });
});
