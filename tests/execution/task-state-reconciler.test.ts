import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { prepareDatabaseSchema } from '../../src/storage/schema.js';
import { runTaskStateReconciler } from '../../src/execution/task-state-reconciler.js';

const NOW = '2026-09-03T16:30:00.000Z';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  prepareDatabaseSchema(db);
  db.prepare(`
    INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
    VALUES ('revision-1', 'sha256:test', 'native', ?)
  `).run(NOW);
  return db;
}

function seedTask(
  db: Database.Database,
  input: {
    id: string;
    conversationId: string;
    status: 'running' | 'cancelled';
    subtaskStatus?: 'ready' | 'blocked';
    subtaskId?: string;
  },
): { subtaskId: string } {
  const subtaskId = input.subtaskId ?? `subtask-${input.id}`;
  db.prepare(`
    INSERT INTO tasks (
      id, title, goal, status, created_at, updated_at,
      account_id, conversation_id, workspace_id, owner_planner_session_id, admitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'account', ?, 'workspace', 'planner', ?)
  `).run(input.id, input.id, input.id, input.status, NOW, NOW, input.conversationId, NOW);
  db.prepare(`
    INSERT INTO work_graph_revisions (
      id, task_id, revision, generation_id, status, configuration_revision,
      created_at, updated_at
    ) VALUES (?, ?, 1, ?, 'active', 'revision-1', ?, ?)
  `).run(`wgr-${input.id}`, input.id, `generation-${input.id}`, NOW, NOW);
  db.prepare(`
    INSERT INTO subtasks (
      id, task_id, title, goal, status, dependencies_json, context_refs_json,
      required_capabilities_json, executor_bindings_json, delivery_kind,
      graph_revision, generation_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', 'report', 1, ?, ?, ?)
  `).run(
    subtaskId, input.id, input.id, input.id, input.subtaskStatus ?? 'ready',
    `generation-${input.id}`, NOW, NOW,
  );
  db.prepare(`
    INSERT INTO task_schedule_entries (
      task_id, conversation_id, state, enqueued_at, eligible_since,
      scheduling_reason, payload_json
    ) VALUES (?, ?, 'running', ?, ?, 'work graph authorized', '{}')
  `).run(input.id, input.conversationId, NOW, NOW);
  return { subtaskId };
}

function insertDispatch(
  db: Database.Database,
  input: { attemptId: string; taskId: string; subtaskId: string; status: string },
): void {
  db.prepare(`
    INSERT INTO dispatch_items (
      attempt_id, decision_id, batch_order, task_id, generation_id, subtask_id,
      agent_class_name, attempt_kind, source_attempt_id, recovery_mode,
      attempt_payload_json, resource_grant_json, status, configuration_revision,
      authorized_binding_json, binding_fingerprint, created_at, updated_at
    ) VALUES (
      ?, ?, 0, ?, ?, ?,
      'pi-research', 'primary', NULL, 'fresh', '{}', '[]', ?, 'revision-1',
      '{}', 'sha256:x', ?, ?
    )
  `).run(
    input.attemptId, `decision-${input.attemptId}`, input.taskId,
    `generation-${input.taskId}`, input.subtaskId, input.status, NOW, NOW,
  );
}

