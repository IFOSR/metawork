import type Database from 'better-sqlite3';
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import type { KernelEvent } from '../kernel/control-kernel.js';

export type GenerationReplanRequestStatus =
  | 'pending_quiescence'
  | 'planning'
  | 'submitted'
  | 'waiting_for_availability'
  | 'resolved'
  | 'cancelled'
  | 'failed';

export interface GenerationReplanRequestRecord {
  id: string;
  taskId: string;
  generationId: string;
  sourceRevision: number;
  configurationRevision: string;
  status: GenerationReplanRequestStatus;
  triggerDecisionId: string;
  quiescenceToken: string | null;
  errorSummary: string | null;
  deferredPlan: Extract<KernelEvent, { type: 'plan_proposed' }> | null;
  deferredBindings: AuthorizedExecutorBinding[];
  availabilityExplanation: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ReplanRow {
  id: string;
  task_id: string;
  generation_id: string;
  source_revision: number;
  configuration_revision: string;
  status: GenerationReplanRequestStatus;
  trigger_decision_id: string;
  quiescence_token: string | null;
  error_summary: string | null;
  deferred_plan_json: string | null;
  deferred_bindings_json: string;
  availability_explanation: string | null;
  created_at: string;
  updated_at: string;
}

export class GenerationReplanRequestRepo {
  constructor(private readonly db: Database.Database) {}

  enqueue(input: {
    id: string;
    taskId: string;
    generationId: string;
    sourceRevision: number;
    configurationRevision: string;
    triggerDecisionId: string;
    now: string;
  }): GenerationReplanRequestRecord {
    this.db.prepare(`
      INSERT OR IGNORE INTO generation_replan_requests (
        id, task_id, generation_id, source_revision, status,
        trigger_decision_id, configuration_revision, deferred_bindings_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending_quiescence', ?, ?, '[]', ?, ?)
    `).run(
      input.id,
      input.taskId,
      input.generationId,
      input.sourceRevision,
      input.triggerDecisionId,
      input.configurationRevision,
      input.now,
      input.now,
    );
    const record = this.findByGeneration(
      input.taskId,
      input.generationId,
      input.sourceRevision,
    );
    if (!record) throw new Error(`generation replan request was not persisted: ${input.id}`);
    if (record.configurationRevision !== input.configurationRevision) {
      throw new Error(`persisted replan revision mismatch: ${record.id}`);
    }
    return record;
  }

