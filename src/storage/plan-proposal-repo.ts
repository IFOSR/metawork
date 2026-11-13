import type Database from 'better-sqlite3';
import { CONVERSATION_DELETION_SCHEMA_SQL, CONVERSATION_TURN_CANCELLATION_SCHEMA_SQL } from './conversation-turn-schema.js';
import type { PlanAdmissionRequest } from '../execution/plan-admission-policy.js';
import { PlanProposalUnavailableError, planAdmissionRequest, proposedTaskId, type PlanProposalRecord, type PlanProposalStore } from '../execution/plan-proposal-store.js';

export function ensurePlanProposalSchema(db: Database.Database): void {
  db.exec(CONVERSATION_DELETION_SCHEMA_SQL);
  db.exec(CONVERSATION_TURN_CANCELLATION_SCHEMA_SQL);
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_plan_proposals (
      proposal_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      replan_request_id TEXT UNIQUE,
      trigger_operation_id TEXT,
      request_json TEXT NOT NULL,
      delivery TEXT NOT NULL DEFAULT 'pending' CHECK(delivery IN ('pending', 'forwarded', 'invalidated')),
      delivery_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS task_plan_proposals_operation
      ON task_plan_proposals(operation_id);
    CREATE INDEX IF NOT EXISTS task_plan_proposals_delivery
      ON task_plan_proposals(delivery, created_at, proposal_id);
    CREATE TABLE IF NOT EXISTS task_plan_origins (
      task_id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL UNIQUE REFERENCES task_plan_proposals(proposal_id)
    );
  `);
}

/** Immutable proposals and a delivery receipt; no Kernel foreign keys or decisions. */
export class PlanProposalRepo implements PlanProposalStore {
  constructor(private readonly db: Database.Database) {
    ensurePlanProposalSchema(db);
  }

  save(input: Parameters<PlanProposalStore['save']>[0]): PlanProposalRecord {
    const request = planAdmissionRequest(input.request);
    if (!request.id || !request.proposal.id || !request.sessionId || !request.configurationRevision
      || !request.generationId || !Number.isSafeInteger(request.targetGraphRevision)
      || request.targetGraphRevision < 1 || !Number.isFinite(Date.parse(request.occurredAt))) {
      throw new Error('invalid plan proposal identity');
    }
    if ((input.triggerOperationId !== undefined
      && (!input.triggerOperationId || request.proposalSource === 'initial'))
      || (input.replanRequestId !== undefined && input.triggerOperationId === undefined)
      || (input.replanRequestId !== undefined
        && (!input.replanRequestId || !input.triggerOperationId || request.proposalSource !== 'replan'
          || !request.taskId || request.targetGraphRevision < 2))) {
      throw new Error('invalid replan proposal origin');
    }
    const expected = {
      request,
      operationId: `admission_${request.proposal.id}`,
      replanRequestId: input.replanRequestId ?? null,
      triggerOperationId: input.triggerOperationId ?? null,
    };
    return this.db.transaction(() => {
      this.assertRequestOpen(request);
      const previous = this.find(request.id)
        ?? (input.replanRequestId ? this.findForReplan(input.replanRequestId) : null)
        ?? (() => {
          const row = this.db.prepare('SELECT * FROM task_plan_proposals WHERE operation_id = ?')
            .get(expected.operationId) as Row | undefined;
          return row ? fromRow(row) : null;
        })();
      if (previous) {
        const { delivery, deliveryReason, ...identity } = previous;
        if (canonical(identity) !== canonical(expected)) throw new Error('plan proposal identity conflict');
        return previous;
      }
      this.db.prepare(`
        INSERT INTO task_plan_proposals (
          proposal_id, operation_id, replan_request_id, trigger_operation_id,
          request_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(request.id, expected.operationId, expected.replanRequestId, expected.triggerOperationId,
        JSON.stringify(request), request.occurredAt, request.occurredAt);
      return this.find(request.id)!;
    }).immediate();
  }

  find(id: string): PlanProposalRecord | null {
    const row = this.db.prepare('SELECT * FROM task_plan_proposals WHERE proposal_id = ?').get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  assertAdmissionOpen(id: string): void {
    const record = this.find(id);
    if (!record) throw new PlanProposalUnavailableError('proposal_missing');
    this.assertRequestOpen(record.request);
    if (record.delivery === 'invalidated') throw new PlanProposalUnavailableError('proposal_invalidated');
  }

  private assertRequestOpen(request: PlanAdmissionRequest): void {
    // The repository belongs to one Account database. Lifecycle facts survive
    // Session reconstruction; transport receipts cannot override them.
    if (this.db.prepare('SELECT 1 FROM conversation_deletions WHERE conversation_id = ?')
      .get(request.conversationId ?? request.sessionId)) throw new PlanProposalUnavailableError('conversation_deleted');
    if (request.sourceTurnId && this.db.prepare(`SELECT 1 FROM conversation_turn_cancellations
      WHERE conversation_id = ? AND turn_id = ?`)
      .get(request.conversationId ?? request.sessionId, request.sourceTurnId)) throw new PlanProposalUnavailableError('turn_cancelled');
  }

  findForReplan(replanRequestId: string): PlanProposalRecord | null {
    const row = this.db.prepare('SELECT * FROM task_plan_proposals WHERE replan_request_id = ?').get(replanRequestId) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  findInitialForTask(taskId: string): PlanProposalRecord | null {
    const row = this.db.prepare(`
      SELECT p.* FROM task_plan_proposals p
      JOIN task_plan_origins o ON o.proposal_id = p.proposal_id
      WHERE o.task_id = ?
    `).get(taskId) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  bindInitialToTask(taskId: string, proposalId: string): void {
    this.db.transaction(() => {
      const record = this.find(proposalId);
      if (record) this.assertAdmissionOpen(proposalId);
      if (!record || record.delivery === 'invalidated' || record.request.proposalSource !== 'initial'
        || record.request.proposal.action !== 'plan_work_graph'
        || record.request.proposal.task.taskId || proposedTaskId(record.request) !== taskId) {
        throw new Error('invalid initial Task proposal binding');
      }
      const previous = this.findInitialForTask(taskId);
      if (previous) {
        if (previous.request.id !== proposalId) throw new Error('initial Task proposal binding conflict');
        return;
      }
      this.db.prepare('INSERT INTO task_plan_origins (task_id, proposal_id) VALUES (?, ?)').run(taskId, proposalId);
    }).immediate();
  }

  listPendingReplans(limit: number): PlanProposalRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid proposal batch limit');
    return (this.db.prepare(`
      SELECT * FROM task_plan_proposals
      WHERE delivery = 'pending' AND replan_request_id IS NOT NULL
      ORDER BY updated_at, proposal_id LIMIT ?
    `).all(limit) as Row[]).map(fromRow);
  }

  recordDeliveryFailure(id: string, now: string): void {
    this.db.prepare(`
      UPDATE task_plan_proposals SET delivery_reason = 'admission_delivery_failed', updated_at = ?
      WHERE proposal_id = ? AND delivery = 'pending'
    `).run(now, id);
  }

  markForwarded(id: string, now: string): boolean {
    return this.db.prepare(`
      UPDATE task_plan_proposals SET delivery = 'forwarded', delivery_reason = NULL, updated_at = ?
      WHERE proposal_id = ? AND delivery = 'pending'
    `).run(now, id).changes === 1;
  }

  invalidate(id: string, reason: string, now: string): boolean {
    return this.db.prepare(`
      UPDATE task_plan_proposals SET delivery = 'invalidated', delivery_reason = ?, updated_at = ?
      WHERE proposal_id = ? AND delivery = 'pending'
    `).run(reason, now, id).changes === 1;
  }
}

interface Row {
  request_json: string;
  operation_id: string;
  replan_request_id: string | null;
  trigger_operation_id: string | null;
  delivery: PlanProposalRecord['delivery'];
  delivery_reason: string | null;
}
function fromRow(row: Row): PlanProposalRecord {
  return {
    request: JSON.parse(row.request_json) as PlanAdmissionRequest,
    operationId: row.operation_id,
    replanRequestId: row.replan_request_id,
    triggerOperationId: row.trigger_operation_id,
    delivery: row.delivery,
    deliveryReason: row.delivery_reason,
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
