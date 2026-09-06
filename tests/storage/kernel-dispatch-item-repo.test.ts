import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { KernelDispatchItemRepo } from '../../src/storage/kernel-dispatch-item-repo.js';
import type { AuthorizedExecutorBinding } from '../../src/core/authorized-executor-binding.js';

const binding: AuthorizedExecutorBinding = {
  agentClassRef: 'pi-research',
  harnessRef: 'pi-cli',
  providerRef: 'deepseek',
  modelRef: 'deepseek-chat',
  permissionProfileRef: 'public-web-research',
  configurationRevision: 'revision-1',
};

function setup(): { db: Database.Database; repo: KernelDispatchItemRepo } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const now = '2026-09-03T15:30:28.000Z';
  db.prepare(`
    INSERT INTO tasks (
      id, title, goal, status, created_at, updated_at,
      account_id, conversation_id, workspace_id, owner_planner_session_id, admitted_at
    ) VALUES ('task-1', 'T', 'T', 'running', ?, ?, 'account', 'conv-1', 'workspace', 'planner', ?)
  `).run(now, now, now);
  db.prepare(`
    INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
    VALUES ('revision-1', 'sha256:test', 'native', ?)
  `).run(now);
  db.prepare(`
    INSERT INTO work_graph_revisions (id, task_id, revision, generation_id, status, configuration_revision, created_at, updated_at)
    VALUES ('wgr-1', 'task-1', 1, 'generation-1', 'active', 'revision-1', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO subtasks (id, task_id, generation_id, title, goal, status, dependencies_json,
      context_refs_json, required_capabilities_json, executor_bindings_json, delivery_kind, created_at, updated_at)
    VALUES ('subtask-1', 'task-1', 'generation-1', 'S', 'S', 'ready', '[]', '[]', '[]', '[]', 'report', ?, ?)
  `).run(now, now);
  return { db, repo: new KernelDispatchItemRepo(db) };
}

function dispatchDecision(taskId = 'task-1') {
  return {
    id: `decision-${taskId}`,
    eventId: `event-${taskId}`,
    configurationRevision: binding.configurationRevision,
    reason: 'test dispatch',
    action: {
      type: 'dispatch_batch' as const,
      taskId,
      items: [{
        subtaskId: 'subtask-1',
        authorizedBinding: binding,
        bindingFingerprint: 'sha256:abc',
        attemptId: `attempt-${taskId}`,
        attemptKind: 'primary' as const,
        sourceAttemptId: null,
        recoveryMode: 'fresh' as const,
        defaultResourceGrant: [],
        order: 0,
        attemptPayload: { workspacePath: '/tmp/workspace' },
      }],
    },
  };
}

describe('KernelDispatchItemRepo cancellation fences', () => {
  it('persists a late-arriving dispatch as cancelled when its task was already cancelled', () => {
    const { db, repo } = setup();
    const now = '2026-09-03T15:30:28.500Z';
    db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = 'task-1'").run();

    const decision = dispatchDecision() as never;
    const persisted = repo.insertBatch(
      decision,
      {
        generationId: 'generation-1',
        configurationRevision: binding.configurationRevision,
        attempts: {
          'attempt-task-1': { authorizedBinding: binding, bindingFingerprint: 'sha256:abc' },
        },
      },
      now,
    );

    expect(persisted[0]!.status).toBe('cancelled');
    expect(persisted[0]!.terminalAt).toBe(now);
    expect(repo.listPending('task-1')).toHaveLength(0);
  });

  it('terminalizes a pending item at claim time when the cancellation fence wins', () => {
    const { db, repo } = setup();
    const now = '2026-09-03T15:30:28.500Z';
    repo.insertBatch(
      dispatchDecision() as never,
      {
        generationId: 'generation-1',
        configurationRevision: binding.configurationRevision,
        attempts: {
          'attempt-task-1': { authorizedBinding: binding, bindingFingerprint: 'sha256:abc' },
        },
      },
      now,
    );
    // The task is cancelled after the dispatch row landed (the exact
    // 2026-09-03 race shape).
    db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = 'task-1'").run();

    expect(repo.claimPending('attempt-task-1', now)).toBeNull();
    const row = db.prepare(
      "SELECT status FROM kernel_dispatch_items WHERE attempt_id = 'attempt-task-1'",
    ).get() as { status: string };
    expect(row.status).toBe('cancelled');
    expect(repo.listPending('task-1')).toHaveLength(0);
  });
});

