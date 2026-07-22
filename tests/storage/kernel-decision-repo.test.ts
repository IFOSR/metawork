import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { KernelDecisionRepo } from '../../src/storage/kernel-decision-repo.js';
import type { KernelDecision, KernelEvent, KernelSnapshot } from '../../src/kernel/control-kernel.js';

function createRecord() {
  const event: KernelEvent = {
    schemaVersion: 3, type: 'timer_tick', id: 'event_1', correlationId: 'correlation_1', causationId: null,
    occurredAt: '2026-07-20T00:00:00.000Z', sessionId: 'session_1', taskId: 'task_1', subtaskId: 'subtask_1',
    wakeKind: 'capacity', sourceDecisionId: 'decision_capacity', scheduledFor: '2026-07-20T00:00:00.000Z', retry: null,
  };
  const snapshot: KernelSnapshot = {
    schemaVersion: 3, type: 'timer', capacityBlockedAt: null, recheckAfterMs: 1000,
    task: { id: 'task_1', status: 'blocked' }, wakeAuthorized: true,
    nativeContinuationAgentClasses: [],
    capacityAgentClasses: [], executorStatuses: [],
    defaultResourceGrant: [],
  };
  const decision: KernelDecision = {
    schemaVersion: 3, id: 'decision_event_1', eventId: event.id, action: { type: 'no_op' }, reason: 'nothing due',
  };
  return {
    id: decision.id, schemaVersion: 3 as const, eventId: event.id, eventType: event.type,
    correlationId: event.correlationId, causationId: event.causationId, sessionId: event.sessionId,
    taskId: event.taskId ?? null, subtaskId: event.subtaskId ?? null, attemptId: event.attemptId ?? null,
    event, snapshot, decision, action: decision.action.type, reason: decision.reason, createdAt: event.occurredAt,
  };
}

describe('KernelDecisionRepo', () => {
  it('issues at most one decision for an event', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const repo = new KernelDecisionRepo(db);
    const record = createRecord();

    expect(repo.insertIfAbsent(record)).toBe(true);
    expect(repo.insertIfAbsent({ ...record, id: 'another_decision' })).toBe(false);
    expect(repo.findByEventId(record.eventId)).toMatchObject({ id: record.id, action: 'no_op' });
  });

  it('preserves legacy planning audit rows and rejects writes', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(() => db.prepare(`
      INSERT INTO planning_decisions_legacy_audit
      (id, session_id, request_id, task_id, user_input, plan_json, decision_json, outcome, reason, created_at)
      VALUES ('x', 's', 'r', NULL, '', '{}', '{}', 'accept', '', '')
    `).run()).toThrow(/read-only/);
  });
});
