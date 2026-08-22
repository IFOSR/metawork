import type Database from 'better-sqlite3';
import type { CompletionHandoffV4 } from '../execution/completion-protocol.js';
import type { ResultReferenceRecord } from './result-object-repo.js';

export type PersistedSubtaskHandoffItem =
  | CompletionHandoffV4['items'][number]
  | {
      key: string;
      type: 'result_reference';
      referenceId: string;
      summary: string;
    };

export interface PersistedSubtaskHandoff {
  taskId: string;
  fromSubtaskId: string;
  toSubtaskId: string;
  attemptId: string;
  items: PersistedSubtaskHandoffItem[];
  resultReference?: ResultReferenceRecord | null;
  completionSchemaVersion: number;
  createdAt: string;
}

interface HandoffRow {
  task_id: string;
  from_subtask_id: string;
  to_subtask_id: string;
  attempt_id: string;
  items_json: string;
  completion_schema_version: number;
  created_at: string;
}

export class SubtaskHandoffRepo {
  constructor(private readonly db: Database.Database) {}

  insert(handoff: PersistedSubtaskHandoff): void {
    this.db.prepare(`
      INSERT INTO subtask_handoffs (
        task_id, from_subtask_id, to_subtask_id, attempt_id,
        items_json, completion_schema_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      handoff.taskId,
      handoff.fromSubtaskId,
      handoff.toSubtaskId,
      handoff.attemptId,
      JSON.stringify(handoff.resultReference
        ? {
            schemaVersion: 4,
            items: handoff.items,
            resultReference: handoff.resultReference,
          }
        : handoff.items),
      handoff.completionSchemaVersion,
      handoff.createdAt,
    );
  }

  listIncoming(taskId: string, toSubtaskId: string): PersistedSubtaskHandoff[] {
    const rows = this.db.prepare(`
      SELECT * FROM subtask_handoffs
      WHERE task_id = ? AND to_subtask_id = ?
      ORDER BY from_subtask_id ASC
    `).all(taskId, toSubtaskId) as HandoffRow[];
    return rows.map(rowToHandoff);
  }

  listByTask(taskId: string): PersistedSubtaskHandoff[] {
    const rows = this.db.prepare(`
      SELECT * FROM subtask_handoffs
      WHERE task_id = ? ORDER BY from_subtask_id ASC, to_subtask_id ASC
    `).all(taskId) as HandoffRow[];
    return rows.map(rowToHandoff);
  }
}

function rowToHandoff(row: HandoffRow): PersistedSubtaskHandoff {
  const stored = JSON.parse(row.items_json) as
    | PersistedSubtaskHandoffItem[]
    | {
        schemaVersion: 4;
        items: PersistedSubtaskHandoffItem[];
        resultReference: ResultReferenceRecord;
      };
  return {
    taskId: row.task_id,
    fromSubtaskId: row.from_subtask_id,
    toSubtaskId: row.to_subtask_id,
    attemptId: row.attempt_id,
    items: Array.isArray(stored) ? stored : stored.items,
    resultReference: Array.isArray(stored) ? null : stored.resultReference,
    completionSchemaVersion: row.completion_schema_version,
    createdAt: row.created_at,
  };
}
