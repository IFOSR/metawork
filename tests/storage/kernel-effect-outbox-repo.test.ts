import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { KernelEffectOutboxRepo } from '../../src/storage/kernel-effect-outbox-repo.js';

describe('KernelEffectOutboxRepo', () => {
  it('does not automatically resend an effect whose provider result is unknown', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    seedDecision(db);
    const repo = new KernelEffectOutboxRepo(db);
    const now = '2026-07-21T00:00:00.000Z';
    repo.enqueue({
      id: 'effect_1', decisionId: 'decision_1', taskId: null,
      effectType: 'message', payload: { text: 'hello' }, availableAt: now,
    });
    const sender = vi.fn().mockRejectedValue(new Error('provider response lost'));

    expect(await repo.deliver('effect_1', sender, () => now)).toMatchObject({ status: 'uncertain', deliveryAttempts: 1 });
    expect(await repo.deliver('effect_1', sender, () => now)).toMatchObject({ status: 'uncertain', deliveryAttempts: 1 });
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('marks an in-flight effect uncertain during startup reconcile', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    seedDecision(db);
    const repo = new KernelEffectOutboxRepo(db);
    const now = '2026-07-21T00:00:00.000Z';
    repo.enqueue({ id: 'effect_1', decisionId: 'decision_1', effectType: 'message', payload: {}, availableAt: now });
    db.prepare(`UPDATE kernel_effect_outbox SET status = 'sending' WHERE id = 'effect_1'`).run();

    expect(repo.reconcileSending(now)).toBe(1);
    expect(repo.find('effect_1')).toMatchObject({ status: 'uncertain' });
  });
});

function seedDecision(db: Database.Database): void {
  db.prepare(`
    INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
    VALUES ('revision_effect', 'sha256:test', 'native', '2026-07-21T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO kernel_events (
      id, schema_version, event_type, correlation_id, causation_id, session_id,
      task_id, subtask_id, attempt_id, event_json, available_at, status,
      configuration_revision, created_at, updated_at
    ) VALUES ('event_1', 2, 'timer_tick', 'correlation_1', NULL, 'session_1',
      NULL, NULL, NULL, '{}', '2026-07-21T00:00:00.000Z', 'processed',
      'revision_effect', '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO kernel_decisions (
      id, schema_version, event_id, event_type, correlation_id, causation_id,
      session_id, task_id, subtask_id, attempt_id, event_json, snapshot_json,
      decision_json, action, reason, configuration_revision, created_at
    ) VALUES ('decision_1', 2, 'event_1', 'timer_tick', 'correlation_1', NULL,
      'session_1', NULL, NULL, NULL, '{}', '{}', '{}', 'no_op', 'test',
      'revision_effect', '2026-07-21T00:00:00.000Z')
  `).run();
}