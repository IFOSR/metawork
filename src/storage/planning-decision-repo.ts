import type Database from 'better-sqlite3';

export interface PlanningDecisionAuditRecord {
  id: string;
  sessionId: string;
  requestId: string;
  taskId: string | null;
  userInput: string;
  plan: unknown;
  decision: unknown;
  planSchemaVersion: number | null;
  decisionPlanSchemaVersion: number | null;
  outcome: string;
  reason: string;
  createdAt: string;
}

interface PlanningDecisionRow {
  id: string;
  session_id: string;
  request_id: string;
  task_id: string | null;
  user_input: string;
  plan_json: string;
  decision_json: string;
  outcome: string;
  reason: string;
  created_at: string;
}

export class PlanningDecisionRepo {
  constructor(private readonly db: Database.Database) {}

  findById(id: string): PlanningDecisionAuditRecord | null {
    const row = this.db.prepare('SELECT * FROM planning_decisions_legacy_audit WHERE id = ?').get(id) as PlanningDecisionRow | undefined;
    return row ? rowToAuditRecord(row) : null;
  }

  listBySession(sessionId: string): PlanningDecisionAuditRecord[] {
    return (this.db.prepare(`
      SELECT * FROM planning_decisions_legacy_audit WHERE session_id = ? ORDER BY created_at ASC
    `).all(sessionId) as PlanningDecisionRow[]).map(rowToAuditRecord);
  }

  listByTask(taskId: string): PlanningDecisionAuditRecord[] {
    return (this.db.prepare(`
      SELECT * FROM planning_decisions_legacy_audit WHERE task_id = ? ORDER BY created_at ASC
    `).all(taskId) as PlanningDecisionRow[]).map(rowToAuditRecord);
  }

}

function rowToAuditRecord(row: PlanningDecisionRow): PlanningDecisionAuditRecord {
  const plan = safeJson(row.plan_json);
  const decision = safeJson(row.decision_json);
  return {
    id: row.id,
    sessionId: row.session_id,
    requestId: row.request_id,
    taskId: row.task_id,
    userInput: row.user_input,
    plan,
    decision,
    planSchemaVersion: readSchemaVersion(plan),
    decisionPlanSchemaVersion: readSchemaVersion(isRecord(decision) ? decision.plan : null),
    outcome: row.outcome,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function readSchemaVersion(value: unknown): number | null {
  return isRecord(value) && typeof value.schemaVersion === 'number' ? value.schemaVersion : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
