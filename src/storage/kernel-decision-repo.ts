import type Database from 'better-sqlite3';
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import type { KernelDecision, KernelEvent, KernelSnapshot } from '../kernel/control-kernel.js';
import type { KernelDecisionLedgerRecord } from '../kernel/kernel-workflow.js';
export type { KernelDecisionLedgerRecord } from '../kernel/kernel-workflow.js';

export type RevisionedKernelDecisionLedgerRecord = KernelDecisionLedgerRecord & {
  configurationRevision: string;
  authorizedBindings: AuthorizedExecutorBinding[];
  bindingFingerprints: string[];
};

export interface KernelDecisionTimelineRecord {
  action: KernelDecision['action']['type'];
  taskId: string | null;
  subtaskId: string | null;
  reason: string;
}

export interface KernelPlanPresentationIdentity {
  taskId: string;
  graphRevision: number;
  subtaskIds: string[];
}

interface KernelDecisionRow {
  id: string;
  schema_version: number;
  event_id: string;
  event_type: KernelEvent['type'];
  correlation_id: string;
  causation_id: string | null;
  session_id: string;
  task_id: string | null;
  subtask_id: string | null;
  attempt_id: string | null;
  event_json: string;
  snapshot_json: string;
  decision_json: string;
  action: KernelDecision['action']['type'];
  reason: string;
  configuration_revision: string;
  authorized_bindings_json: string;
  binding_fingerprints_json: string;
  created_at: string;
}

/** Storage Adapter for ledger-first Kernel decision issuance. */
export class KernelDecisionRepo {
  constructor(private readonly db: Database.Database) {}

