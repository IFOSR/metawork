import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initializeDatabaseSchema } from '../../src/storage/schema.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { WorkGraphRevisionRepo } from '../../src/storage/work-graph-revision-repo.js';
import { SqliteTaskStateFactsReader } from '../../src/storage/task-state-facts-reader.js';
import { readTaskEvaluationInput } from '../../src/task/task-state-facts.js';

describe('completion recovery presentation', () => {
  it.each(['complete_task', 'dispatch_subtask'])('distinguishes %s from unknown external effects', action => {
    const db = new Database(':memory:');
    try {
      initializeDatabaseSchema(db);
      db.prepare("INSERT INTO tasks (id,title,created_at,updated_at) VALUES ('task','Analysis','now','now')").run();
      db.prepare(`INSERT INTO task_recovery_items (id,decision_id,event_id,idempotency_key,status,
        decision_json,created_at,updated_at,task_id,error_summary)
        VALUES ('recovery','decision','event','key','retry_authorized',?,'now','now','task','summary failed')`)
        .run(JSON.stringify({ action: { type: action, taskId: 'task' } }));
      const facts = new SqliteTaskStateFactsReader({ db, taskRepo: new TaskRepo(db), subtaskRepo: new SubtaskRepo(db),
        workGraphRevisionRepo: new WorkGraphRevisionRepo(db), readPendingResult: () => null,
        residue: { blockingReasons: () => ['kernel_application'] }, operationResults: { listByTask: () => [] } }).read('task')!;
      expect(facts.externalOutcomeUnknown).toBe(action !== 'complete_task');
      const input = readTaskEvaluationInput(facts);
      expect(input.pendingActions).toContainEqual(expect.objectContaining({
        kind: 'resolve_recovery', reason: expect.objectContaining({ code: action === 'complete_task' ? 'system_anomaly' : 'external_outcome_unknown' }),
      }));
      if (action === 'complete_task') expect(input.pendingActions[0]!.reason.message).toContain('最终结果');
    } finally { db.close(); }
  });
});
