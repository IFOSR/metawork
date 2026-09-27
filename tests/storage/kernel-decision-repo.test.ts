import { describe, expect, it } from 'vitest';
import { KernelDecisionRepo } from '../../src/storage/kernel-decision-repo.js';
import type { KernelDecision, KernelEvent, KernelSnapshot } from '../../src/kernel/control-kernel.js';
import { REVISION, createV31RepositoryDb } from './v31-repository-fixture.js';

function createRecord() {
  const event: KernelEvent = {
    schemaVersion: 5, type: 'timer_tick', id: 'event_1', correlationId: 'correlation_1', causationId: null,
    occurredAt: '2026-07-20T00:00:00.000Z', sessionId: 'session_1', taskId: 'task_1', subtaskId: 'subtask_1',
    wakeKind: 'capacity', sourceDecisionId: 'decision_capacity', scheduledFor: '2026-07-20T00:00:00.000Z', retry: null,
  };
  const snapshot: KernelSnapshot = {
    schemaVersion: 5, type: 'timer', capacityBlockedAt: null, recheckAfterMs: 1000,
    task: { id: 'task_1', status: 'blocked' }, wakeAuthorized: true,
    nativeContinuationAgentClasses: [],
    capacityAgentClasses: [], executorStatuses: [],
    defaultResourceGrant: [],
  };
  const decision: KernelDecision = {
    schemaVersion: 5, id: 'decision_event_1', eventId: event.id, action: { type: 'no_op' }, reason: 'nothing due',
  };
  const authorizedBinding = {
    agentClassRef: 'codex-engineering',
    harnessRef: 'codex-cli',
    providerRef: 'openai',
    modelRef: 'engineering-model',
    permissionProfileRef: 'workspace-default',
    configurationRevision: REVISION,
  };
  return {
    id: decision.id, schemaVersion: 5 as const, eventId: event.id, eventType: event.type,
    correlationId: event.correlationId, causationId: event.causationId, sessionId: event.sessionId,
    taskId: event.taskId ?? null, subtaskId: event.subtaskId ?? null, attemptId: event.attemptId ?? null,
    event, snapshot, decision, action: decision.action.type, reason: decision.reason,
    configurationRevision: REVISION,
    authorizedBindings: [authorizedBinding],
    bindingFingerprints: ['sha256:binding'],
    createdAt: event.occurredAt,
  };
}

describe('KernelDecisionRepo', () => {
  it('reads only the latest plan identities for a set of visible Tasks', () => {
    const db = createV31RepositoryDb();
    try {
      const repo = new KernelDecisionRepo(db);
      const base = createRecord();
      for (let n = 0; n < 3; n += 1) {
        repo.insertIfAbsent({
          ...base, id: `decision_${n}`, eventId: `event_${n}`,
          taskId: n === 2 ? 'unrelated' : 'task_1',
          createdAt: `2026-07-20T00:00:0${n}.000Z`,
        });
        db.prepare(`UPDATE kernel_decisions SET action = 'authorize_task_plan',
          event_json = 'not-read', snapshot_json = 'not-read', decision_json = ?
          WHERE id = ?`).run(JSON.stringify({
          schemaVersion: 5,
          action: {
            type: 'authorize_task_plan', taskId: n === 2 ? 'unrelated' : 'task_1',
            graphRevision: n + 1,
            workGraph: { subtasks: [{ id: `proposal_${n}`, context: 'large ignored payload' }] },
          },
        }), `decision_${n}`);
      }
      expect(repo.listPresentationIdentitiesByTasks(['task_1', 'missing'])).toEqual([
        { taskId: 'task_1', graphRevision: 2, subtaskIds: ['proposal_1'] },
      ]);
      expect(repo.listPresentationIdentitiesByTasks([])).toEqual([]);
    } finally { db.close(); }
  });

  it('issues at most one decision for an event', () => {
    const db = createV31RepositoryDb();
    const repo = new KernelDecisionRepo(db);
    const record = createRecord();

    expect(repo.insertIfAbsent(record)).toBe(true);
    expect(repo.insertIfAbsent({ ...record, id: 'another_decision' })).toBe(false);
    expect(repo.findByEventId(record.eventId)).toMatchObject({ id: record.id, action: 'no_op' });
    expect(repo.findById(record.id)).toMatchObject({ eventId: record.eventId, sessionId: 'session_1' });
  });

  it('fails closed when a persisted Decision is not the unique v4 contract', () => {
    const db = createV31RepositoryDb();
    const repo = new KernelDecisionRepo(db);
    const record = createRecord();
    repo.insertIfAbsent(record);
    db.prepare(`
      UPDATE kernel_decisions
      SET schema_version = 3,
          decision_json = json_set(decision_json, '$.schemaVersion', 3)
      WHERE id = ?
    `).run(record.id);

    expect(() => repo.findByEventId(record.eventId))
      .toThrow('unsupported Kernel decision schema version 3');
  });

  it('reads a bounded lightweight timeline without parsing ledger JSON bodies', () => {
    const db = createV31RepositoryDb();
    const repo = new KernelDecisionRepo(db);
    const base = createRecord();
    for (let index = 1; index <= 3; index += 1) {
      const event = {
        ...base.event,
        id: `event_${index}`,
        occurredAt: `2026-07-20T00:00:0${index}.000Z`,
      };
      const decision = {
        ...base.decision,
        id: `decision_event_${index}`,
        eventId: event.id,
        reason: `reason ${index}`,
      };
      repo.insertIfAbsent({
        ...base,
        id: decision.id,
        eventId: event.id,
        event,
        decision,
        reason: decision.reason,
        createdAt: event.occurredAt,
      });
    }

    db.prepare(`
      UPDATE kernel_decisions
      SET event_json = 'not-json',
          snapshot_json = 'not-json',
          decision_json = 'not-json'
      WHERE id = 'decision_event_3'
    `).run();

    expect(repo.listTimelineByTask('task_1', 2)).toEqual([
      {
        action: 'no_op',
        taskId: 'task_1',
        subtaskId: 'subtask_1',
        reason: 'reason 2',
      },
      {
        action: 'no_op',
        taskId: 'task_1',
        subtaskId: 'subtask_1',
        reason: 'reason 3',
      },
    ]);
  });
});
