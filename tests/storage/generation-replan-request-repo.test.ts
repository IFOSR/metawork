import { describe, expect, it } from 'vitest';
import { GenerationReplanRequestRepo } from '../../src/storage/generation-replan-request-repo.js';
import type { KernelEvent } from '../../src/kernel/control-kernel.js';
import { REVISION, createV31RepositoryDb } from './v31-repository-fixture.js';

describe('GenerationReplanRequestRepo', () => {
  it('coalesces one generation request and rejects a Planner result after cancellation', () => {
    const db = createV31RepositoryDb();
    const repo = new GenerationReplanRequestRepo(db);
    const first = repo.enqueue({
      id: 'replan-first',
      taskId: 'task_1',
      generationId: 'generation-1',
      sourceRevision: 1,
      configurationRevision: REVISION,
      triggerDecisionId: 'decision-1',
      now,
    });
    const duplicate = repo.enqueue({
      id: 'replan-duplicate',
      taskId: 'task_1',
      generationId: 'generation-1',
      sourceRevision: 1,
      configurationRevision: REVISION,
      triggerDecisionId: 'decision-2',
      now,
    });

    expect(duplicate.id).toBe(first.id);
    expect(repo.markPlanning(first.id, 'quiescence-token', now)).toBe(true);
    expect(repo.cancelTask('task_1', 'cancel-decision', now)).toBe(1);
    expect(repo.markSubmitted(first.id, 'quiescence-token', now)).toBe(false);
    expect(repo.find(first.id)?.status).toBe('cancelled');
  });

  it('submits only with the exact quiescence token', () => {
    const db = createV31RepositoryDb();
    const repo = new GenerationReplanRequestRepo(db);
    const request = repo.enqueue({
      id: 'replan-token',
      taskId: 'task_1',
      generationId: 'generation-1',
      sourceRevision: 1,
      configurationRevision: REVISION,
      triggerDecisionId: 'decision-1',
      now,
    });

    expect(repo.markPlanning(request.id, 'quiescence-token', now)).toBe(true);
    expect(repo.markPlanning(request.id, 'quiescence-token', now)).toBe(true);
    expect(repo.markPlanning(request.id, 'different-token', now)).toBe(false);
    expect(repo.markSubmitted(request.id, 'stale-token', now)).toBe(false);
    expect(repo.markSubmitted(request.id, 'quiescence-token', now)).toBe(true);
    expect(repo.find(request.id)?.status).toBe('submitted');
  });

  it('commits the submitted request and Planner result inbox in one transaction', () => {
    const db = createV31RepositoryDb();
    const repo = new GenerationReplanRequestRepo(db);
    const request = repo.enqueue({
      id: 'replan-submit',
      taskId: 'task_1',
      generationId: 'generation-1',
      sourceRevision: 1,
      configurationRevision: REVISION,
      triggerDecisionId: 'decision-1',
      now,
    });
    repo.markPlanning(request.id, 'quiescence-token', now);
    const event: KernelEvent = {
      schemaVersion: 5,
      type: 'dispatch_requested',
      id: 'event-replan-result',
      correlationId: request.id,
      causationId: request.id,
      occurredAt: now,
      sessionId: 'session-replan',
      taskId: 'task_1',
      reason: 'Planner result persisted',
    };
    db.exec(`
      CREATE TRIGGER reject_replan_result
      BEFORE INSERT ON kernel_events
      WHEN NEW.id = 'event-replan-result'
      BEGIN
        SELECT RAISE(ABORT, 'injected replan inbox failure');
      END
    `);

    expect(() => repo.submitPlan(
      request.id,
      'quiescence-token',
      event,
      now,
    )).toThrow('injected replan inbox failure');
    expect(repo.find(request.id)?.status).toBe('planning');
    expect(db.prepare('SELECT 1 FROM kernel_events WHERE id = ?').get(event.id))
      .toBeUndefined();

    db.exec('DROP TRIGGER reject_replan_result');
    expect(repo.submitPlan(request.id, 'quiescence-token', event, now)).toBe(true);
    expect(repo.find(request.id)?.status).toBe('submitted');
    expect(db.prepare(`
      SELECT event_type, configuration_revision FROM kernel_events WHERE id = ?
    `).get(event.id)).toEqual({
      event_type: 'dispatch_requested',
      configuration_revision: REVISION,
    });
  });
});

const now = '2026-07-28T00:00:00.000Z';
