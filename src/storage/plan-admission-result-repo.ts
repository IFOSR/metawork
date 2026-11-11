import type Database from 'better-sqlite3';
import {
  planAdmissionResultIdentity,
  type PlanAdmissionOutcomeStatus,
  type PlanAdmissionResultInput,
  type PlanAdmissionResultRecord,
  type PlanAdmissionResultStore,
} from '../execution/plan-admission-result-store.js';

const PLAN_ADMISSION_RESULT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS task_plan_admission_results (
    proposal_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK(status IN (
      'authorized', 'queued', 'deferred',
      'rejected', 'clarification', 'direct_reply', 'no_action',
      'task_control', 'permission_resolution'
    )),
    task_id TEXT,
    generation_id TEXT,
    graph_revision INTEGER,
    reason TEXT NOT NULL,
    detail_json TEXT,
    applied_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS task_plan_admission_results_applied
    ON task_plan_admission_results(status, applied_at, proposal_id);
`;

interface ResultRow {
  proposal_id: string;
  operation_id: string;
  status: PlanAdmissionOutcomeStatus;
  task_id: string | null;
  generation_id: string | null;
  graph_revision: number | null;
  reason: string;
  detail_json: string | null;
  applied_at: string;
}

export function ensurePlanAdmissionResultSchema(db: Database.Database): void {
  db.exec(PLAN_ADMISSION_RESULT_SCHEMA_SQL);
}

/**
 * Applied admission outcomes. The primary key is the proposal, so a second
 * writer for the same Manager output cannot record a different result.
 */
export class PlanAdmissionResultRepo implements PlanAdmissionResultStore {
  constructor(private readonly db: Database.Database) {
    ensurePlanAdmissionResultSchema(db);
  }

  find(proposalId: string): PlanAdmissionResultRecord | null {
    const row = this.db.prepare('SELECT * FROM task_plan_admission_results WHERE proposal_id = ?')
      .get(proposalId) as ResultRow | undefined;
    return row ? fromRow(row) : null;
  }

  record(input: PlanAdmissionResultInput): PlanAdmissionResultRecord {
    if (!input.proposalId || !input.operationId || !input.reason
      || !Number.isFinite(Date.parse(input.appliedAt))) {
      throw new Error('invalid plan admission result identity');
    }
    if (input.graphRevision !== undefined && input.graphRevision !== null
      && (!Number.isSafeInteger(input.graphRevision) || input.graphRevision < 1)) {
      throw new Error('invalid plan admission graph revision');
    }
    const expected = {
      status: input.status,
      taskId: input.taskId ?? null,
      generationId: input.generationId ?? null,
      graphRevision: input.graphRevision ?? null,
      detail: input.detail ?? null,
    };
    return this.db.transaction(() => {
      const previous = this.find(input.proposalId);
      if (previous) {
        if (previous.operationId !== input.operationId
          || planAdmissionResultIdentity(previous) !== planAdmissionResultIdentity(expected)) {
          throw new Error(`plan admission result conflict: ${input.proposalId}`);
        }
        return previous;
      }
      this.db.prepare(`
        INSERT INTO task_plan_admission_results (
          proposal_id, operation_id, status, task_id, generation_id,
          graph_revision, reason, detail_json, applied_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.proposalId,
        input.operationId,
        input.status,
        expected.taskId,
        expected.generationId,
        expected.graphRevision,
        input.reason,
        expected.detail ? JSON.stringify(expected.detail) : null,
        input.appliedAt,
      );
      return this.find(input.proposalId)!;
    }).immediate();
  }
}

function fromRow(row: ResultRow): PlanAdmissionResultRecord {
  return {
    operationId: row.operation_id,
    proposalId: row.proposal_id,
    status: row.status,
    taskId: row.task_id,
    generationId: row.generation_id,
    graphRevision: row.graph_revision,
    reason: row.reason,
    detail: row.detail_json ? JSON.parse(row.detail_json) as Record<string, string> : null,
    appliedAt: row.applied_at,
  };
}
