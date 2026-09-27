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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