describe('KernelDispatchItemRepo cancellation conflict safety (2026-09-06 plan §2.1)', () => {
  const insertOptions = (attemptId: string) => ({
    generationId: 'generation-1',
    configurationRevision: binding.configurationRevision,
    attempts: {
      [attemptId]: { authorizedBinding: binding, bindingFingerprint: 'sha256:abc' },
    },
  });

  function insertDispatch(
    repo: KernelDispatchItemRepo,
    attemptId: string,
    decisionId: string,
    now: string,
  ): void {
    const decision = dispatchDecision();
    decision.id = decisionId;
    const item = decision.action.items[0]!;
    item.attemptId = attemptId;
    item.bindingFingerprint = 'sha256:abc';
    repo.insertBatch(decision as never, insertOptions(attemptId), now);
  }

  function rowStatus(repo: KernelDispatchItemRepo, attemptId: string): string {
    const row = repo.find(attemptId);
    if (!row) throw new Error(`missing dispatch row: ${attemptId}`);
    return row.status;
  }

  it('never violates the one-active-subtask index when cancelling a superseded uncertain attempt', () => {
    // Exact 2026-09-06 production shape: attempt-1 went uncertain after a
    // backend error, the Kernel retried the Subtask with attempt-2, then the
    // cancellation arrived. Moving attempt-1 back into the partial unique
    // index used to fail the whole cancellation transaction with
    // `UNIQUE constraint failed: kernel_dispatch_items.task_id,
    // generation_id, subtask_id` and left the Task blocked + slot occupied.
    const { repo } = setup();
    const now = '2026-09-06T06:57:15.000Z';
    insertDispatch(repo, 'attempt-1', 'decision-1', now);
    repo.claimPending('attempt-1', now);
    repo.markRunning('attempt-1', 'work-unit-1', now);
    repo.markUncertain('attempt-1', 'execution backend was lost', now);
    insertDispatch(repo, 'attempt-2', 'decision-2', now);
    repo.claimPending('attempt-2', now);
    repo.markRunning('attempt-2', 'work-unit-2', now);

    expect(() => repo.requestCancellation({
      taskId: 'task-1',
      generationId: 'generation-1',
      subtaskIds: null,
      decisionId: 'decision-cancel',
      now,
    })).not.toThrow();
    expect(rowStatus(repo, 'attempt-1')).toBe('cancelled');
    expect(rowStatus(repo, 'attempt-2')).toBe('cancelling');
    expect(repo.listCancelling('task-1').map(item => item.attemptId)).toEqual(['attempt-2']);
  });

  it('terminalizes all but one sibling when several uncertain attempts share a Subtask', () => {
    const { repo } = setup();
    const now = '2026-09-06T06:58:00.000Z';
    for (const [index, attemptId] of ['attempt-a', 'attempt-b', 'attempt-c'].entries()) {
      insertDispatch(repo, attemptId, `decision-${index}`, now);
      repo.claimPending(attemptId, now);
      repo.markRunning(attemptId, null, now);
      repo.markUncertain(attemptId, 'uncertain sibling', now);
    }

    repo.requestCancellation({
      taskId: 'task-1',
      generationId: 'generation-1',
      subtaskIds: null,
      decisionId: 'decision-cancel',
      now,
    });

    const statuses = ['attempt-a', 'attempt-b', 'attempt-c'].map(
      attemptId => rowStatus(repo, attemptId),
    );
    expect(statuses.filter(status => status === 'cancelling')).toHaveLength(1);
    expect(statuses.filter(status => status === 'cancelled')).toHaveLength(2);
    expect(repo.listCancelling('task-1')).toHaveLength(1);
  });

  it('reports an actionable typed error when a live sibling blocks a new dispatch', () => {
    const { repo } = setup();
    const now = '2026-09-06T07:00:00.000Z';
    insertDispatch(repo, 'attempt-1', 'decision-1', now);
    repo.claimPending('attempt-1', now);
    repo.markRunning('attempt-1', null, now);

    expect(() => insertDispatch(repo, 'attempt-2', 'decision-2', now))
      .toThrowError(/live dispatch attempt already owns subtask-1: attempt-1/);
  });
});
