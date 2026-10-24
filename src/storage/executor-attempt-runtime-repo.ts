import type Database from 'better-sqlite3';
import type { KernelRecoverySafety } from '../kernel/control-kernel.js';

export interface ExecutorAttemptRuntimeRecord {
  attemptId: string;
  sourceAttemptId: string | null;
  continuationToken: string | null;
  workspaceRoot: string | null;
  workspaceBaseline: Record<string, unknown>;
  workspaceDelta: Record<string, unknown>;
  progress: Record<string, unknown>;
  recoverySafety: KernelRecoverySafety;
  externalIdempotencyKey: string | null;
  /**
   * Write-after-crash facts. `writeStartedAt` without `receiptPersistedAt`
   * means the Attempt may have changed the user's Workspace without a durable
   * completion fact, which is exactly the `uncertain` case.
   */
  writeStartedAt: string | null;
  writeFinishedAt: string | null;
  receiptPersistedAt: string | null;
  externalEffectStatus: 'none' | 'unknown' | 'observed';
  changeRecordId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TimelineRuntimeRecord = Pick<ExecutorAttemptRuntimeRecord, 'attemptId' | 'updatedAt'> & {
  progress: {
    kind?: unknown;
    text?: unknown;
    occurredAt?: unknown;
    history?: unknown;
  };
};

interface RuntimeRow {
  attempt_id: string;
  source_attempt_id: string | null;
  continuation_token: string | null;
  workspace_root: string | null;
  workspace_baseline_json: string;
  workspace_delta_json: string;
  progress_json: string;
  recovery_safety: KernelRecoverySafety;
  external_idempotency_key: string | null;
  write_started_at: string | null;
  write_finished_at: string | null;
  receipt_persisted_at: string | null;
  external_effect_status: 'none' | 'unknown' | 'observed';
  change_record_id: string | null;
  created_at: string;
  updated_at: string;
}

export class ExecutorAttemptRuntimeRepo {
  constructor(private readonly db: Database.Database) {}

  start(input: {
    attemptId: string;
    sourceAttemptId: string | null;
    workspaceRoot: string | null;
    workspaceBaseline?: Record<string, unknown>;
    recoverySafety: KernelRecoverySafety;
    externalIdempotencyKey?: string | null;
    now: string;
  }): ExecutorAttemptRuntimeRecord {
    this.db.prepare(`
      INSERT INTO executor_attempt_runtime (
        attempt_id, source_attempt_id, continuation_token, workspace_root,
        workspace_baseline_json, workspace_delta_json, progress_json,
        recovery_safety, external_idempotency_key, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, ?, '{}', '{}', ?, ?, ?, ?)
      ON CONFLICT(attempt_id) DO NOTHING
    `).run(
      input.attemptId,
      input.sourceAttemptId,
      input.workspaceRoot,
      JSON.stringify(input.workspaceBaseline ?? {}),
      input.recoverySafety,
      input.externalIdempotencyKey ?? null,
      input.now,
      input.now,
    );
    return this.find(input.attemptId)!;
  }

  recordContinuationToken(attemptId: string, token: string, now: string): void {
    this.db.prepare(`
      UPDATE executor_attempt_runtime
      SET continuation_token = ?, updated_at = ?
      WHERE attempt_id = ? AND (continuation_token IS NULL OR continuation_token = ?)
    `).run(token, now, attemptId, token);
  }

  recordProgress(attemptId: string, progress: Record<string, unknown>, now: string): void {
    this.db.prepare(`
      UPDATE executor_attempt_runtime SET progress_json = ?, updated_at = ? WHERE attempt_id = ?
    `).run(JSON.stringify(progress), now, attemptId);
  }

  touch(attemptId: string, now: string): void {
    this.db.prepare(`
      UPDATE executor_attempt_runtime SET updated_at = ? WHERE attempt_id = ?
    `).run(now, attemptId);
  }

  recordDiagnostics(
    attemptId: string,
    diagnostics: Record<string, unknown>,
    now: string,
  ): void {
    const current = this.find(attemptId);
    if (!current) return;
    this.recordProgress(attemptId, {
      ...current.progress,
      diagnostics,
    }, now);
  }

  appendProgress(
    attemptId: string,
    progress: { kind: string; text: string },
    now: string,
    maxEntries = 20,
  ): void {
    const current = this.find(attemptId);
    if (!current) return;
    const existing = Array.isArray(current.progress.history)
      ? current.progress.history.filter(isProgressEntry)
      : [];
    const entry = { ...progress, occurredAt: now };
    this.recordProgress(attemptId, {
      ...entry,
      history: [...existing, entry].slice(-Math.max(1, maxEntries)),
    }, now);
  }

  recordWorkspaceDelta(attemptId: string, delta: object, now: string): void {
    this.db.prepare(`
      UPDATE executor_attempt_runtime SET workspace_delta_json = ?, updated_at = ? WHERE attempt_id = ?
    `).run(JSON.stringify(delta), now, attemptId);
  }

  /** Records that the Executor was authorized to start writing. */
  recordWriteStarted(attemptId: string, now: string): void {
    this.db.prepare(`
      UPDATE executor_attempt_runtime
      SET write_started_at = COALESCE(write_started_at, ?),
          external_effect_status = CASE external_effect_status
            WHEN 'none' THEN 'unknown' ELSE external_effect_status END,
          updated_at = ?
      WHERE attempt_id = ?
    `).run(now, now, attemptId);
  }

