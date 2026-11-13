import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ensurePermissionResolutionSchema, ensurePermissionWorkSchema } from './permission-schema.js';
import type {
  CapabilityGrant,
  NormalizedCapabilityRequest,
  PartitionIdentity,
  PermissionRepositoryPort,
  PermissionRequestRecord,
  PermissionRequestStatus,
  PermissionResolutionRecord,
  UserAuthorizationRecord,
} from '../resource/index.js';
import { partitionCanonicalKey } from '../resource/index.js';

interface PermissionRequestRow {
  id: string;
  fingerprint: string;
  task_id: string;
  generation_id: string;
  subtask_id: string;
  attempt_id: string;
  agent_class_name: string;
  permission_profile_id: NormalizedCapabilityRequest['permissionProfileId'];
  capability: NormalizedCapabilityRequest['capability'];
  resource_text: string;
  partition_json: string;
  operation: string;
  reason: string;
  suggested_scope: NormalizedCapabilityRequest['suggestedScope'];
  distinct_request_ordinal: number;
  status: PermissionRequestStatus;
  decision_id: string | null;
  decision_reason: string | null;
  created_at: string;
  resolved_at: string | null;
}

interface PermissionGrantRow {
  id: string;
  request_id: string;
  fingerprint: string;
  task_id: string;
  subtask_id: string;
  attempt_id: string;
  capability: CapabilityGrant['capability'];
  partition_json: string;
  operation: string;
  grant_scope: CapabilityGrant['scope'];
  expires_at: string;
  max_calls: number;
  max_bytes: number;
  calls_used: number;
  bytes_used: number;
  revoked_at: string | null;
}

interface PermissionResolutionRow {
  request_id: string;
  event_id: string;
  session_id: string;
  task_id: string;
  subtask_id: string;
  attempt_id: string;
  resolution: PermissionResolutionRecord['resolution'];
  source: PermissionResolutionRecord['source'];
  planner_plan_id: string | null;
  created_at: string;
}