  insertIfAbsent(record: RevisionedKernelDecisionLedgerRecord): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO kernel_decisions (
        id, schema_version, event_id, event_type, correlation_id, causation_id,
        session_id, task_id, subtask_id, attempt_id, event_json, snapshot_json,
        decision_json, action, reason, configuration_revision,
        authorized_bindings_json, binding_fingerprints_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.schemaVersion, record.eventId, record.eventType,
      record.correlationId, record.causationId, record.sessionId, record.taskId,
      record.subtaskId, record.attemptId, JSON.stringify(record.event),
      JSON.stringify(record.snapshot), JSON.stringify(record.decision), record.action,
      record.reason, record.configurationRevision, JSON.stringify(record.authorizedBindings),
      JSON.stringify(record.bindingFingerprints), record.createdAt,
    );
    if (result.changes === 0) {
      const existing = this.findByEventId(record.eventId);
      if (
        !existing
        || existing.configurationRevision !== record.configurationRevision
        || !sameBindings(existing.authorizedBindings, record.authorizedBindings)
        || !sameStrings(existing.bindingFingerprints, record.bindingFingerprints)
      ) {
        throw new Error(`persisted Kernel decision binding mismatch: ${record.eventId}`);
      }
    }
    return result.changes === 1;
  }

  issue(record: RevisionedKernelDecisionLedgerRecord): boolean {
    return this.insertIfAbsent(record);
  }

  findByEventId(eventId: string): RevisionedKernelDecisionLedgerRecord | null {
    const row = this.db.prepare('SELECT * FROM kernel_decisions WHERE event_id = ?').get(eventId) as KernelDecisionRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  findById(decisionId: string): RevisionedKernelDecisionLedgerRecord | null {
    const row = this.db.prepare('SELECT * FROM kernel_decisions WHERE id = ?')
      .get(decisionId) as KernelDecisionRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  listBySession(sessionId: string): RevisionedKernelDecisionLedgerRecord[] {
    return (this.db.prepare(`
      SELECT * FROM kernel_decisions WHERE session_id = ? ORDER BY created_at ASC, id ASC
    `).all(sessionId) as KernelDecisionRow[]).map(rowToRecord);
  }

  listByCorrelation(correlationId: string): RevisionedKernelDecisionLedgerRecord[] {
    return (this.db.prepare(`
      SELECT * FROM kernel_decisions WHERE correlation_id = ? ORDER BY created_at ASC, id ASC
    `).all(correlationId) as KernelDecisionRow[]).map(rowToRecord);
  }

  listByTask(taskId: string): RevisionedKernelDecisionLedgerRecord[] {
    return (this.db.prepare(`
      SELECT * FROM kernel_decisions WHERE task_id = ? ORDER BY created_at ASC, id ASC
    `).all(taskId) as KernelDecisionRow[]).map(rowToRecord);
  }

  /**
   * Public timeline projection only needs bounded display columns. Avoid
   * reading and parsing the large event/snapshot/decision JSON ledger bodies.
   */
  listTimelineByTask(taskId: string, limit: number): KernelDecisionTimelineRecord[] {
    const boundedLimit = Math.max(1, Math.floor(limit));
    return this.db.prepare(`
      SELECT action, task_id, subtask_id, reason
      FROM (
        SELECT action, task_id, subtask_id, reason, created_at, id
        FROM kernel_decisions
        WHERE task_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      )
      ORDER BY created_at ASC, id ASC
    `).all(taskId, boundedLimit).map(row => {
      const value = row as Pick<
        KernelDecisionRow,
        'action' | 'task_id' | 'subtask_id' | 'reason'
      >;
      return {
        action: value.action,
        taskId: value.task_id,
        subtaskId: value.subtask_id,
        reason: value.reason,
      };
    });
  }

  listTimelineByTasks(taskIds: readonly string[], limit: number): KernelDecisionTimelineRecord[] {
    if (!taskIds.length) return [];
    if (taskIds.length > 100 || !Number.isSafeInteger(limit) || limit < 1) throw new Error('timeline_task_limit');
    return this.db.prepare(`
      SELECT action, task_id AS taskId, subtask_id AS subtaskId, reason FROM (
        SELECT action, task_id, subtask_id, reason, created_at, id,
          row_number() OVER (PARTITION BY task_id ORDER BY created_at DESC, id DESC) AS position
        FROM kernel_decisions WHERE task_id IN (${taskIds.map(() => '?').join(',')})
      ) WHERE position <= ? ORDER BY created_at ASC, id ASC
    `).all(...taskIds, Math.min(limit, 200)) as KernelDecisionTimelineRecord[];
  }

  listPresentationIdentitiesByTasks(taskIds: readonly string[]): KernelPlanPresentationIdentity[] {
    if (!taskIds.length) return [];
    if (taskIds.length > 100) throw new Error('presentation_task_limit');
    const rows = this.db.prepare(`
      SELECT task_id, schema_version, json_extract(decision_json, '$.schemaVersion') AS decision_schema,
        json_extract(decision_json, '$.action.graphRevision') AS graph_revision,
        (SELECT json_group_array(json_extract(value, '$.id'))
          FROM json_each(decision_json, '$.action.workGraph.subtasks')) AS subtask_ids_json
      FROM (
        SELECT task_id, schema_version, decision_json,
          row_number() OVER (PARTITION BY task_id ORDER BY created_at DESC, id DESC) AS position
        FROM kernel_decisions
        WHERE action = 'authorize_task_plan' AND task_id IN (${taskIds.map(() => '?').join(',')})
      ) WHERE position = 1
    `).all(...taskIds) as {
      task_id: string; schema_version: number; decision_schema: number;
      graph_revision: number; subtask_ids_json: string;
    }[];
    return rows.map(row => {
      assertCurrentSchema(row.schema_version, 'decision');
      assertCurrentSchema(row.decision_schema, 'decision');
      const subtaskIds: unknown = JSON.parse(row.subtask_ids_json);
      if (!Number.isSafeInteger(row.graph_revision) || row.graph_revision < 0
        || !Array.isArray(subtaskIds) || !subtaskIds.every(id => typeof id === 'string')) {
        throw new Error('invalid_plan_presentation_identity');
      }
      return { taskId: row.task_id, graphRevision: row.graph_revision, subtaskIds };
    });
  }

  listCurrentByAction(action: KernelDecision['action']['type']): RevisionedKernelDecisionLedgerRecord[] {
    return (this.db.prepare(`
      SELECT decision.*
      FROM kernel_decisions decision
      WHERE decision.action = ?
        AND decision.task_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM kernel_decisions later
          WHERE later.task_id = decision.task_id
            AND later.action NOT IN ('no_op', 'probe_capacity')
            AND (later.created_at > decision.created_at
              OR (later.created_at = decision.created_at AND later.id > decision.id))
        )
      ORDER BY decision.created_at ASC, decision.id ASC
    `).all(action) as KernelDecisionRow[]).map(rowToRecord);
  }

  /** Read-model identities only; never deserialize immutable control payloads. */
  listCurrentTaskIdsByAction(action: KernelDecision['action']['type'], taskIds: readonly string[]): string[] {
    if (taskIds.length === 0) return [];
    const statement = this.db.prepare(`
      SELECT decision.task_id
      FROM kernel_decisions decision
      WHERE decision.task_id = ? AND decision.action = ?
        AND NOT EXISTS (
          SELECT 1 FROM kernel_decisions later
          WHERE later.task_id = decision.task_id
            AND later.action NOT IN ('no_op', 'probe_capacity')
            AND (later.created_at > decision.created_at
              OR (later.created_at = decision.created_at AND later.id > decision.id))
        )
      LIMIT 1
    `);
    return [...new Set(taskIds)].filter(taskId => statement.get(taskId, action) !== undefined);
  }
}

function rowToRecord(row: KernelDecisionRow): RevisionedKernelDecisionLedgerRecord {
  assertCurrentSchema(row.schema_version, 'decision');
  const event = parseCurrentKernelValue<KernelEvent>(row.event_json, 'event');
  const snapshot = parseCurrentKernelValue<KernelSnapshot>(row.snapshot_json, 'snapshot');
  const decision = parseCurrentKernelValue<KernelDecision>(row.decision_json, 'decision');
  return {
    id: row.id,
    schemaVersion: 5,
    eventId: row.event_id,
    eventType: row.event_type,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    sessionId: row.session_id,
    taskId: row.task_id,
    subtaskId: row.subtask_id,
    attemptId: row.attempt_id,
    event,
    snapshot,
    decision,
    action: row.action,
    reason: row.reason,
    configurationRevision: row.configuration_revision,
    authorizedBindings: JSON.parse(row.authorized_bindings_json) as AuthorizedExecutorBinding[],
    bindingFingerprints: JSON.parse(row.binding_fingerprints_json) as string[],
    createdAt: row.created_at,
  };
}

function assertCurrentSchema(schemaVersion: number, kind: string): asserts schemaVersion is 5 {
  if (schemaVersion !== 5) {
    throw new Error(`unsupported Kernel ${kind} schema version ${schemaVersion}`);
  }
}

function parseCurrentKernelValue<T extends { schemaVersion: 5 }>(
  raw: string,
  kind: string,
): T {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== 'object'
    || value === null
    || !('schemaVersion' in value)
    || value.schemaVersion !== 5
  ) {
    const version = typeof value === 'object' && value !== null && 'schemaVersion' in value
      ? String(value.schemaVersion)
      : 'missing';
    throw new Error(`unsupported Kernel ${kind} schema version ${version}`);
  }
  return value as T;
}

function sameBindings(
  left: AuthorizedExecutorBinding[],
  right: AuthorizedExecutorBinding[],
): boolean {
  return left.length === right.length && left.every((binding, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && binding.agentClassRef === candidate.agentClassRef
      && binding.harnessRef === candidate.harnessRef
      && binding.providerRef === candidate.providerRef
      && binding.modelRef === candidate.modelRef
      && binding.permissionProfileRef === candidate.permissionProfileRef
      && binding.configurationRevision === candidate.configurationRevision;
  });
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}