  /** The Executor process finished; writes it made are now observable. */
  recordWriteFinished(
    attemptId: string,
    status: 'none' | 'unknown' | 'observed',
    now: string,
  ): void {
    this.db.prepare(`
      UPDATE executor_attempt_runtime
      SET write_finished_at = ?, external_effect_status = ?, updated_at = ?
      WHERE attempt_id = ?
    `).run(now, status, now, attemptId);
  }

  recordReceiptPersisted(attemptId: string, now: string): void {
    this.db.prepare(`
      UPDATE executor_attempt_runtime
      SET receipt_persisted_at = COALESCE(receipt_persisted_at, ?),
          external_effect_status = CASE external_effect_status
            WHEN 'unknown' THEN 'observed' ELSE external_effect_status END,
          updated_at = ?
      WHERE attempt_id = ?
    `).run(now, now, attemptId);
  }

  recordChangeRecordId(attemptId: string, changeRecordId: string, now: string): void {
    this.db.prepare(`
      UPDATE executor_attempt_runtime SET change_record_id = ?, updated_at = ?
      WHERE attempt_id = ?
    `).run(changeRecordId, now, attemptId);
  }

  /**
   * True when the Attempt may have written user bytes without a durable
   * receipt. Recovery must observe and fence instead of replaying.
   */
  hasUnpersistedWrite(attemptId: string): boolean {
    const row = this.db.prepare(`
      SELECT write_started_at, receipt_persisted_at, external_effect_status
      FROM executor_attempt_runtime WHERE attempt_id = ?
    `).get(attemptId) as {
      write_started_at: string | null;
      receipt_persisted_at: string | null;
      external_effect_status: string | null;
    } | undefined;
    if (!row?.write_started_at || row.receipt_persisted_at) return false;
    return row.external_effect_status !== 'none';
  }

  find(attemptId: string): ExecutorAttemptRuntimeRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM executor_attempt_runtime WHERE attempt_id = ?
    `).get(attemptId) as RuntimeRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  listByTasks(taskIds: readonly string[]): ExecutorAttemptRuntimeRecord[] {
    if (!taskIds.length) return [];
    if (taskIds.length > 100) throw new Error('timeline_task_limit');
    const placeholders = taskIds.map(() => '?').join(',');
    return (this.db.prepare(`SELECT * FROM executor_attempt_runtime WHERE attempt_id IN (
      SELECT attempt_id FROM kernel_dispatch_items WHERE task_id IN (${placeholders})
      UNION SELECT attempt_id FROM executor_attempt_receipts WHERE task_id IN (${placeholders})
    )`).all(...taskIds, ...taskIds) as RuntimeRow[]).map(rowToRecord);
  }

  listTimelineByTasks(taskIds: readonly string[]): TimelineRuntimeRecord[] {
    if (!taskIds.length) return [];
    if (taskIds.length > 100) throw new Error('timeline_task_limit');
    const placeholders = taskIds.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT attempt_id, updated_at, json_object(
        'kind', json_extract(progress_json, '$.kind'),
        'text', json_extract(progress_json, '$.text'),
        'occurredAt', json_extract(progress_json, '$.occurredAt'),
        'history', json_extract(progress_json, '$.history')
      ) AS progress_json
      FROM executor_attempt_runtime
      WHERE attempt_id IN (
        SELECT attempt_id FROM kernel_dispatch_items WHERE task_id IN (${placeholders})
        UNION SELECT attempt_id FROM executor_attempt_receipts WHERE task_id IN (${placeholders})
      )
    `).all(...taskIds, ...taskIds) as Array<Pick<RuntimeRow, 'attempt_id' | 'updated_at' | 'progress_json'>>;
    return rows.map(row => ({
      attemptId: row.attempt_id,
      updatedAt: row.updated_at,
      progress: JSON.parse(row.progress_json) as TimelineRuntimeRecord['progress'],
    }));
  }
}

function isProgressEntry(
  value: unknown,
): value is { kind: string; text: string; occurredAt: string } {
  return Boolean(value)
    && typeof value === 'object'
    && typeof (value as Record<string, unknown>).kind === 'string'
    && typeof (value as Record<string, unknown>).text === 'string'
    && typeof (value as Record<string, unknown>).occurredAt === 'string';
}

function rowToRecord(row: RuntimeRow): ExecutorAttemptRuntimeRecord {
  return {
    attemptId: row.attempt_id,
    sourceAttemptId: row.source_attempt_id,
    continuationToken: row.continuation_token,
    workspaceRoot: row.workspace_root,
    workspaceBaseline: JSON.parse(row.workspace_baseline_json) as Record<string, unknown>,
    workspaceDelta: JSON.parse(row.workspace_delta_json) as Record<string, unknown>,
    progress: JSON.parse(row.progress_json) as Record<string, unknown>,
    recoverySafety: row.recovery_safety,
    externalIdempotencyKey: row.external_idempotency_key,
    writeStartedAt: row.write_started_at ?? null,
    writeFinishedAt: row.write_finished_at ?? null,
    receiptPersistedAt: row.receipt_persisted_at ?? null,
    externalEffectStatus: row.external_effect_status ?? 'none',
    changeRecordId: row.change_record_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
