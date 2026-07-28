import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { GenerationReplanRequestRepo } from '../../src/storage/generation-replan-request-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { KernelWorkflowRepo } from '../../src/storage/kernel-workflow-repo.js';
import type { KernelEvent } from '../../src/kernel/control-kernel.js';

describe('GenerationReplanRequestRepo', () => {
  it('coalesces one generation request and rejects a Planner result after cancellation', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const task = new TaskEngine(new TaskRepo(db), '/tmp/replan-cas').create({
      id: 'task-replan-cas',
      title: 'Replan',
      goal: 'Replan once',
    });
    const repo = new GenerationReplanRequestRepo(db);
    const first = repo.enqueue({
      id: 'replan-first',
      taskId: task.id,
      generationId: 'generation-1',
      sourceRevision: 1,
      triggerDecisionId: 'decision-1',
      now,
    });
    const duplicate = repo.enqueue({
      id: 'replan-duplicate',
      taskId: task.id,
      generationId: 'generation-1',
      sourceRevision: 1,
      triggerDecisionId: 'decision-2',
      now,
    });

    expect(duplicate.id).toBe(first.id);
    expect(repo.markPlanning(first.id, 'quiescence-token', now)).toBe(true);
    expect(repo.cancelTask(task.id, 'cancel-decision', now)).toBe(1);
    expect(repo.markSubmitted(first.id, 'quiescence-token', now)).toBe(false);
    expect(repo.find(first.id)?.status).toBe('cancelled');
  });

  it('submits only with the exact quiescence token', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const task = new TaskEngine(new TaskRepo(db), '/tmp/replan-token').create({
      id: 'task-replan-token',
      title: 'Replan',
      goal: 'Validate token',
    });
    const repo = new GenerationReplanRequestRepo(db);
    const request = repo.enqueue({
      id: 'replan-token',
      taskId: task.id,
      generationId: 'generation-1',
      sourceRevision: 1,
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
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const task = new TaskEngine(new TaskRepo(db), '/tmp/replan-submit').create({
      id: 'task-replan-submit',
      title: 'Replan',
      goal: 'Persist the Planner result',
    });
    const repo = new GenerationReplanRequestRepo(db);
    const request = repo.enqueue({
      id: 'replan-submit',
      taskId: task.id,
      generationId: 'generation-1',
      sourceRevision: 1,
      triggerDecisionId: 'decision-1',
      now,
    });
    repo.markPlanning(request.id, 'quiescence-token', now);
    const event: KernelEvent = {
      schemaVersion: 4,
      type: 'dispatch_requested',
      id: 'event-replan-result',
      correlationId: request.id,
      causationId: request.id,
      occurredAt: now,
      sessionId: 'session-replan',
      taskId: task.id,
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
    expect(new KernelWorkflowRepo(db).findEvent(event.id)).toBeNull();

    db.exec('DROP TRIGGER reject_replan_result');
    expect(repo.submitPlan(request.id, 'quiescence-token', event, now)).toBe(true);
    expect(repo.find(request.id)?.status).toBe('submitted');
    expect(new KernelWorkflowRepo(db).findEvent(event.id)).toMatchObject({
      id: event.id,
      type: 'dispatch_requested',
    });
  });
});

const now = '2026-07-28T00:00:00.000Z';
