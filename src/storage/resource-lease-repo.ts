import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  partitionCanonicalKey,
  resourceClaimsConflict,
  type ClaimResourceLeasesInput,
  type ClaimResourceLeasesResult,
  type PartitionIdentity,
  type ResourceLeaseRecord,
  type ResourceLeaseRepositoryPort,
  type ResourceWaitRecord,
} from '../resource/index.js';

interface ResourceLeaseRow {
  id: string;
  partition_key: string;
  partition_json: string;
  access_mode: 'read' | 'write';
  task_id: string;
  generation_id: string;
  subtask_id: string;
  attempt_id: string;
  work_unit_id: string;
  lease_token: string;
  heartbeat_at: string;
  expires_at: string;
  released_at: string | null;
  revocation_requested_at: string | null;
  revocation_reason: string | null;
  created_at: string;
}

interface ResourceWaitRow {
  id: string;
  task_id: string;
  generation_id: string;
  subtask_id: string;
  attempt_id: string;
  partition_key: string;
  partition_json: string;
  access_mode: 'read' | 'write';
  conflicting_lease_ids_json: string;
  status: 'waiting' | 'resolved' | 'cancelled';
  requested_at: string;
  resolved_at: string | null;
}

function leaseFromRow(row: ResourceLeaseRow): ResourceLeaseRecord {
  return {
    id: row.id,
    partitionKey: row.partition_key,
    partition: JSON.parse(row.partition_json) as PartitionIdentity,
    access: row.access_mode,
    taskId: row.task_id,
    generationId: row.generation_id,
    subtaskId: row.subtask_id,
    attemptId: row.attempt_id,
    workUnitId: row.work_unit_id,
    leaseToken: row.lease_token,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
    releasedAt: row.released_at,
    revocationRequestedAt: row.revocation_requested_at,
    revocationReason: row.revocation_reason,
    createdAt: row.created_at,
  };
}

function waitFromRow(row: ResourceWaitRow): ResourceWaitRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    generationId: row.generation_id,
    subtaskId: row.subtask_id,
    attemptId: row.attempt_id,
    partitionKey: row.partition_key,
    partition: JSON.parse(row.partition_json) as PartitionIdentity,
    access: row.access_mode,
    conflictingLeaseIds: JSON.parse(row.conflicting_lease_ids_json) as string[],
    status: row.status,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
  };
}

export class SqliteResourceLeaseRepository implements ResourceLeaseRepositoryPort {
  constructor(private readonly db: Database.Database) {}

  claim(input: ClaimResourceLeasesInput): ClaimResourceLeasesResult {
    const transaction = this.db.transaction((): ClaimResourceLeasesResult => {
      const existingRows = this.db.prepare(`
        SELECT * FROM resource_leases
        WHERE released_at IS NULL AND expires_at > ?
        ORDER BY created_at, id
      `).all(input.now) as ResourceLeaseRow[];
      const existing = existingRows.map(leaseFromRow);
      const own = existing.filter(lease => lease.attemptId === input.attemptId && lease.leaseToken === input.leaseToken);
      const others = existing.filter(lease => lease.attemptId !== input.attemptId);
      const conflicts = others.filter(lease => input.claims.some(claim => resourceClaimsConflict(claim, lease)));

      if (conflicts.length > 0) {
        const waits = input.claims
          .map(claim => ({ claim, conflicts: conflicts.filter(lease => resourceClaimsConflict(claim, lease)) }))
          .filter(item => item.conflicts.length > 0)
          .map(({ claim, conflicts: claimConflicts }) => this.upsertWait(input, claim.partition, claim.access, claimConflicts.map(lease => lease.id)));
        return { type: 'conflict', waits, conflictingLeases: conflicts };
      }

      const inserted = [...own];
      const insert = this.db.prepare(`
        INSERT INTO resource_leases (
          id, partition_key, partition_json, access_mode, task_id, generation_id,
          subtask_id, attempt_id, work_unit_id, lease_token, heartbeat_at,
          expires_at, released_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      `);
      for (const claim of input.claims) {
        const partitionKey = partitionCanonicalKey(claim.partition);
        const duplicate = inserted.find(lease => lease.partitionKey === partitionKey && lease.access === claim.access);
        if (duplicate) continue;
        const row: ResourceLeaseRow = {
          id: `resource_lease_${randomUUID()}`,
          partition_key: partitionKey,
          partition_json: JSON.stringify(claim.partition),
          access_mode: claim.access,
          task_id: input.taskId,
          generation_id: input.generationId,
          subtask_id: input.subtaskId,
          attempt_id: input.attemptId,
          work_unit_id: input.workUnitId,
          lease_token: input.leaseToken,
          heartbeat_at: input.now,
          expires_at: input.expiresAt,
          released_at: null,
          revocation_requested_at: null,
          revocation_reason: null,
          created_at: input.now,
        };
        insert.run(
          row.id, row.partition_key, row.partition_json, row.access_mode,
          row.task_id, row.generation_id, row.subtask_id, row.attempt_id,
          row.work_unit_id, row.lease_token, row.heartbeat_at, row.expires_at,
          row.created_at,
        );
        inserted.push(leaseFromRow(row));
      }
      this.db.prepare(`
        UPDATE resource_waits SET status = 'resolved', resolved_at = ?
        WHERE attempt_id = ? AND status = 'waiting'
      `).run(input.now, input.attemptId);
      return { type: 'claimed', leases: inserted };
    });
    return transaction.immediate();
  }