  find(id: string): GenerationReplanRequestRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM generation_replan_requests WHERE id = ?
    `).get(id) as ReplanRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  findByGeneration(
    taskId: string,
    generationId: string,
    sourceRevision: number,
  ): GenerationReplanRequestRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM generation_replan_requests
      WHERE task_id = ? AND generation_id = ? AND source_revision = ?
    `).get(taskId, generationId, sourceRevision) as ReplanRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  findActive(taskId: string, generationId: string): GenerationReplanRequestRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM generation_replan_requests
      WHERE task_id = ? AND generation_id = ?
        AND status IN ('pending_quiescence', 'planning', 'submitted', 'waiting_for_availability')
      ORDER BY source_revision DESC
      LIMIT 1
    `).get(taskId, generationId) as ReplanRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  markPlanning(id: string, quiescenceToken: string, now: string): boolean {
    const changed = this.db.prepare(`
      UPDATE generation_replan_requests
      SET status = 'planning', quiescence_token = ?,
          planning_started_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending_quiescence'
    `).run(quiescenceToken, now, now, id).changes;
    if (changed === 1) return true;
    const current = this.find(id);
    return current?.status === 'planning'
      && current.quiescenceToken === quiescenceToken;
  }

  markSubmitted(id: string, quiescenceToken: string, now: string): boolean {
    return this.db.prepare(`
      UPDATE generation_replan_requests
      SET status = 'submitted', submitted_at = ?, updated_at = ?
      WHERE id = ? AND status = 'planning' AND quiescence_token = ?
    `).run(now, now, id, quiescenceToken).changes === 1;
  }

  deferForAvailability(
    id: string,
    event: Extract<KernelEvent, { type: 'plan_proposed' }>,
    explanation: string,
    deferredBindings: AuthorizedExecutorBinding[],
    now: string,
  ): boolean {
    const request = this.find(id);
    if (!request) {
      throw new Error(`generation replan request does not exist: ${id}`);
    }
    if (deferredBindings.some(
      binding => binding.configurationRevision !== request.configurationRevision,
    )) {
      throw new Error(`deferred binding revision mismatch for replan ${id}`);
    }
    return this.db.prepare(`
      UPDATE generation_replan_requests
      SET status = 'waiting_for_availability',
          deferred_plan_json = ?,
          deferred_bindings_json = ?,
          availability_explanation = ?,
          updated_at = ?
      WHERE id = ? AND status IN ('planning', 'submitted')
    `).run(
      JSON.stringify(event),
      JSON.stringify(deferredBindings),
      explanation,
      now,
      id,
    ).changes === 1;
  }

  listWaitingForAvailability(): GenerationReplanRequestRecord[] {
    return (this.db.prepare(`
      SELECT * FROM generation_replan_requests
      WHERE status = 'waiting_for_availability'
      ORDER BY created_at
    `).all() as ReplanRow[]).map(rowToRecord);
  }

  submitPlan(
    id: string,
    quiescenceToken: string,
    event: KernelEvent,
    now: string,
  ): boolean {
    return this.db.transaction(() => {
      const current = this.find(id);
      if (
        current?.status === 'submitted'
        && current.quiescenceToken === quiescenceToken
      ) {
        return Boolean(this.db.prepare(
          'SELECT 1 FROM kernel_events WHERE id = ?',
        ).get(event.id));
      }
      if (
        current?.status !== 'planning'
        || current.quiescenceToken !== quiescenceToken
      ) {
        return false;
      }
      this.db.prepare(`
        INSERT OR IGNORE INTO kernel_events (
          id, schema_version, event_type, correlation_id, causation_id,
          session_id, task_id, subtask_id, attempt_id, event_json,
          available_at, status, processing_started_at, processed_at,
          last_error, configuration_revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?, ?)
      `).run(
        event.id,
        event.schemaVersion,
        event.type,
        event.correlationId,
        event.causationId,
        event.sessionId,
        event.taskId ?? null,
        event.subtaskId ?? null,
        event.attemptId ?? null,
        JSON.stringify(event),
        event.occurredAt,
        current.configurationRevision,
        event.occurredAt,
        event.occurredAt,
      );
      return this.db.prepare(`
        UPDATE generation_replan_requests
        SET status = 'submitted', submitted_at = ?, updated_at = ?
        WHERE id = ? AND status = 'planning' AND quiescence_token = ?
      `).run(now, now, id, quiescenceToken).changes === 1;
    })();
  }

  resolve(id: string, now: string): void {
    this.db.prepare(`
      UPDATE generation_replan_requests
      SET status = 'resolved', resolved_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('planning', 'submitted', 'waiting_for_availability')
    `).run(now, now, id);
  }

  cancelTask(taskId: string, decisionId: string, now: string): number {
    return this.db.prepare(`
      UPDATE generation_replan_requests
      SET status = 'cancelled', cancelled_at = ?, updated_at = ?,
          error_summary = ?
      WHERE task_id = ?
        AND status IN ('pending_quiescence', 'planning', 'submitted', 'waiting_for_availability')
    `).run(now, now, `cancelled by ${decisionId}`, taskId).changes;
  }

  fail(id: string, errorSummary: string, now: string): void {
    this.db.prepare(`
      UPDATE generation_replan_requests
      SET status = 'failed', error_summary = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending_quiescence', 'planning')
    `).run(errorSummary, now, id);
  }
}

function rowToRecord(row: ReplanRow): GenerationReplanRequestRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    generationId: row.generation_id,
    sourceRevision: row.source_revision,
    configurationRevision: row.configuration_revision,
    status: row.status,
    triggerDecisionId: row.trigger_decision_id,
    quiescenceToken: row.quiescence_token,
    errorSummary: row.error_summary,
    deferredPlan: row.deferred_plan_json
      ? JSON.parse(row.deferred_plan_json) as Extract<KernelEvent, { type: 'plan_proposed' }>
      : null,
    deferredBindings: JSON.parse(row.deferred_bindings_json) as AuthorizedExecutorBinding[],
    availabilityExplanation: row.availability_explanation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
