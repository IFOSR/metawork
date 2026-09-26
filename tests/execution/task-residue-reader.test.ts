import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskResidueReader } from '../../src/execution/task-residue-reader.js';
import { runMigrations } from '../../src/storage/migrations.js';

const databases: Database.Database[] = [];
const TASK_ID = 'task_residue';
const GENERATION_ID = `generation_${TASK_ID}_1`;
const NOW = '2026-09-25T00:00:00.000Z';

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture(claimed = false) {
  const db = new Database(':memory:');
  databases.push(db);
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`
    INSERT INTO tasks (
      id, title, goal, status, created_at, updated_at,
      account_id, conversation_id, workspace_id, owner_planner_session_id, admitted_at
    ) VALUES (?, 'Residue task', 'goal', 'blocked', ?, ?, 'a', 'c', 'w', 'c', ?)
  `).run(TASK_ID, NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
    VALUES ('revision-test', 'hash', 'schema-30-import', ?)
  `).run(NOW);
  const reader = new TaskResidueReader({
    db,
    dispatchItemRepo: {
      hasBlockingResidue: taskId => Boolean(db.prepare(`
        SELECT 1 FROM kernel_dispatch_items
        WHERE task_id = ? AND status IN ('pending_launch', 'launching', 'running', 'cancelling')
        LIMIT 1
      `).get(taskId)),
    },
    publicationRepo: {
      hasBlockingResidue: taskId => Boolean(db.prepare(`
        SELECT 1 FROM workspace_publications
        WHERE task_id = ? AND status IN ('pending', 'applying', 'conflicted', 'cancelling', 'uncertain')
        LIMIT 1
      `).get(taskId)),
    },
    workUnitClaimService: { hasClaimedByTask: () => claimed },
  });
  return { db, reader };
}

function seedDecisionEvent(db: Database.Database, id: string, action: string, status: string): void {
  db.prepare(`
    INSERT INTO kernel_events (
      id, schema_version, event_type, correlation_id, causation_id,
      session_id, task_id, subtask_id, attempt_id, event_json,
      available_at, status, processing_started_at, processed_at,
      last_error, configuration_revision, created_at, updated_at
    ) VALUES (?, 5, 'dispatch_requested', ?, NULL, 'c', ?, NULL, NULL, '{}',
      ?, 'processed', NULL, NULL, NULL, 'revision-test', ?, ?)
  `).run(id, TASK_ID, TASK_ID, NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO kernel_decisions (
      id, schema_version, event_id, event_type, correlation_id, causation_id,
      session_id, task_id, subtask_id, attempt_id, event_json, snapshot_json,
      decision_json, action, reason, configuration_revision,
      authorized_bindings_json, binding_fingerprints_json, created_at
    ) VALUES (?, 5, ?, 'dispatch_requested', ?, NULL, 'c', ?, NULL, NULL, '{}', '{}',
      '{}', ?, 'fixture', 'revision-test', '[]', '[]', ?)
  `).run(`decision-${id}`, id, TASK_ID, TASK_ID, action, NOW);
  db.prepare(`
    INSERT INTO kernel_decision_applications (
      id, decision_id, event_id, idempotency_key, status, apply_attempts,
      observation_event_id, observation_event_json, error_summary,
      created_at, updated_at, applying_at, applied_at
    ) VALUES (?, ?, ?, ?, ?, 1, NULL, NULL, NULL, ?, ?, NULL, NULL)
  `).run(`application-${id}`, `decision-${id}`, id, `decision:${id}`, status, NOW, NOW);
}

