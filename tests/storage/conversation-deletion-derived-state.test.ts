import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initializeDatabaseSchema } from '../../src/storage/schema.js';
import { SqliteConversationDeletionStore } from '../../src/storage/conversation-deletion-repo.js';
import { TaskStateProjectionOutbox } from '../../src/storage/task-state-change-repo.js';

/**
 * Deleting a Conversation must erase its derived projection work.
 *
 * The activity projector drains `task_state_projection_outbox` and
 * `conversation_activity_dirty` every 100ms. Leaving those rows behind made it
 * re-queue an erased Conversation forever, failing with `conversation_deleted`
 * on every pass — and the same leftovers were what a Workspace recovery pass
 * later tripped over.
 */
function setup(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initializeDatabaseSchema(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO tasks (id, title, goal, status, created_at, updated_at,
    account_id, conversation_id, workspace_id, owner_planner_session_id, admitted_at)
    VALUES ('task_deleted', 'Deleted work', 'goal', 'succeeded', ?, ?, 'local-default', 'conv_deleted', 'workspace', 'planner', ?)`)
    .run(now, now, now);
  db.prepare(`INSERT INTO tasks (id, title, goal, status, created_at, updated_at,
    account_id, conversation_id, workspace_id, owner_planner_session_id, admitted_at)
    VALUES ('task_live', 'Live work', 'goal', 'running', ?, ?, 'local-default', 'conv_live', 'workspace', 'planner', ?)`)
    .run(now, now, now);

  for (const [taskId, conversationId, status] of [
    ['task_deleted', 'conv_deleted', 'succeeded'],
    ['task_live', 'conv_live', 'running'],
  ] as const) {
    new TaskStateProjectionOutbox(db).append({
      taskId, accountId: 'local-default', conversationId,
      stateVersion: 2, status, detail: {} as never, createdAt: now,
    });
  }
  for (const taskId of ['task_deleted', 'task_live']) {
    db.prepare('INSERT OR REPLACE INTO conversation_activity_dirty (task_id, version) VALUES (?, 1)').run(taskId);
    db.prepare('INSERT INTO conversation_activity_views (task_id, body_json) VALUES (?, ?)')
      .run(taskId, JSON.stringify({ taskId, state: 'executing', updatedAt: now }));
  }
  db.prepare(`INSERT INTO conversation_task_slots (conversation_id, active_task_id, state, updated_at, slot_version)
    VALUES ('conv_deleted', 'task_deleted', 'occupied', ?, 1)`).run(now);
  return db;
}

describe('conversation deletion erases derived projection work', () => {
  it('stops the activity projector from retrying an erased Conversation', () => {
    const db = setup();
    new SqliteConversationDeletionStore(db).begin('local-default', 'conv_deleted');
    new SqliteConversationDeletionStore(db).cleanLocal('local-default', 'conv_deleted');

    expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_activity_dirty WHERE task_id = ?')
      .get('task_deleted')).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_activity_views WHERE task_id = ?')
      .get('task_deleted')).toEqual({ n: 0 });
    // The audit Task row survives; only its projection work is gone.
    expect(db.prepare('SELECT title FROM tasks WHERE id = ?').get('task_deleted')).toEqual({ title: '[deleted]' });
    // Unrelated Conversations keep their pending projection work.
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_activity_dirty WHERE task_id = ?')
      .get('task_live')).toEqual({ n: 1 });
  });

  it('drains the erased Task outbox so it cannot be re-queued', () => {
    const db = setup();
    new SqliteConversationDeletionStore(db).begin('local-default', 'conv_deleted');
    new SqliteConversationDeletionStore(db).cleanLocal('local-default', 'conv_deleted');

    const pending = new TaskStateProjectionOutbox(db).listPending();
    expect(pending.map(item => item.taskId)).toEqual(['task_live']);
  });

  it('releases the Conversation slot and terminalizes its schedule entry', () => {
    const db = setup();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO task_schedule_entries (task_id, conversation_id, state, enqueued_at, eligible_since)
      VALUES ('task_deleted', 'conv_deleted', 'queued', ?, ?)`).run(now, now);
    new SqliteConversationDeletionStore(db).begin('local-default', 'conv_deleted');
    new SqliteConversationDeletionStore(db).cleanLocal('local-default', 'conv_deleted');

    expect(db.prepare("SELECT active_task_id, state FROM conversation_task_slots WHERE conversation_id = 'conv_deleted'")
      .get()).toEqual({ active_task_id: null, state: 'free' });
    expect(db.prepare("SELECT state FROM task_schedule_entries WHERE task_id = 'task_deleted'")
      .get()).toEqual({ state: 'terminal' });
  });
});
