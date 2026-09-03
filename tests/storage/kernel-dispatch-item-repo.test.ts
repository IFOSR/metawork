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