describe('task-state reconciler', () => {
  it('closes orphaned dispatch items, stale slots, and zombie schedule entries', async () => {
    const db = createDb();
    const { subtaskId } = seedTask(db, {
      id: 'task-dead', conversationId: 'conv-a', status: 'cancelled',
    });
    seedTask(db, { id: 'task-live', conversationId: 'conv-b', status: 'running' });
    insertDispatch(db, {
      attemptId: 'attempt-orph', taskId: 'task-dead', subtaskId, status: 'pending_launch',
    });
    db.prepare(`
      INSERT INTO conversation_task_slots (
        conversation_id, active_task_id, state, fairness_sequence, last_served_at, updated_at
      ) VALUES ('conv-a', 'task-dead', 'occupied', 1, ?, ?)
    `).run(NOW, NOW);

    const report = await runTaskStateReconciler({ db, now: () => NOW });

    expect(report.ok).toBe(true);
    expect(report.closedDispatchItems).toBe(1);
    expect(report.releasedSlots).toBe(1);
    expect(report.closedScheduleEntries).toBe(1);

    const dispatch = db.prepare(
      "SELECT status FROM dispatch_items WHERE attempt_id = 'attempt-orph'",
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

    db.close();
  });

  it('concludes a half-applied block as needs_action so the UI offers a resume', async () => {
    const db = createDb();
    seedTask(db, {
      id: 'task-stalled', conversationId: 'conv-stalled', status: 'running',
      subtaskStatus: 'blocked',
    });
    db.prepare(`
      INSERT INTO conversation_task_slots (
        conversation_id, active_task_id, state, fairness_sequence, last_served_at, updated_at
      ) VALUES ('conv-stalled', 'task-stalled', 'occupied', 1, ?, ?)
    `).run(NOW, NOW);

    const report = await runTaskStateReconciler({ db, now: () => NOW });

    const task = db.prepare(
      "SELECT status, dependencies_json FROM tasks WHERE id = 'task-stalled'",
    ).get() as { status: string; dependencies_json: string };
    expect(task.status).toBe('needs_action');
    expect(JSON.parse(task.dependencies_json)).toEqual([
      expect.objectContaining({ type: 'manual', status: 'waiting', description: expect.stringContaining('需要继续') }),
    ]);
    expect(report.changes.join('\n')).toContain('parked stalled Task task-stalled');

    // The conclusion goes through the durable state ledger and its projection
    // outbox, so every client sees the same status instead of a local guess.
    const change = db.prepare(
      "SELECT to_status FROM task_state_changes WHERE task_id = 'task-stalled'",
    ).get() as { to_status: string } | undefined;
    expect(change?.to_status).toBe('needs_action');
    const projected = db.prepare(
      "SELECT status FROM task_state_projection_outbox WHERE task_id = 'task-stalled'",
    ).get() as { status: string } | undefined;
    expect(projected?.status).toBe('needs_action');

    // It keeps the Conversation slot: the resume reuses the same Task.
    const slot = db.prepare(
      "SELECT active_task_id FROM conversation_task_slots WHERE conversation_id = 'conv-stalled'",
    ).get() as { active_task_id: string | null };
    expect(slot.active_task_id).toBe('task-stalled');

    const second = await runTaskStateReconciler({ db, now: () => NOW });
    expect(second.changes).toEqual([]);
    expect(second.lines).toContain('task state is consistent; nothing to reconcile');

    db.close();
  });

  it('cancels an idle quiescence replan and parks the Task that queued it', async () => {
    const db = createDb();
    seedTask(db, {
      id: 'task-idle-replan', conversationId: 'conv-idle-replan', status: 'running',
      subtaskStatus: 'blocked',
    });
    db.prepare(`
      INSERT INTO generation_replan_requests (
        id, task_id, generation_id, source_revision, status, trigger_decision_id,
        configuration_revision, created_at, updated_at
      ) VALUES (
        'replan-idle', 'task-idle-replan', 'generation-task-idle-replan', 1,
        'pending_quiescence', 'decision-idle', 'revision-1', ?, ?
      )
    `).run(NOW, NOW);

    const report = await runTaskStateReconciler({ db, now: () => NOW });

    const replan = db.prepare(
      "SELECT status FROM generation_replan_requests WHERE id = 'replan-idle'",
    ).get() as { status: string };
    expect(replan.status).toBe('cancelled');
    const task = db.prepare(
      "SELECT status FROM tasks WHERE id = 'task-idle-replan'",
    ).get() as { status: string };
    expect(task.status).toBe('needs_action');
    expect(report.changes.join('\n')).toContain('idle replan request');

    db.close();
  });

  it('leaves a replan that already owns a quiescence token on the Planner path', async () => {
    const db = createDb();
    seedTask(db, {
      id: 'task-scheduled-replan', conversationId: 'conv-scheduled-replan', status: 'running',
      subtaskStatus: 'blocked',
    });
    db.prepare(`
      INSERT INTO generation_replan_requests (
        id, task_id, generation_id, source_revision, status, trigger_decision_id,
        quiescence_token, configuration_revision, created_at, updated_at
      ) VALUES (
        'replan-scheduled', 'task-scheduled-replan', 'generation-task-scheduled-replan', 1,
        'pending_quiescence', 'decision-scheduled', 'quiescence_decision',
        'revision-1', ?, ?
      )
    `).run(NOW, NOW);

    const report = await runTaskStateReconciler({ db, now: () => NOW });

    const replan = db.prepare(
      "SELECT status FROM generation_replan_requests WHERE id = 'replan-scheduled'",
    ).get() as { status: string };
    expect(replan.status).toBe('pending_quiescence');
    const task = db.prepare(
      "SELECT status FROM tasks WHERE id = 'task-scheduled-replan'",
    ).get() as { status: string };
    expect(task.status).toBe('running');
    expect(report.changes).toEqual([]);

    db.close();
  });

  it('leaves a Task alone while live or scheduled work can still advance it', async () => {
    const db = createDb();
    const withDispatch = seedTask(db, {
      id: 'task-uncertain', conversationId: 'conv-uncertain', status: 'running',
      subtaskStatus: 'blocked',
    });
    insertDispatch(db, {
      attemptId: 'attempt-uncertain', taskId: 'task-uncertain',
      subtaskId: withDispatch.subtaskId, status: 'uncertain',
    });
    const withWake = seedTask(db, {
      id: 'task-wake', conversationId: 'conv-wake', status: 'running',
      subtaskStatus: 'blocked',
    });
    db.prepare(`
      INSERT INTO retry_wakes (
        wake_id, task_id, subtask_id, generation_id, source_decision_id,
        source_attempt_id, configuration_revision, binding_fingerprint,
        authorized_binding_json, resume_at, status, created_at, updated_at
      ) VALUES (?, 'task-wake', ?, 'generation-task-wake', 'decision-wake',
        'attempt-wake', 'revision-1', 'sha256:x', '{}', ?, 'armed', ?, ?)
    `).run('wake-1', withWake.subtaskId, NOW, NOW, NOW);

    const report = await runTaskStateReconciler({ db, now: () => NOW });

    for (const taskId of ['task-uncertain', 'task-wake']) {
      const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string };
      expect(task.status).toBe('running');
    }
    expect(report.changes).toEqual([]);

    db.close();
  });
});
