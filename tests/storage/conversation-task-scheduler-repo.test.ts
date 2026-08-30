import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { ConversationTaskSchedulerRepo } from '../../src/storage/conversation-task-scheduler-repo.js';

function db(): Database.Database {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  runMigrations(database);
  database.prepare(`
    INSERT INTO tasks (
      id, title, goal, status, created_at, updated_at,
      account_id, conversation_id, workspace_id, owner_planner_session_id, admitted_at
    ) VALUES ('task-a', 'A', 'A', 'ready', ?, ?, 'account', 'conversation-a', 'workspace', 'planner-a', ?)
  `).run('2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z');
  database.prepare(`
    INSERT INTO tasks (
      id, title, goal, status, created_at, updated_at,
      account_id, conversation_id, workspace_id, owner_planner_session_id, admitted_at
    ) VALUES ('task-b', 'B', 'B', 'ready', ?, ?, 'account', 'conversation-b', 'workspace', 'planner-b', ?)
  `).run('2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z');
  return database;
}

describe('ConversationTaskSchedulerRepo', () => {
  it('claims one free Conversation slot and rejects a second claim', () => {
    const repository = new ConversationTaskSchedulerRepo(db());

    expect(repository.claimSlot('conversation-a', 'task-a', 'reservation-a', '2026-08-29T00:00:00.000Z')).toBe(true);
    expect(repository.claimSlot('conversation-a', 'task-b', 'reservation-b', '2026-08-29T00:01:00.000Z')).toBe(false);
    expect(repository.getSlot('conversation-a')).toMatchObject({
      activeTaskId: 'task-a',
      state: 'occupied',
      reservationId: 'reservation-a',
    });
  });

  it('persists queued entries by Conversation and releases the slot independently', () => {
    const database = db();
    const repository = new ConversationTaskSchedulerRepo(database);

    repository.enqueueTask('task-a', 'conversation-a', '2026-08-29T00:00:00.000Z');
    repository.enqueueTask('task-b', 'conversation-b', '2026-08-29T00:01:00.000Z');
    expect(repository.claimSlot('conversation-a', 'task-a', 'reservation-a', '2026-08-29T00:00:30.000Z')).toBe(true);
    expect(repository.listQueuedTasks('conversation-a')).toEqual([]);
    expect(database.prepare(
      'SELECT state FROM task_schedule_entries WHERE task_id = ?',
    ).get('task-a')).toEqual({ state: 'running' });
    expect(repository.listQueuedTasks('conversation-b')).toEqual(['task-b']);
    expect(repository.releaseSlot('conversation-a', 'task-a', '2026-08-29T00:02:00.000Z')).toBe(true);
    expect(repository.getSlot('conversation-a')?.state).toBe('free');
    expect(repository.getSlot('conversation-b')?.state).toBe('free');
  });

  it('stores a bounded queued payload and promotes only the oldest entry after a clean release', () => {
    const database = db();
    const repository = new ConversationTaskSchedulerRepo(database);
    repository.enqueueTask('task-a', 'conversation-a', '2026-08-29T00:00:00.000Z', {
      requestText: 'run A',
      generationId: 'generation-a',
      graphRevision: 1,
      workGraph: { subtasks: [] },
      authorizedBindingsBySubtask: {},
      workspaceId: 'workspace',
      plannerSessionId: 'planner-a',
    });
    repository.enqueueTask('task-b', 'conversation-a', '2026-08-29T00:01:00.000Z', {
      requestText: 'run B',
      generationId: 'generation-b',
      graphRevision: 1,
      workGraph: { subtasks: [] },
      authorizedBindingsBySubtask: {},
      workspaceId: 'workspace',
      plannerSessionId: 'planner-a',
    });
    expect(repository.getQueuedPayload('task-a')).toMatchObject({ requestText: 'run A' });
    expect(repository.claimSlot('conversation-a', 'task-a', 'reservation-a', '2026-08-29T00:02:00.000Z')).toBe(true);
    expect(repository.releaseSlotAndPromote('conversation-a', 'task-a', '2026-08-29T00:03:00.000Z')).toEqual({
      taskId: 'task-b',
      reservationId: expect.any(String),
    });
    expect(repository.getSlot('conversation-a')).toMatchObject({
      activeTaskId: 'task-b',
      state: 'occupied',
    });
    expect(repository.listQueuedTasks('conversation-a')).toEqual([]);
  });

  it('keeps a promoted Task slot blocked when recovery validation fails', () => {
    const database = db();
    const repository = new ConversationTaskSchedulerRepo(database);
    repository.enqueueTask('task-a', 'conversation-a', '2026-08-29T00:00:00.000Z');
    repository.enqueueTask('task-b', 'conversation-a', '2026-08-29T00:01:00.000Z');
    repository.claimSlot('conversation-a', 'task-a', 'reservation-a', '2026-08-29T00:02:00.000Z');

    const promotion = repository.releaseSlotAndPromote(
      'conversation-a',
      'task-a',
      '2026-08-29T00:03:00.000Z',
    );
    expect(promotion?.taskId).toBe('task-b');
    expect(repository.markRecoveryBlocked(
      'conversation-a',
      'task-b',
      '2026-08-29T00:04:00.000Z',
    )).toBe(true);
    expect(repository.getSlot('conversation-a')).toMatchObject({
      activeTaskId: 'task-b',
      state: 'recovery_blocked',
    });
    expect(repository.promoteNextQueued('conversation-a', '2026-08-29T00:05:00.000Z')).toBeNull();
  });
});