function requestFromRow(row: PermissionRequestRow): PermissionRequestRecord {
  return {
    request: {
      id: row.id,
      fingerprint: row.fingerprint,
      taskId: row.task_id,
      generationId: row.generation_id,
      subtaskId: row.subtask_id,
      attemptId: row.attempt_id,
      agentClassName: row.agent_class_name,
      permissionProfileId: row.permission_profile_id,
      capability: row.capability,
      resource: row.resource_text,
      partition: JSON.parse(row.partition_json) as PartitionIdentity,
      operation: row.operation,
      reason: row.reason,
      suggestedScope: row.suggested_scope,
      distinctRequestOrdinal: row.distinct_request_ordinal,
    },
    status: row.status,
    decisionId: row.decision_id,
    decisionReason: row.decision_reason,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function grantFromRow(row: PermissionGrantRow): CapabilityGrant {
  return {
    id: row.id,
    requestId: row.request_id,
    fingerprint: row.fingerprint,
    taskId: row.task_id,
    subtaskId: row.subtask_id,
    attemptId: row.attempt_id,
    capability: row.capability,
    partition: JSON.parse(row.partition_json) as PartitionIdentity,
    operation: row.operation,
    scope: row.grant_scope,
    limits: { expiresAt: row.expires_at, maxCalls: row.max_calls, maxBytes: row.max_bytes },
    callsUsed: row.calls_used,
    bytesUsed: row.bytes_used,
    revokedAt: row.revoked_at,
  };
}

function resolutionFromRow(row: PermissionResolutionRow): PermissionResolutionRecord {
  return {
    requestId: row.request_id,
    eventId: row.event_id,
    sessionId: row.session_id,
    taskId: row.task_id,
    subtaskId: row.subtask_id,
    attemptId: row.attempt_id,
    resolution: row.resolution,
    source: row.source,
    plannerPlanId: row.planner_plan_id,
    createdAt: row.created_at,
  };
}

function sameResolution(left: PermissionResolutionRecord, right: PermissionResolutionRecord): boolean {
  return left.requestId === right.requestId
    && left.eventId === right.eventId
    && left.sessionId === right.sessionId
    && left.taskId === right.taskId
    && left.subtaskId === right.subtaskId
    && left.attemptId === right.attemptId
    && left.resolution === right.resolution
    && left.source === right.source
    && left.plannerPlanId === right.plannerPlanId;
}

export class SqlitePermissionRepository implements PermissionRepositoryPort {
  constructor(private readonly db: Database.Database) {
    // Keep this constructor tolerant of focused repository fixtures while the
    // application migration boundary remains the authoritative repair point.
    ensurePermissionResolutionSchema(this.db);
    ensurePermissionWorkSchema(this.db);
  }

  enqueuePermissionWork(input: {
    eventId: string;
    requestId: string;
    eventType: 'permission_requested' | 'permission_resolution_received';
    createdAt: string;
  }): void {
    this.db.prepare(`
      INSERT INTO permission_work_items (
        event_id, request_id, event_type, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(event_id) DO NOTHING
    `).run(input.eventId, input.requestId, input.eventType, input.createdAt, input.createdAt);
  }

  claimPermissionWork(eventId: string, now: string): boolean {
    return this.db.prepare(`
      UPDATE permission_work_items
      SET status = 'processing', processing_started_at = ?, updated_at = ?
      WHERE event_id = ? AND status = 'pending'
    `).run(now, now, eventId).changes === 1;
  }

  releasePermissionWork(eventId: string, now: string): void {
    this.db.prepare(`
      UPDATE permission_work_items
      SET status = 'pending', processing_started_at = NULL, updated_at = ?
      WHERE event_id = ? AND status = 'processing'
    `).run(now, eventId);
  }

  markPermissionWorkApplied(eventId: string, now: string): void {
    this.db.prepare(`
      UPDATE permission_work_items
      SET status = 'processed', processed_at = ?, processing_started_at = NULL, updated_at = ?
      WHERE event_id = ? AND status IN ('pending', 'processing')
    `).run(now, now, eventId);
  }

  reconcilePermissionWork(now: string): number {
    return this.db.prepare(`
      UPDATE permission_work_items
      SET status = 'pending', processing_started_at = NULL, updated_at = ?
      WHERE status = 'processing'
    `).run(now).changes;
  }

  listPermissionWork(limit = 32): Array<{
    eventId: string;
    requestId: string;
    eventType: 'permission_requested' | 'permission_resolution_received';
    status: 'pending' | 'processing';
  }> {
    return this.db.prepare(`
      SELECT event_id AS eventId, request_id AS requestId, event_type AS eventType, status
      FROM permission_work_items
      WHERE status = 'pending'
      ORDER BY created_at, event_id
      LIMIT ?
    `).all(Math.max(1, Math.min(128, limit))) as Array<{
      eventId: string;
      requestId: string;
      eventType: 'permission_requested' | 'permission_resolution_received';
      status: 'pending' | 'processing';
    }>;
  }

  findResolution(requestId: string): PermissionResolutionRecord | null {
    const row = this.db.prepare('SELECT * FROM permission_resolutions WHERE request_id = ?')
      .get(requestId) as PermissionResolutionRow | undefined;
    return row ? resolutionFromRow(row) : null;
  }

  recordResolution(record: PermissionResolutionRecord): 'inserted' | 'replayed' | 'conflict' {
    const existing = this.findResolution(record.requestId);
    if (existing) return sameResolution(existing, record) ? 'replayed' : 'conflict';
    try {
      this.db.prepare(`
        INSERT INTO permission_resolutions (
          request_id, event_id, session_id, task_id, subtask_id, attempt_id,
          resolution, source, planner_plan_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.requestId, record.eventId, record.sessionId, record.taskId,
        record.subtaskId, record.attemptId, record.resolution, record.source,
        record.plannerPlanId, record.createdAt,
      );
      return 'inserted';
    } catch (error) {
      const replay = this.findResolution(record.requestId);
      if (replay) return sameResolution(replay, record) ? 'replayed' : 'conflict';
      throw error;
    }
  }

  ensureDecisionAnchor(
    _decisionId: string,
    _configurationRevision: string,
    _request: NormalizedCapabilityRequest,
  ): void {
    // ADR-0055 D6 removed the ledger anchor: permission grants are owned by the
    // Permission Service and no longer reference a Kernel decision row.
  }

  createRequest(request: NormalizedCapabilityRequest, createdAt: string): PermissionRequestRecord {
    this.db.prepare(`
      INSERT INTO permission_requests (
        id, fingerprint, task_id, generation_id, subtask_id, attempt_id,
        agent_class_name, permission_profile_id, capability, resource_text,
        partition_key, partition_json, operation, reason, suggested_scope,
        distinct_request_ordinal, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      ON CONFLICT(attempt_id, fingerprint) DO NOTHING
    `).run(
      request.id, request.fingerprint, request.taskId, request.generationId,
      request.subtaskId, request.attemptId, request.agentClassName,
      request.permissionProfileId, request.capability, request.resource,
      partitionCanonicalKey(request.partition), JSON.stringify(request.partition), request.operation, request.reason,
      request.suggestedScope, request.distinctRequestOrdinal, createdAt,
    );
    const row = this.db.prepare(`
      SELECT * FROM permission_requests WHERE attempt_id = ? AND fingerprint = ?
    `).get(request.attemptId, request.fingerprint) as PermissionRequestRow;
    return requestFromRow(row);
  }

  findRequest(requestId: string): PermissionRequestRecord | null {
    const row = this.db.prepare('SELECT * FROM permission_requests WHERE id = ?').get(requestId) as PermissionRequestRow | undefined;
    return row ? requestFromRow(row) : null;
  }

  findPendingForTask(taskId: string): PermissionRequestRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM permission_requests WHERE task_id = ? AND status IN ('pending', 'escalated')
      ORDER BY created_at, id LIMIT 1
    `).get(taskId) as PermissionRequestRow | undefined;
    return row ? requestFromRow(row) : null;
  }

  listEscalatedForTask(taskId: string, afterId = '', limit = 33): PermissionRequestRecord[] {
    return (this.db.prepare(`SELECT * FROM permission_requests request
      WHERE task_id = ? AND status = 'escalated' AND id > ?
        AND NOT EXISTS (SELECT 1 FROM permission_resolutions accepted
          WHERE accepted.request_id = request.id)
      ORDER BY id LIMIT ?`).all(taskId, afterId, Math.max(1, Math.min(33, limit))) as PermissionRequestRow[]).map(requestFromRow);
  }

  findOldestPendingForConversation(conversationId: string): PermissionRequestRecord | null {
    const row = this.db.prepare(`
      SELECT permission_requests.*
      FROM permission_requests
      INNER JOIN tasks ON tasks.id = permission_requests.task_id
      WHERE tasks.conversation_id = ?
        AND permission_requests.status IN ('pending', 'escalated')
      ORDER BY permission_requests.created_at, permission_requests.id
      LIMIT 1
    `).get(conversationId) as PermissionRequestRow | undefined;
    return row ? requestFromRow(row) : null;
  }

  findOldestPending(): PermissionRequestRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM permission_requests WHERE status IN ('pending', 'escalated')
      ORDER BY created_at, id LIMIT 1
    `).get() as PermissionRequestRow | undefined;
    return row ? requestFromRow(row) : null;
  }

  listEscalated(): PermissionRequestRecord[] {
    return (this.db.prepare(`
      SELECT * FROM permission_requests WHERE status = 'escalated'
      ORDER BY created_at ASC, id ASC
    `).all() as PermissionRequestRow[]).map(requestFromRow);
  }

  listEscalatedForSession(sessionId: string, afterId: string, limit: number, createdAfter: string): PermissionRequestRecord[] {
    return (this.db.prepare(`SELECT request.* FROM permission_requests request
      JOIN tasks owner_task ON owner_task.id = request.task_id
      WHERE owner_task.owner_planner_session_id = ?
        AND request.status = 'escalated'
        AND request.id > ? AND request.created_at >= ?
        AND NOT EXISTS (SELECT 1 FROM permission_resolutions accepted
          WHERE accepted.request_id = request.id)
      ORDER BY request.id LIMIT ?`).all(sessionId, afterId, createdAfter, Math.max(1, Math.min(33, limit))) as PermissionRequestRow[]).map(requestFromRow);
  }

  countDistinctForAttempt(attemptId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS count FROM permission_requests WHERE attempt_id = ?')
      .get(attemptId) as { count: number }).count;
  }

  listGrants(attemptId: string): CapabilityGrant[] {
    return (this.db.prepare('SELECT * FROM permission_grants WHERE attempt_id = ? ORDER BY created_at, id')
      .all(attemptId) as PermissionGrantRow[]).map(grantFromRow);
  }

  listDeniedFingerprints(attemptId: string): string[] {
    return (this.db.prepare(`
      SELECT DISTINCT fingerprint FROM permission_requests WHERE attempt_id = ? AND status = 'denied'
    `).all(attemptId) as Array<{ fingerprint: string }>).map(row => row.fingerprint);
  }

  listApprovedFingerprints(taskId: string): string[] {
    return (this.db.prepare(`
      SELECT DISTINCT fingerprint FROM user_authorizations WHERE task_id = ? AND resolution = 'approve'
    `).all(taskId) as Array<{ fingerprint: string }>).map(row => row.fingerprint);
  }

  consumeGrant(grantId: string, attemptId: string, bytes: number, at: string): CapabilityGrant | null {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('grant byte usage must be a non-negative safe integer');
    const transaction = this.db.transaction(() => {
      const changed = this.db.prepare(`
        UPDATE permission_grants
        SET calls_used = calls_used + 1, bytes_used = bytes_used + ?
        WHERE id = ? AND attempt_id = ? AND revoked_at IS NULL AND expires_at > ?
          AND calls_used < max_calls AND bytes_used + ? <= max_bytes
      `).run(bytes, grantId, attemptId, at, bytes).changes;
      if (changed !== 1) return null;
      return grantFromRow(this.db.prepare('SELECT * FROM permission_grants WHERE id = ?').get(grantId) as PermissionGrantRow);
    });
    return transaction.immediate();
  }

  grant(input: Parameters<PermissionRepositoryPort['grant']>[0]): CapabilityGrant {
    const transaction = this.db.transaction(() => {
      const current = this.requireMatchingRequest(input.request);
      if (current.status === 'granted') {
        const grant = this.db.prepare('SELECT * FROM permission_grants WHERE request_id = ?')
          .get(input.request.id) as PermissionGrantRow | undefined;
        if (!grant) throw new Error('permission_grant_missing');
        return grantFromRow(grant);
      }
      if (!['pending', 'escalated'].includes(current.status)
        || (current.status === 'escalated' && input.authorization?.resolution !== 'approve')) {
        throw new Error('permission_decision_conflict');
      }
      const scope = input.scope ?? input.request.suggestedScope;
      if (scope !== input.request.suggestedScope && !(scope === 'once' && input.request.suggestedScope === 'attempt')) {
        throw new Error('permission_scope_expansion');
      }
      if (scope === 'once' && input.limits.maxCalls !== 1) throw new Error('permission_scope_expansion');
      this.insertAuthorization(input.request, input.authorization, input.grantedAt);
      const id = `permission_grant_${randomUUID()}`;
      this.db.prepare(`
        INSERT INTO permission_grants (
          id, request_id, fingerprint, decision_id, task_id, subtask_id,
          attempt_id, capability, partition_key, partition_json, operation,
          grant_scope, expires_at, max_calls, calls_used, max_bytes, bytes_used,
          revoked_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, NULL, ?)
        ON CONFLICT(request_id) DO NOTHING
      `).run(
        id, input.request.id, input.request.fingerprint, input.decisionId,
        input.request.taskId, input.request.subtaskId, input.request.attemptId,
        input.request.capability, partitionCanonicalKey(input.request.partition), JSON.stringify(input.request.partition),
        input.request.operation, scope, input.limits.expiresAt,
        input.limits.maxCalls, input.limits.maxBytes, input.grantedAt,
      );
      this.db.prepare(`
        UPDATE permission_requests SET status = 'granted', decision_id = ?,
          decision_reason = ?, resolved_at = ? WHERE id = ?
      `).run(input.decisionId, input.reason ?? 'granted', input.grantedAt, input.request.id);
      return grantFromRow(this.db.prepare('SELECT * FROM permission_grants WHERE request_id = ?')
        .get(input.request.id) as PermissionGrantRow);
    });
    return transaction.immediate();
  }

  deny(input: Parameters<PermissionRepositoryPort['deny']>[0]): void {
    const transaction = this.db.transaction(() => {
      const current = this.requireMatchingRequest(input.request);
      if (current.status === 'denied') return;
      if (current.status === 'granted') throw new Error('permission_decision_conflict');
      this.insertAuthorization(input.request, input.authorization, input.deniedAt);
      this.db.prepare(`
        UPDATE permission_requests SET status = 'denied', decision_id = ?,
          decision_reason = ?, resolved_at = ? WHERE id = ?
      `).run(input.decisionId, input.reason, input.deniedAt, input.request.id);
    });
    transaction.immediate();
  }

  private requireMatchingRequest(request: NormalizedCapabilityRequest): PermissionRequestRecord {
    const current = this.findRequest(request.id);
    const stored = current?.request;
    if (!stored || stored.fingerprint !== request.fingerprint
      || stored.taskId !== request.taskId || stored.generationId !== request.generationId
      || stored.subtaskId !== request.subtaskId || stored.attemptId !== request.attemptId
      || stored.agentClassName !== request.agentClassName || stored.permissionProfileId !== request.permissionProfileId
      || stored.capability !== request.capability || stored.operation !== request.operation
      || stored.suggestedScope !== request.suggestedScope
      || partitionCanonicalKey(stored.partition) !== partitionCanonicalKey(request.partition)) {
      throw new Error('permission_request_identity_mismatch');
    }
    return current!;
  }

  escalate(requestId: string, decisionId: string, reason: string, at: string): void {
    this.db.prepare(`
      UPDATE permission_requests SET status = 'escalated', decision_id = ?, decision_reason = ?, resolved_at = NULL
      WHERE id = ? AND status IN ('pending', 'escalated')
    `).run(decisionId, reason, requestId);
  }

  recordAuthorization(
    request: NormalizedCapabilityRequest,
    authorization: Omit<UserAuthorizationRecord, 'id' | 'requestId' | 'fingerprint' | 'taskId' | 'createdAt'>,
    at: string,
  ): void {
    this.insertAuthorization(request, authorization, at);
  }

  private insertAuthorization(
    request: NormalizedCapabilityRequest,
    authorization: Parameters<PermissionRepositoryPort['grant']>[0]['authorization'],
    createdAt: string,
  ): void {
    if (!authorization) return;
    this.db.prepare(`
      INSERT OR IGNORE INTO user_authorizations (
        id, request_id, fingerprint, task_id, resolution, source,
        planner_plan_id, received_event_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `user_authorization_${randomUUID()}`, request.id, request.fingerprint,
      request.taskId, authorization.resolution, authorization.source,
      authorization.plannerPlanId, authorization.receivedEventId, createdAt,
    );
  }
}
