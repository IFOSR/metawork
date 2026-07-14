import type Database from 'better-sqlite3';
import type { KernelDecision } from '../kernel/policy-kernel.js';
import type { PlanningAgentPlan } from '../planning/planning-types.js';

export interface PlanningDecisionRecord {
  id: string;
  sessionId: string;
  requestId: string;
  taskId: string | null;
  userInput: string;
  plan: PlanningAgentPlan;
  decision: KernelDecision;
  outcome: KernelDecision['outcome'];
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
  outcome: KernelDecision['outcome'];
  reason: string;
  created_at: string;
}

export class PlanningDecisionRepo {
  constructor(private readonly db: Database.Database) {}

  insert(record: PlanningDecisionRecord): void {
    this.db.prepare(`
      INSERT INTO planning_decisions (
        id, session_id, request_id, task_id, user_input, plan_json,
        decision_json, outcome, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.sessionId,
      record.requestId,
      record.taskId,
      record.userInput,
      JSON.stringify(record.plan),
      JSON.stringify(record.decision),
      record.outcome,
      record.reason,
      record.createdAt,
    );
  }

  findById(id: string): PlanningDecisionRecord | null {
    const row = this.db.prepare('SELECT * FROM planning_decisions WHERE id = ?').get(id) as PlanningDecisionRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  listBySession(sessionId: string): PlanningDecisionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM planning_decisions
      WHERE session_id = ?
      ORDER BY created_at ASC
    `).all(sessionId) as PlanningDecisionRow[];
    return rows.map(rowToRecord);
  }

  listByTask(taskId: string): PlanningDecisionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM planning_decisions
      WHERE task_id = ?
      ORDER BY created_at ASC
    `).all(taskId) as PlanningDecisionRow[];
    return rows.map(rowToRecord);
  }

  bindTask(id: string, taskId: string): void {
    this.db.prepare(`
      UPDATE planning_decisions
      SET task_id = ?
      WHERE id = ? AND task_id IS NULL
    `).run(taskId, id);
  }
}

function rowToRecord(row: PlanningDecisionRow): PlanningDecisionRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    requestId: row.request_id,
    taskId: row.task_id,
    userInput: row.user_input,
    plan: JSON.parse(row.plan_json) as PlanningAgentPlan,
    decision: JSON.parse(row.decision_json) as KernelDecision,
    outcome: row.outcome,
    reason: row.reason,
    createdAt: row.created_at,
  };
}
