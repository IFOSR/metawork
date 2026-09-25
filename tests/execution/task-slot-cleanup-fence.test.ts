import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { runTaskStateReconciler } from '../../src/execution/task-state-reconciler.js';
import { ConversationTaskSchedulerRepo } from '../../src/storage/conversation-task-scheduler-repo.js';

const NOW = '2026-09-21T16:30:00.000Z';

function seed(options: {
  readonly dispatchStatus?: 'pending_launch' | 'launching' | 'cancelling' | 'uncertain';
  readonly withWorkUnit?: boolean;
  readonly withLiveLease?: boolean;
} = {}): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`
    INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
    VALUES ('revision-1', 'sha256:test', 'native', ?)
  `).run(NOW);
  db.prepare(`
    INSERT INTO tasks (
      id, title, goal, status, created_at, updated_at,
      account_id, conversation_id, workspace_id, owner_planner_session_id, admitted_at
    ) VALUES ('task-a', 'task-a', 'task-a', 'cancelled', ?, ?, 'account', 'conv-a', 'workspace', 'planner', ?)
  `).run(NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO work_graph_revisions (id, task_id, revision, generation_id, status, configuration_revision, created_at, updated_at)
    VALUES ('wgr-a', 'task-a', 1, 'generation-a', 'active', 'revision-1', ?, ?)
  `).run(NOW, NOW);
  db.prepare(`
    INSERT INTO subtasks (id, task_id, generation_id, title, goal, status, dependencies_json,
      context_refs_json, required_capabilities_json, executor_bindings_json, delivery_kind, created_at, updated_at)
    VALUES ('subtask-a', 'task-a', 'generation-a', 'subtask-a', 'subtask-a', 'ready', '[]', '[]', '[]', '[]', 'report', ?, ?)
  `).run(NOW, NOW);
  db.prepare(`
    INSERT INTO conversation_task_slots (conversation_id, active_task_id, state, fairness_sequence, last_served_at, updated_at)
    VALUES ('conv-a', 'task-a', 'occupied', 1, ?, ?)
  `).run(NOW, NOW);
  db.prepare(`
    INSERT INTO task_schedule_entries (task_id, conversation_id, state, enqueued_at, eligible_since, scheduling_reason, payload_json)
    VALUES ('task-a', 'conv-a', 'running', ?, ?, 'work graph authorized', '{}')
  `).run(NOW, NOW);
  if (options.dispatchStatus) {
    db.prepare(`
      INSERT INTO kernel_dispatch_items (
        attempt_id, decision_id, batch_order, task_id, generation_id, subtask_id,
        agent_class_name, attempt_kind, source_attempt_id, recovery_mode,
        attempt_payload_json, resource_grant_json, status, configuration_revision,
        authorized_binding_json, binding_fingerprint, created_at, updated_at
      ) VALUES (
        'attempt-a', 'decision-a', 0, 'task-a', 'generation-a', 'subtask-a',
        'pi-research', 'primary', NULL, 'fresh', '{}', '[]', ?, 'revision-1',
        '{}', 'sha256:x', ?, ?
      )
    `).run(options.dispatchStatus, NOW, NOW);
  }
  if (options.withWorkUnit) {
    db.prepare(`
      INSERT INTO work_units (
        id, agent_class_name, agent_class_kind, state, claimed_task_id, claimed_subtask_id,
        heartbeat_at, lease_expires_at, created_at, updated_at, claimed_attempt_id
      ) VALUES ('wu-a', 'pi-research', 'executor', 'running', 'task-a', 'subtask-a', ?, ?, ?, ?, 'attempt-a')
    `).run(NOW, NOW, NOW, NOW);
  }
  if (options.withLiveLease) {
    db.prepare(`
      INSERT INTO work_units (
        id, agent_class_name, agent_class_kind, state, claimed_task_id, claimed_subtask_id,
        heartbeat_at, lease_expires_at, created_at, updated_at, claimed_attempt_id
      ) VALUES ('wu-lease', 'pi-research', 'executor', 'idle', NULL, NULL, ?, ?, ?, ?, NULL)
    `).run(NOW, NOW, NOW, NOW);
    db.prepare(`
      INSERT INTO resource_leases (
        id, partition_key, partition_json, access_mode, task_id, generation_id, subtask_id,
        attempt_id, work_unit_id, lease_token, heartbeat_at, expires_at, released_at, created_at
      ) VALUES (
        'lease-a', 'repo:/w', '{}', 'write', 'task-a', 'generation-a', 'subtask-a',
        'attempt-lease', 'wu-lease', 'token', ?, ?, NULL, ?
      )
    `).run(NOW, NOW, NOW);
  }
  return db;
}

describe('task slot cleanup fence', () => {
  it('releases the slot only after safe launch residue is closed', async () => {
    const db = seed({ dispatchStatus: 'pending_launch' });
    const report = await runTaskStateReconciler({ db, now: () => NOW });
    expect(report.closedDispatchItems).toBe(1);
    expect(report.releasedSlots).toBe(1);
    expect(report.retainedSlots).toBe(0);
    const slot = db.prepare(
      "SELECT active_task_id, state FROM conversation_task_slots WHERE conversation_id = 'conv-a'",
    ).get() as { active_task_id: string | null; state: string };
    expect(slot).toEqual({ active_task_id: null, state: 'free' });
    db.close();
  });

  it('retains the slot while a cancellation fence is still converging', async () => {
    const db = seed({ dispatchStatus: 'cancelling' });
    const report = await runTaskStateReconciler({ db, now: () => NOW });
    expect(report.closedDispatchItems).toBe(0);
    expect(report.releasedSlots).toBe(0);
    expect(report.retainedSlots).toBe(1);
    expect(report.retainedSlotResidue[0]?.residue).toContain('dispatch');
    const dispatch = db.prepare(
      "SELECT status FROM kernel_dispatch_items WHERE attempt_id = 'attempt-a'",
    ).get() as { status: string };
    // Never rewritten to `cancelled` without confirming the backend exited.
    expect(dispatch.status).toBe('cancelling');
    const slot = db.prepare(
      "SELECT active_task_id FROM conversation_task_slots WHERE conversation_id = 'conv-a'",
    ).get() as { active_task_id: string | null };
    expect(slot.active_task_id).toBe('task-a');
    db.close();
  });

  it('retains the slot while an uncertain side effect is unresolved', async () => {
    const db = seed({ dispatchStatus: 'uncertain' });
    const report = await runTaskStateReconciler({ db, now: () => NOW });
    expect(report.retainedSlots).toBe(1);
    expect(report.releasedSlots).toBe(0);
    const dispatch = db.prepare(
      "SELECT status FROM kernel_dispatch_items WHERE attempt_id = 'attempt-a'",
    ).get() as { status: string };
    expect(dispatch.status).toBe('uncertain');
    db.close();
  });

  it('retains the slot while a WorkUnit claim or resource lease is live', async () => {
    const withWorkUnit = seed({ withWorkUnit: true });
    const workUnitReport = await runTaskStateReconciler({ db: withWorkUnit, now: () => NOW });
    expect(workUnitReport.retainedSlotResidue[0]?.residue).toContain('work_unit');
    withWorkUnit.close();

    const withLease = seed({ withLiveLease: true });
    const leaseReport = await runTaskStateReconciler({ db: withLease, now: () => NOW });
    expect(leaseReport.retainedSlotResidue[0]?.residue).toContain('resource_lease');
    withLease.close();
  });

  it('releases stale capacity without reserving a successor it cannot launch', async () => {
    const db = seed({ dispatchStatus: 'pending_launch' });
    db.prepare(`
      INSERT INTO tasks (
        id, title, goal, status, created_at, updated_at,
        account_id, conversation_id, workspace_id, owner_planner_session_id, admitted_at
      ) VALUES ('task-b', 'task-b', 'task-b', 'created', ?, ?, 'account', 'conv-a', 'workspace', 'planner', ?)
    `).run(NOW, NOW, NOW);
    db.prepare(`
      INSERT INTO task_schedule_entries (task_id, conversation_id, state, enqueued_at, eligible_since, scheduling_reason, payload_json)
      VALUES ('task-b', 'conv-a', 'queued', ?, ?, 'slot occupied', '{}')
    `).run(NOW, NOW);
    const first = await runTaskStateReconciler({ db, now: () => NOW });
    expect(first.releasedSlots).toBe(1);
    const released = db.prepare(
      "SELECT active_task_id, state FROM conversation_task_slots WHERE conversation_id = 'conv-a'",
    ).get() as { active_task_id: string | null; state: string };
    expect(released).toEqual({ active_task_id: null, state: 'free' });
    expect(db.prepare("SELECT state FROM task_schedule_entries WHERE task_id = 'task-b'").get())
      .toEqual({ state: 'queued' });
    // A second pass must be idempotent and must not reserve work again.
    const second = await runTaskStateReconciler({ db, now: () => NOW });
    expect(second.releasedSlots).toBe(0);
    expect(db.prepare(
      "SELECT active_task_id FROM conversation_task_slots WHERE conversation_id = 'conv-a'",
    ).get()).toEqual({ active_task_id: null });
    db.close();
  });

  it('wakes a queued Task in another Conversation after capacity is released', () => {
    const db = seed({ dispatchStatus: 'pending_launch' });
    db.prepare(`
      INSERT INTO tasks (
        id, title, goal, status, created_at, updated_at,
        account_id, conversation_id, workspace_id, owner_planner_session_id, admitted_at
      ) VALUES ('task-b', 'task-b', 'task-b', 'created', ?, ?, 'account', 'conv-b', 'workspace', 'planner', ?)
    `).run(NOW, NOW, NOW);
    db.prepare(`
      INSERT INTO conversation_task_slots (
        conversation_id, active_task_id, state, fairness_sequence, last_served_at, updated_at
      ) VALUES ('conv-b', NULL, 'free', 0, NULL, ?)
    `).run(NOW);
    db.prepare(`
      INSERT INTO task_schedule_entries (
        task_id, conversation_id, state, enqueued_at, eligible_since, scheduling_reason, payload_json
      ) VALUES ('task-b', 'conv-b', 'queued', ?, ?, 'account capacity', '{}')
    `).run(NOW, NOW);

    const scheduler = new ConversationTaskSchedulerRepo(db);
    const released = scheduler.releaseTaskSlotAndPromote('task-a', NOW);
    expect(released?.promotedTaskId).toBeNull();
    const promotions = scheduler.promoteAvailable(2, NOW);
    expect(promotions).toEqual([{
      taskId: 'task-b',
      conversationId: 'conv-b',
      reservationId: 'reservation_conv-b_task-b',
    }]);
    expect(db.prepare(`
      SELECT active_task_id, state
      FROM conversation_task_slots WHERE conversation_id = 'conv-b'
    `).get()).toEqual({ active_task_id: 'task-b', state: 'occupied' });
    db.close();
  });
});
