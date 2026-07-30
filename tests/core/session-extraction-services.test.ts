import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { SessionPersistenceService } from '../../src/session/session-persistence-service.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('session extraction services', () => {
  it('persists interactions outside MetaclawSession', () => {
    const db = createTestDb();
    const service = new SessionPersistenceService(db);

    service.recordInteraction({
      taskId: 'task_1',
      sessionId: 'session_1',
      userInput: 'build it',
      systemOutput: 'done',
      executorUsed: 'codex-cli',
    });

    const interaction = db.prepare('SELECT task_id, session_id, user_input, system_output, executor_used FROM interactions').get() as Record<string, string>;
    expect(interaction).toMatchObject({
      task_id: 'task_1',
      session_id: 'session_1',
      user_input: 'build it',
      system_output: 'done',
      executor_used: 'codex-cli',
    });
  });
});
