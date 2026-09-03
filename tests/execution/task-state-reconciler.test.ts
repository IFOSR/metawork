import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { runTaskStateReconciler } from '../../src/execution/task-state-reconciler.js';

const NOW = '2026-09-03T16:30:00.000Z';

function seed(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`
    INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
    VALUES ('revision-1', 'sha256:test', 'native', ?)
  `).run(NOW);
  for (const [taskId, conversationId, status] of [
    ['task-dead', 'conv-a', 'cancelled'],
    ['task-live', 'conv-b', 'running'],
  ] as const) {
    db.prepare(`
      INSERT INTO tasks (
        id, title, goal, status, created_at, updated_at,
        account_id, conversation_id, workspace_id, owner_planner_session_id, admitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'account', ?, 'workspace', 'planner', ?)
    `).run(taskId, taskId, taskId, status, NOW, NOW, conversationId, NOW);
    db.prepare(`
      INSERT INTO work_graph_revisions (id, task_id, revision, generation_id, status, configuration_revision, created_at, updated_at)
      VALUES (?, ?, 1, ?, 'active', 'revision-1', ?, ?)
    `).run(`wgr-${taskId}`, taskId, `generation-${taskId}`, NOW, NOW);
    db.prepare(`
      INSERT INTO subtasks (id, task_id, generation_id, title, goal, status, dependencies_json,
        context_refs_json, required_capabilities_json, executor_bindings_json, delivery_kind, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'ready', '[]', '[]', '[]', '[]', 'report', ?, ?)
    `).run(`subtask-${taskId}`, taskId, `generation-${taskId}`, taskId, taskId, NOW, NOW);
    db.prepare(`
      INSERT INTO task_schedule_entries (task_id, conversation_id, state, enqueued_at, eligible_since, scheduling_reason, payload_json)
      VALUES (?, ?, 'running', ?, ?, 'work graph authorized', '{}')
    `).run(taskId, conversationId, NOW, NOW);
  }
  // Slot held by the cancelled task and a queued task waiting behind it.
  db.prepare(`
    INSERT INTO conversation_task_slots (conversation_id, active_task_id, state, fairness_sequence, last_served_at, updated_at)
    VALUES ('conv-a', 'task-dead', 'occupied', 1, ?, ?)
  `).run(NOW, NOW);
  // Orphaned dispatch item for the cancelled task.
  db.prepare(`
    INSERT INTO kernel_dispatch_items (
      attempt_id, decision_id, batch_order, task_id, generation_id, subtask_id,
      agent_class_name, attempt_kind, source_attempt_id, recovery_mode,
      attempt_payload_json, resource_grant_json, status, configuration_revision,
      authorized_binding_json, binding_fingerprint, created_at, updated_at
    ) VALUES (
      'attempt-orph', 'decision-orph', 0, 'task-dead', 'generation-task-dead', 'subtask-task-dead',
      'pi-research', 'primary', NULL, 'fresh', '{}', '[]', 'pending_launch', 'revision-1',
      '{}', 'sha256:x', ?, ?
    )
  `).run(NOW, NOW);
  return db;
}

describe('task-state reconciler', () => {
  it('closes orphaned dispatch items, stale slots, and zombie schedule entries', async () => {
    const db = seed();
    const report = await runTaskStateReconciler({ db, now: () => NOW });

    expect(report.ok).toBe(true);
    expect(report.closedDispatchItems).toBe(1);
    expect(report.releasedSlots).toBe(1);
    expect(report.closedScheduleEntries).toBe(1);

    const dispatch = db.prepare(
      "SELECT status FROM kernel_dispatch_items WHERE attempt_id = 'attempt-orph'",
    ).get() as { status: string };
    expect(dispatch.status).toBe('cancelled');

    const slot = db.prepare(
      "SELECT active_task_id, state FROM conversation_task_slots WHERE conversation_id = 'conv-a'",
    ).get() as { active_task_id: string | null; state: string };
    expect(slot.active_task_id).toBeNull();
    expect(slot.state).toBe('free');

    const liveSchedule = db.prepare(
      "SELECT state FROM task_schedule_entries WHERE task_id = 'task-live'",
    ).get() as { state: string };
    expect(liveSchedule.state).toBe('running');
  });

  it('is a no-op on consistent state', async () => {
    const db = seed();
    await runTaskStateReconciler({ db, now: () => NOW });
    const second = await runTaskStateReconciler({ db, now: () => NOW });
    expect(second.closedDispatchItems).toBe(0);
    expect(second.releasedSlots).toBe(0);
    expect(second.closedScheduleEntries).toBe(0);
    expect(second.lines).toContain('task state is consistent; nothing to reconcile');
  });
});