  heartbeat(attemptId: string, leaseToken: string, now: string, expiresAt: string): number {
    return this.db.prepare(`
      UPDATE resource_leases
      SET heartbeat_at = ?, expires_at = ?
      WHERE attempt_id = ? AND lease_token = ? AND released_at IS NULL AND expires_at > ?
        AND revocation_requested_at IS NULL
    `).run(now, expiresAt, attemptId, leaseToken, now).changes;
  }

  releaseAttempt(attemptId: string, leaseToken: string, releasedAt: string): number {
    return this.db.prepare(`
      UPDATE resource_leases SET released_at = ?
      WHERE attempt_id = ? AND lease_token = ? AND released_at IS NULL
    `).run(releasedAt, attemptId, leaseToken).changes;
  }

  releaseReconciledAttempt(attemptId: string, releasedAt: string): number {
    return this.db.prepare(`
      UPDATE resource_leases SET released_at = ?
      WHERE attempt_id = ? AND released_at IS NULL
    `).run(releasedAt, attemptId).changes;
  }

  findActive(now: string): ResourceLeaseRecord[] {
    return (this.db.prepare(`
      SELECT * FROM resource_leases
      WHERE released_at IS NULL AND expires_at > ? ORDER BY created_at, id
    `).all(now) as ResourceLeaseRow[]).map(leaseFromRow);
  }

  findWaits(attemptId: string): ResourceWaitRecord[] {
    return (this.db.prepare(`
      SELECT * FROM resource_waits WHERE attempt_id = ? ORDER BY requested_at, id
    `).all(attemptId) as ResourceWaitRow[]).map(waitFromRow);
  }

  requestRevocation(
    taskId: string,
    generationId: string | null,
    subtaskIds: readonly string[] | null,
    reason: string,
    now: string,
  ): number {
    const filters = ['task_id = ?', 'released_at IS NULL'];
    const parameters: unknown[] = [taskId];
    if (generationId) {
      filters.push('generation_id = ?');
      parameters.push(generationId);
    }
    if (subtaskIds) {
      if (subtaskIds.length === 0) return 0;
      filters.push(`subtask_id IN (${subtaskIds.map(() => '?').join(', ')})`);
      parameters.push(...subtaskIds);
    }
    return this.db.prepare(`
      UPDATE resource_leases
      SET revocation_requested_at = COALESCE(revocation_requested_at, ?),
          revocation_reason = COALESCE(revocation_reason, ?)
      WHERE ${filters.join(' AND ')}
    `).run(now, reason, ...parameters).changes;
  }

  cancelWaits(
    taskId: string,
    generationId: string | null,
    subtaskIds: readonly string[] | null,
    now: string,
  ): number {
    const filters = ['task_id = ?', "status = 'waiting'"];
    const parameters: unknown[] = [taskId];
    if (generationId) {
      filters.push('generation_id = ?');
      parameters.push(generationId);
    }
    if (subtaskIds) {
      if (subtaskIds.length === 0) return 0;
      filters.push(`subtask_id IN (${subtaskIds.map(() => '?').join(', ')})`);
      parameters.push(...subtaskIds);
    }
    return this.db.prepare(`
      UPDATE resource_waits
      SET status = 'cancelled', resolved_at = ?
      WHERE ${filters.join(' AND ')}
    `).run(now, ...parameters).changes;
  }

  releaseRevokedAttempt(attemptId: string, now: string): number {
    return this.db.prepare(`
      UPDATE resource_leases
      SET released_at = ?
      WHERE attempt_id = ?
        AND released_at IS NULL
        AND revocation_requested_at IS NOT NULL
    `).run(now, attemptId).changes;
  }

  private upsertWait(
    input: ClaimResourceLeasesInput,
    partition: PartitionIdentity,
    access: 'read' | 'write',
    conflictingLeaseIds: string[],
  ): ResourceWaitRecord {
    const partitionKey = partitionCanonicalKey(partition);
    const id = `resource_wait_${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO resource_waits (
        id, task_id, generation_id, subtask_id, attempt_id, partition_key,
        partition_json, access_mode, conflicting_lease_ids_json, status,
        requested_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, NULL)
      ON CONFLICT(attempt_id, partition_key, access_mode) DO UPDATE SET
        conflicting_lease_ids_json = excluded.conflicting_lease_ids_json,
        status = 'waiting', requested_at = excluded.requested_at, resolved_at = NULL
    `).run(
      id, input.taskId, input.generationId, input.subtaskId, input.attemptId,
      partitionKey, JSON.stringify(partition), access, JSON.stringify(conflictingLeaseIds.sort()), input.now,
    );
    const row = this.db.prepare(`
      SELECT * FROM resource_waits WHERE attempt_id = ? AND partition_key = ? AND access_mode = ?
    `).get(input.attemptId, partitionKey, access) as ResourceWaitRow;
    return waitFromRow(row);
  }
}
