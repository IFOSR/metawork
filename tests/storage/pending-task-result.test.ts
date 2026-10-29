import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { readPendingTaskResults } from '../../src/storage/pending-task-result.js';

const TASK = 'task_pending';
const GENERATION = 'generation_pending';
const SUBTASK = 'subtask_pending';

let db: Database.Database | null = null;
afterEach(() => { db?.close(); db = null; });

function insertReceipt(input: {
  attemptId: string;
  attemptKind: 'primary' | 'contract_correction';
  terminalState: 'uncertified_result' | 'executor_failed' | 'completed';
  completedAt: string;
  sourceAttemptId?: string | null;
}): void {
  db!.prepare(`INSERT INTO executor_attempt_receipts (
    attempt_id, execution_id, task_id, subtask_id, work_unit_id, agent_class_name,
    started_at, completed_at, terminal_state, raw_response, parsing_json, verification_json,
    attempt_kind, generation_id, graph_revision, configuration_revision,
    authorized_binding_json, binding_fingerprint, error_code, error_detail)
    VALUES (?, 'execution', ?, ?, 'work-unit', 'pi-agent', 'start', ?, ?, 'body', ?, '{}',
      ?, ?, 1, 'revision_1', '{}', 'fingerprint', ?, ?)`)
    .run(
      input.attemptId,
      TASK,
      SUBTASK,
      input.completedAt,
      input.terminalState,
      JSON.stringify({ resultObjects: { safeProjectionId: `${input.attemptId}_safe` } }),
      input.attemptKind,
      GENERATION,
      input.terminalState === 'uncertified_result' ? 'completion_malformed' : 'correction_exception',
      input.terminalState === 'uncertified_result' ? 'completion marker is missing' : 'correction failed',
    );
  db!.prepare(`INSERT INTO result_objects (
    result_id, account_id, task_id, generation_id, source_subtask_id, attempt_id,
    kind, media_type, byte_length, completeness, content_hash, storage_uri, retention_class, created_at)
    VALUES (?, 'local-default', ?, ?, ?, ?, 'safe_projection', 'text/markdown', 20, 'complete',
      'sha256:result', 'memory://result', 'task', 'start')`)
    .run(`${input.attemptId}_safe`, TASK, GENERATION, SUBTASK, input.attemptId);
}

function fixture(): void {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(`INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
    VALUES ('revision_1', 'hash', 'native', 'now')`).run();
  db.prepare(`INSERT INTO work_units (id, agent_class_name, agent_class_kind, created_at, updated_at)
    VALUES ('work-unit', 'pi-agent', 'executor', 'now', 'now')`).run();
  db.prepare(`INSERT INTO tasks (id, title, goal, status, account_id, created_at, updated_at)
    VALUES (?, 'Pending result', 'g', 'needs_action', 'local-default', 'now', 'now')`).run(TASK);
  db.prepare(`INSERT INTO work_graph_revisions (
    id, task_id, revision, generation_id, status, configuration_revision, created_at, updated_at)
    VALUES ('graph_1', ?, 1, ?, 'active', 'revision_1', 'now', 'now')`).run(TASK, GENERATION);
  db.prepare(`INSERT INTO subtasks (
    id, task_id, generation_id, graph_revision, title, goal, status, dependencies_json,
    context_refs_json, required_capabilities_json, executor_bindings_json, file_outputs_json,
    acceptance_json, risk_level, created_at, updated_at)
    VALUES (?, ?, ?, 1, 'Report', 'g', 'awaiting_decision', '[]', '[]', '[]', '[]', '[]',
      '[]', 'low', 'now', 'now')`).run(SUBTASK, TASK, GENERATION);
}

describe('pending safe result selection', () => {
  it('keeps the safe result acceptable when a later metadata correction failed', () => {
    fixture();
    insertReceipt({
      attemptId: 'attempt_primary',
      attemptKind: 'primary',
      terminalState: 'uncertified_result',
      completedAt: '2026-10-28T14:29:59.000Z',
    });
    // The correction only repairs completion metadata and failed in the Runtime.
    insertReceipt({
      attemptId: 'attempt_correction',
      attemptKind: 'contract_correction',
      terminalState: 'executor_failed',
      completedAt: '2026-10-28T14:30:02.000Z',
      sourceAttemptId: 'attempt_primary',
    });

    expect(readPendingTaskResults(db!, TASK)).toEqual([{
      taskId: TASK,
      generationId: GENERATION,
      graphRevision: 1,
      subtaskId: SUBTASK,
      attemptId: 'attempt_primary',
      resultId: 'attempt_primary_safe',
    }]);
  });

  it('lets a newer result-producing attempt supersede the older safe result', () => {
    fixture();
    insertReceipt({
      attemptId: 'attempt_primary',
      attemptKind: 'primary',
      terminalState: 'uncertified_result',
      completedAt: '2026-10-28T14:29:59.000Z',
    });
    insertReceipt({
      attemptId: 'attempt_retry',
      attemptKind: 'primary',
      terminalState: 'completed',
      completedAt: '2026-10-28T14:35:00.000Z',
    });

    expect(readPendingTaskResults(db!, TASK)).toEqual([]);
  });
});
