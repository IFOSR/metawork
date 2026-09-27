import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { RetryWakeRepo, type RetryWakeRecord } from '../../src/storage/retry-wake-repo.js';

const wake: RetryWakeRecord = {
  wakeId: 'retry_wake_decision_1',
  taskId: 'task_1',
  subtaskId: 'subtask_1',
  generationId: 'generation_1',
  sourceDecisionId: 'decision_1',
  sourceAttemptId: 'attempt_1',
  configurationRevision: 'revision_1',
  bindingFingerprint: 'fingerprint_1',
  authorizedBindingJson: JSON.stringify({ agentClassRef: 'executor-1' }),
  resumeAt: '2026-09-27T01:00:00.000Z',
  status: 'armed',
  timerEventId: null,
  consumedDecisionId: null,
  createdAt: '2026-09-27T00:59:00.000Z',
  updatedAt: '2026-09-27T00:59:00.000Z',
};

describe('RetryWakeRepo', () => {
  it('persists one armed wake and claims it at most once', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db);
      const repo = new RetryWakeRepo(db);

      expect(repo.arm(wake)).toBe(true);
      expect(repo.arm(wake)).toBe(false);
      expect(repo.findByDecision('decision_1')).toMatchObject(wake);

      expect(repo.claimDue('2026-09-27T01:00:00.000Z', '2026-09-27T01:00:00.001Z'))
        .toMatchObject({ wakeId: wake.wakeId, status: 'fired' });
      expect(repo.claimDue('2026-09-27T01:00:00.000Z', '2026-09-27T01:00:00.002Z'))
        .toBeNull();
    } finally {
      db.close();
    }
  });

  it('does not claim a wake before its due time and can supersede it idempotently', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db);
      const repo = new RetryWakeRepo(db);
      repo.arm(wake);

      expect(repo.claimDue('2026-09-27T00:59:59.999Z', '2026-09-27T00:59:59.999Z')).toBeNull();
      expect(repo.markSuperseded(wake.wakeId, '2026-09-27T01:00:01.000Z')).toBe(true);
      expect(repo.markSuperseded(wake.wakeId, '2026-09-27T01:00:02.000Z')).toBe(false);
      expect(repo.findBlockingByTask('task_1')).toEqual([]);
    } finally {
      db.close();
    }
  });
});
