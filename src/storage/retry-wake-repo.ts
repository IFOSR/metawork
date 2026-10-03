import type Database from 'better-sqlite3';

export type RetryWakeStatus =
  | 'armed'
  | 'fired'
  | 'consumed'
  | 'superseded'
  | 'recovery_required';

export interface RetryWakeRecord {
  wakeId: string;
  taskId: string;
  subtaskId: string;
  generationId: string;
  sourceDecisionId: string;
  sourceAttemptId: string;
  configurationRevision: string;
  bindingFingerprint: string;
  authorizedBindingJson: string;
  resumeAt: string;
  status: RetryWakeStatus;
  timerEventId: string | null;
  consumedDecisionId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RetryWakeRow {
  wake_id: string;
  task_id: string;
  subtask_id: string;
  generation_id: string;
  source_decision_id: string;
  source_attempt_id: string;
  configuration_revision: string;
  binding_fingerprint: string;
  authorized_binding_json: string;
  resume_at: string;
  status: RetryWakeStatus;
  timer_event_id: string | null;
  consumed_decision_id: string | null;
  created_at: string;
  updated_at: string;
}

export class RetryWakeRepo {
  constructor(private readonly db: Database.Database) {}

  arm(record: RetryWakeRecord): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO retry_wakes (
        wake_id, task_id, subtask_id, generation_id, source_decision_id,
        source_attempt_id, configuration_revision, binding_fingerprint,
        authorized_binding_json, resume_at, status, timer_event_id,
        consumed_decision_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'armed', NULL, NULL, ?, ?)
    `).run(
      record.wakeId,
      record.taskId,
      record.subtaskId,
      record.generationId,
      record.sourceDecisionId,
      record.sourceAttemptId,
      record.configurationRevision,
      record.bindingFingerprint,
      record.authorizedBindingJson,
      record.resumeAt,
      record.createdAt,
      record.updatedAt,
    );
    return result.changes === 1;
  }

  findByDecision(sourceDecisionId: string): RetryWakeRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM retry_wakes WHERE source_decision_id = ?
    `).get(sourceDecisionId) as RetryWakeRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  findById(wakeId: string): RetryWakeRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM retry_wakes WHERE wake_id = ?
    `).get(wakeId) as RetryWakeRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  findByTimerEvent(timerEventId: string): RetryWakeRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM retry_wakes WHERE timer_event_id = ?
    `).get(timerEventId) as RetryWakeRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  findBlockingByTask(taskId: string): RetryWakeRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM retry_wakes
      WHERE task_id = ? AND status IN ('armed', 'fired')
      ORDER BY resume_at ASC, wake_id ASC
    `).all(taskId) as RetryWakeRow[];
    return rows.map(rowToRecord);
  }

  findRecoveryRequiredByTask(taskId: string): RetryWakeRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM retry_wakes
      WHERE task_id = ? AND status = 'recovery_required'
      ORDER BY updated_at ASC, wake_id ASC
    `).all(taskId) as RetryWakeRow[];
    return rows.map(rowToRecord);
  }

  listDueOrFiredWithoutTimer(now: string): RetryWakeRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM retry_wakes
      WHERE (status = 'armed' AND resume_at <= ?)
         OR (status = 'fired' AND timer_event_id IS NULL)
      ORDER BY resume_at ASC, wake_id ASC
    `).all(now) as RetryWakeRow[];
    return rows.map(rowToRecord);
  }

  claimDue(now: string, firedAt: string): RetryWakeRecord | null {
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM retry_wakes
        WHERE status = 'armed' AND resume_at <= ?
        ORDER BY resume_at ASC, wake_id ASC
        LIMIT 1
      `).get(now) as RetryWakeRow | undefined;
      if (!row) return null;
      const result = this.db.prepare(`
        UPDATE retry_wakes
        SET status = 'fired', updated_at = ?
        WHERE wake_id = ? AND status = 'armed'
      `).run(firedAt, row.wake_id);
      return result.changes === 1
        ? rowToRecord({ ...row, status: 'fired', updated_at: firedAt })
        : null;
    });
    return claim.immediate();
  }

  claimDueWake(wakeId: string, now: string, firedAt: string): RetryWakeRecord | null {
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM retry_wakes
        WHERE wake_id = ? AND status = 'armed' AND resume_at <= ?
      `).get(wakeId, now) as RetryWakeRow | undefined;
      if (!row) return null;
      const result = this.db.prepare(`
        UPDATE retry_wakes
        SET status = 'fired', updated_at = ?
        WHERE wake_id = ? AND status = 'armed'
      `).run(firedAt, wakeId);
      return result.changes === 1
        ? rowToRecord({ ...row, status: 'fired', updated_at: firedAt })
        : null;
    });
    return claim.immediate();
  }

  markFired(wakeId: string, timerEventId: string, updatedAt: string): boolean {
    const result = this.db.prepare(`
      UPDATE retry_wakes
      SET status = 'fired', timer_event_id = ?, updated_at = ?
      WHERE wake_id = ? AND status IN ('armed', 'fired')
        AND (timer_event_id IS NULL OR timer_event_id = ?)
    `).run(timerEventId, updatedAt, wakeId, timerEventId);
    return result.changes === 1;
  }

  clearTimerEvent(wakeId: string, timerEventId: string, updatedAt: string): boolean {
    const result = this.db.prepare(`
      UPDATE retry_wakes
      SET timer_event_id = NULL, updated_at = ?
      WHERE wake_id = ? AND status = 'fired' AND timer_event_id = ?
    `).run(updatedAt, wakeId, timerEventId);
    return result.changes === 1;
  }

  markConsumed(wakeId: string, decisionId: string, updatedAt: string): boolean {
    const result = this.db.prepare(`
      UPDATE retry_wakes
      SET status = 'consumed', consumed_decision_id = ?, updated_at = ?
      WHERE wake_id = ? AND status IN ('fired', 'consumed')
    `).run(decisionId, updatedAt, wakeId);
    return result.changes === 1;
  }

  markSuperseded(wakeId: string, updatedAt: string): boolean {
    const result = this.db.prepare(`
      UPDATE retry_wakes
      SET status = 'superseded', updated_at = ?
      WHERE wake_id = ? AND status IN ('armed', 'fired')
    `).run(updatedAt, wakeId);
    return result.changes === 1;
  }

  markRecoveryRequired(wakeId: string, updatedAt: string): boolean {
    const result = this.db.prepare(`
      UPDATE retry_wakes
      SET status = 'recovery_required', updated_at = ?
      WHERE wake_id = ? AND status IN ('armed', 'fired')
    `).run(updatedAt, wakeId);
    return result.changes === 1;
  }
}

function rowToRecord(row: RetryWakeRow): RetryWakeRecord {
  return {
    wakeId: row.wake_id,
    taskId: row.task_id,
    subtaskId: row.subtask_id,
    generationId: row.generation_id,
    sourceDecisionId: row.source_decision_id,
    sourceAttemptId: row.source_attempt_id,
    configurationRevision: row.configuration_revision,
    bindingFingerprint: row.binding_fingerprint,
    authorizedBindingJson: row.authorized_binding_json,
    resumeAt: row.resume_at,
    status: row.status,
    timerEventId: row.timer_event_id,
    consumedDecisionId: row.consumed_decision_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
