import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { GuidanceRepo } from '../../src/storage/guidance-repo.js';

describe('GuidanceRepo', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  it('persists and updates a proposal lifecycle event', () => {
    const repo = new GuidanceRepo(db);

    repo.insert({
      id: 'guid_1',
      trigger: 'startup',
      taskId: 'task_1',
      actionType: 'resume_task',
      payload: { taskId: 'task_1', source: 'startup' },
      reasons: ['材料已齐'],
      confidence: 0.92,
      requiresConfirmation: true,
      acceptedAt: null,
      dismissedAt: null,
      executedAt: null,
      createdAt: '2026-04-20T00:00:00Z',
    });

    repo.markAccepted('guid_1', '2026-04-20T00:02:00Z');
    repo.markExecuted('guid_1', '2026-04-20T00:05:00Z');

    const row = repo.findById('guid_1');
    expect(row).not.toBeNull();
    expect(row?.actionType).toBe('resume_task');
    expect(row?.payload).toEqual({ taskId: 'task_1', source: 'startup' });
    expect(row?.reasons).toEqual(['材料已齐']);
    expect(row?.requiresConfirmation).toBe(true);
    expect(row?.acceptedAt).toBe('2026-04-20T00:02:00Z');
    expect(row?.executedAt).toBe('2026-04-20T00:05:00Z');
  });
});