describe('TaskResidueReader', () => {
  it('treats pending, applying and uncertain Kernel applications as residue', () => {
    const { db, reader } = fixture();
    for (const status of ['pending', 'applying', 'uncertain']) {
      const eventId = `event-${status}`;
      seedDecisionEvent(db, eventId, 'dispatch_batch', status);
      expect(reader.blockingReasons(TASK_ID, GENERATION_ID), status).toContain('kernel_application');
      db.prepare('DELETE FROM kernel_decision_applications WHERE decision_id = ?')
        .run(`decision-${eventId}`);
      db.prepare('DELETE FROM kernel_decisions WHERE id = ?').run(`decision-${eventId}`);
      db.prepare('DELETE FROM kernel_events WHERE id = ?').run(eventId);
    }
  });

  it('ignores an applied application', () => {
    const { db, reader } = fixture();
    seedDecisionEvent(db, 'event-applied', 'dispatch_batch', 'applied');
    expect(reader.blockingReasons(TASK_ID, GENERATION_ID)).toEqual([]);
  });

  it('treats a terminal dispatch item without a receipt as residue', () => {
    const { db, reader } = fixture();
    db.prepare(`
      INSERT INTO subtasks (
        id, task_id, title, goal, status, required_capabilities_json,
        executor_bindings_json, created_at, updated_at, graph_revision, generation_id
      ) VALUES (?, ?, 'Node', 'Node', 'blocked', '[]', '[]', ?, ?, 1, ?)
    `).run(`${TASK_ID}_execute`, TASK_ID, NOW, NOW, GENERATION_ID);
    seedDecisionEvent(db, 'event-seal', 'dispatch_batch', 'applied');
    db.prepare(`
      INSERT INTO kernel_dispatch_items (
        attempt_id, decision_id, batch_order, task_id, generation_id, subtask_id,
        agent_class_name, configuration_revision, authorized_binding_json,
        binding_fingerprint, attempt_kind, source_attempt_id, recovery_mode,
        attempt_payload_json, resource_grant_json, status, work_unit_id,
        created_at, updated_at
      ) VALUES ('attempt-seal', 'decision-event-seal', 0, ?, ?, ?, 'codex-cli', 'revision-test',
        '{}', 'fp', 'primary', NULL, 'fresh', '{}', '[]', 'terminal', 'work-unit-seal', ?, ?)
    `).run(TASK_ID, GENERATION_ID, `${TASK_ID}_execute`, NOW, NOW);
    expect(reader.blockingReasons(TASK_ID, GENERATION_ID)).toContain('attempt_receipt');
  });

  it('honors an explicit excluded Decision instead of ignoring the whole category', () => {
    const { db, reader } = fixture();
    seedDecisionEvent(db, 'event-self', 'cancel_task', 'applying');
    seedDecisionEvent(db, 'event-other', 'dispatch_batch', 'pending');
    expect(reader.blockingReasons(TASK_ID, GENERATION_ID, 'decision-event-self'))
      .toContain('kernel_application');
    // Excluding both leaves the Task clean, proving the exclusion is by identity.
    expect(reader.blockingReasons(TASK_ID, GENERATION_ID, 'decision-event-self')).not.toContain('dispatch');
    expect(reader.blockingReasons(TASK_ID, GENERATION_ID)).toContain('kernel_application');
  });

  it('reports a claimed WorkUnit, outstanding Replan Job and live lease', () => {
    const { db, reader } = fixture(true);
    db.prepare(`
      INSERT INTO generation_replan_requests (
        id, task_id, generation_id, source_revision, status, trigger_decision_id,
        configuration_revision, deferred_bindings_json, created_at, updated_at
      ) VALUES ('job-1', ?, ?, 1, 'planning', 'trigger', 'revision-test', '[]', ?, ?)
    `).run(TASK_ID, GENERATION_ID, NOW, NOW);
    expect(reader.blockingReasons(TASK_ID, GENERATION_ID))
      .toEqual(expect.arrayContaining(['work_unit', 'generation_replan']));
  });

  it('treats a deferred-for-availability Replan Job as unfinished residue', () => {
    const { db, reader } = fixture();
    for (const status of [
      'pending_quiescence',
      'planning',
      'submitted',
      'waiting_for_availability',
    ]) {
      db.prepare('DELETE FROM generation_replan_requests').run();
      db.prepare(`
        INSERT INTO generation_replan_requests (
          id, task_id, generation_id, source_revision, status, trigger_decision_id,
          configuration_revision, deferred_bindings_json, created_at, updated_at
        ) VALUES ('job-1', ?, ?, 1, ?, 'trigger', 'revision-test', '[]', ?, ?)
      `).run(TASK_ID, GENERATION_ID, status, NOW, NOW);
      expect(reader.blockingReasons(TASK_ID, GENERATION_ID), status)
        .toContain('generation_replan');
    }
    // A resolved or failed Job is terminal residue and must not hold the slot.
    db.prepare('DELETE FROM generation_replan_requests').run();
    db.prepare(`
      INSERT INTO generation_replan_requests (
        id, task_id, generation_id, source_revision, status, trigger_decision_id,
        configuration_revision, deferred_bindings_json, created_at, updated_at
      ) VALUES ('job-1', ?, ?, 1, 'resolved', 'trigger', 'revision-test', '[]', ?, ?)
    `).run(TASK_ID, GENERATION_ID, NOW, NOW);
    expect(reader.blockingReasons(TASK_ID, GENERATION_ID)).toEqual([]);
  });
});
