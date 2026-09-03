import type Database from 'better-sqlite3';

export type ConversationTaskSlotState = 'free' | 'occupied' | 'releasing' | 'recovery_blocked';

export interface ConversationTaskSlot {
  conversationId: string;
  activeTaskId: string | null;
  state: ConversationTaskSlotState;
  reservationId: string | null;
  fairnessSequence: number;
  lastServedAt: string | null;
  updatedAt: string;
}

export interface QueuedTaskPayload {
  requestText: string;
  generationId: string;
  graphRevision: number;
  workGraph: unknown;
  authorizedBindingsBySubtask: unknown;
  workspaceId: string | null;
  plannerSessionId: string;
  kernelDecisionId?: string;
  proposalSource?: 'initial' | 'replan' | 'conflict_replan';
  includeRecentConversationContext?: boolean;
  executionMode?: 'fresh' | 'resume-parked' | 'resume-blocked' | 'follow-up';
  schedulingReason?: string;
}

interface SlotRow {
  conversation_id: string;
  active_task_id: string | null;
  state: ConversationTaskSlotState;
  reservation_id: string | null;
  fairness_sequence: number;
  last_served_at: string | null;
  updated_at: string;
}

interface ScheduleRow {
  task_id: string;
  conversation_id: string;
  state: 'queued' | 'eligible' | 'reserved' | 'running' | 'terminal';
  enqueued_at: string;
  eligible_since: string;
  last_scheduled_at: string | null;
  scheduling_reason: string;
  payload_json: string;
}

export class ConversationTaskSchedulerRepo {
  constructor(private readonly db: Database.Database) {}

  getSlot(conversationId: string): ConversationTaskSlot {
    this.ensureSlot(conversationId);
    return this.toSlot(this.db.prepare(
      'SELECT * FROM conversation_task_slots WHERE conversation_id = ?',
    ).get(conversationId) as SlotRow);
  }

  claimSlot(
    conversationId: string,
    taskId: string,
    reservationId: string,
    now: string,
  ): boolean {
    this.ensureSlot(conversationId, now);
    const result = this.db.prepare(`
      UPDATE conversation_task_slots
      SET active_task_id = ?, state = 'occupied', reservation_id = ?,
          fairness_sequence = fairness_sequence + 1, last_served_at = ?, updated_at = ?
      WHERE conversation_id = ? AND state = 'free' AND active_task_id IS NULL
    `).run(taskId, reservationId, now, now, conversationId);
    if (result.changes !== 1) return false;
    this.db.prepare(`
      UPDATE task_schedule_entries SET state = 'running', last_scheduled_at = ?
      WHERE task_id = ? AND state IN ('queued', 'eligible', 'reserved')
    `).run(now, taskId);
    return true;
  }

  releaseSlot(conversationId: string, taskId: string, now: string): boolean {
    const result = this.db.prepare(`
      UPDATE conversation_task_slots
      SET active_task_id = NULL, state = 'free', reservation_id = NULL, updated_at = ?
      WHERE conversation_id = ? AND active_task_id = ?
    `).run(now, conversationId, taskId);
    return result.changes === 1;
  }

  releaseSlotAndPromote(
    conversationId: string,
    taskId: string,
    now: string,
    hasResidue = false,
    allowPromotion = true,
  ): { taskId: string; reservationId: string } | null {
    return this.db.transaction(() => {
      if (hasResidue) {
        this.db.prepare(`
          UPDATE conversation_task_slots
          SET state = 'releasing', updated_at = ?
          WHERE conversation_id = ? AND active_task_id = ?
        `).run(now, conversationId, taskId);
        return null;
      }
      const released = this.db.prepare(`
        UPDATE conversation_task_slots
        SET active_task_id = NULL, state = 'free', reservation_id = NULL, updated_at = ?
        WHERE conversation_id = ? AND active_task_id = ? AND state IN ('occupied', 'releasing')
      `).run(now, conversationId, taskId);
      if (released.changes !== 1) return null;
      if (!allowPromotion) return null;
      return this.promoteQueuedInTransaction(conversationId, now);
    })();
  }

  /**
   * Releases the slot held by a terminal task without knowing the owning
   * conversation up front, then promotes the next queued task. Used by
   * cancellation cascades so a cancelled task never blocks its conversation.
   */
  releaseTaskSlotAndPromote(
    taskId: string,
    now: string,
  ): { conversationId: string; promotedTaskId: string | null } | null {
    return this.db.transaction(() => {
      const slot = this.db.prepare(`
        SELECT conversation_id FROM conversation_task_slots
        WHERE active_task_id = ? AND state IN ('occupied', 'releasing')
      `).get(taskId) as { conversation_id: string } | undefined;
      if (!slot) return null;
      const released = this.db.prepare(`
        UPDATE conversation_task_slots
        SET active_task_id = NULL, state = 'free', reservation_id = NULL, updated_at = ?
        WHERE conversation_id = ? AND active_task_id = ? AND state IN ('occupied', 'releasing')
      `).run(now, slot.conversation_id, taskId);
      if (released.changes !== 1) return { conversationId: slot.conversation_id, promotedTaskId: null };
      const promotion = this.promoteQueuedInTransaction(slot.conversation_id, now);
      return {
        conversationId: slot.conversation_id,
        promotedTaskId: promotion?.taskId ?? null,
      };
    })();
  }

  promoteNextQueued(
    conversationId: string,
    now: string,
  ): { taskId: string; reservationId: string } | null {
    return this.db.transaction(() => this.promoteQueuedInTransaction(conversationId, now))();
  }

  markRecoveryBlocked(conversationId: string, taskId: string, now: string): boolean {
    return this.db.prepare(`
      UPDATE conversation_task_slots
      SET state = 'recovery_blocked', updated_at = ?
      WHERE conversation_id = ? AND active_task_id = ?
    `).run(now, conversationId, taskId).changes === 1;
  }

  listSlots(): ConversationTaskSlot[] {
    return (this.db.prepare(
      'SELECT * FROM conversation_task_slots ORDER BY conversation_id',
    ).all() as SlotRow[]).map(row => this.toSlot(row));
  }

  private promoteQueuedInTransaction(
    conversationId: string,
    now: string,
  ): { taskId: string; reservationId: string } | null {
    const slot = this.getSlot(conversationId);
    if (slot.state !== 'free' || slot.activeTaskId !== null) return null;
    const next = this.db.prepare(`
      SELECT task_id FROM task_schedule_entries
      WHERE conversation_id = ? AND state = 'queued'
      ORDER BY enqueued_at ASC, task_id ASC LIMIT 1
    `).get(conversationId) as { task_id: string } | undefined;
    if (!next) return null;
    const reservationId = `reservation_${conversationId}_${next.task_id}`;
    const claimed = this.db.prepare(`
      UPDATE conversation_task_slots
      SET active_task_id = ?, state = 'occupied', reservation_id = ?,
          fairness_sequence = fairness_sequence + 1, last_served_at = ?, updated_at = ?
      WHERE conversation_id = ? AND state = 'free' AND active_task_id IS NULL
    `).run(next.task_id, reservationId, now, now, conversationId);
    if (claimed.changes !== 1) return null;
    this.db.prepare(`
      UPDATE task_schedule_entries SET state = 'reserved', last_scheduled_at = ?
      WHERE task_id = ? AND state = 'queued'
    `).run(now, next.task_id);
    return { taskId: next.task_id, reservationId };
  }

  enqueueTask(
    taskId: string,
    conversationId: string,
    now: string,
    reasonOrPayload: string | QueuedTaskPayload = 'conversation_slot_occupied',
    payload: QueuedTaskPayload | null = null,
  ): void {
    const reason = typeof reasonOrPayload === 'string'
      ? reasonOrPayload
      : reasonOrPayload.schedulingReason ?? 'conversation_slot_occupied';
    const queuedPayload = typeof reasonOrPayload === 'string' ? payload : reasonOrPayload;
    this.ensureSlot(conversationId, now);
    this.db.prepare(`
      INSERT INTO task_schedule_entries (
        task_id, conversation_id, state, enqueued_at, eligible_since, scheduling_reason, payload_json
      ) VALUES (?, ?, 'queued', ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        state = 'queued',
        scheduling_reason = excluded.scheduling_reason,
        payload_json = excluded.payload_json
    `).run(taskId, conversationId, now, now, reason, JSON.stringify(queuedPayload ?? {}));
  }

  getQueuedPayload(taskId: string): QueuedTaskPayload | null {
    const row = this.db.prepare(`
      SELECT payload_json FROM task_schedule_entries WHERE task_id = ?
    `).get(taskId) as { payload_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.payload_json) as QueuedTaskPayload;
  }

  listQueuedTasks(conversationId: string): string[] {
    const rows = this.db.prepare(`
      SELECT task_id FROM task_schedule_entries
      WHERE conversation_id = ? AND state = 'queued'
      ORDER BY enqueued_at, task_id
    `).all(conversationId) as Array<{ task_id: string }>;
    return rows.map(row => row.task_id);
  }

  countQueuedTasks(conversationId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM task_schedule_entries
      WHERE conversation_id = ? AND state = 'queued'
    `).get(conversationId) as { count: number };
    return row.count;
  }

  listQueuedConversations(): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT conversation_id FROM task_schedule_entries
      WHERE state = 'queued'
      ORDER BY conversation_id
    `).all() as Array<{ conversation_id: string }>;
    return rows.map(row => row.conversation_id);
  }

  markScheduled(taskId: string, now: string): boolean {
    const result = this.db.prepare(`
      UPDATE task_schedule_entries
      SET state = 'reserved', last_scheduled_at = ?
      WHERE task_id = ? AND state = 'queued'
    `).run(now, taskId);
    return result.changes === 1;
  }

  markRunning(taskId: string, now: string): boolean {
    return this.db.prepare(`
      UPDATE task_schedule_entries
      SET state = 'running', last_scheduled_at = ?
      WHERE task_id = ? AND state IN ('queued', 'eligible', 'reserved')
    `).run(now, taskId).changes === 1;
  }

  markTerminal(taskId: string, now: string): boolean {
    return this.db.prepare(`
      UPDATE task_schedule_entries
      SET state = 'terminal', last_scheduled_at = ?
      WHERE task_id = ? AND state <> 'terminal'
    `).run(now, taskId).changes === 1;
  }

  listReservedTasks(): string[] {
    const rows = this.db.prepare(`
      SELECT task_id FROM task_schedule_entries
      WHERE state = 'reserved'
      ORDER BY last_scheduled_at ASC, task_id ASC
    `).all() as Array<{ task_id: string }>;
    return rows.map(row => row.task_id);
  }

  markEligible(taskId: string, now: string): boolean {
    const result = this.db.prepare(`
      UPDATE task_schedule_entries
      SET state = 'eligible', eligible_since = ?
      WHERE task_id = ? AND state IN ('queued', 'reserved')
    `).run(now, taskId);
    return result.changes === 1;
  }

  private ensureSlot(conversationId: string, now = new Date().toISOString()): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO conversation_task_slots (
        conversation_id, state, updated_at
      ) VALUES (?, 'free', ?)
    `).run(conversationId, now);
  }

  private toSlot(row: SlotRow): ConversationTaskSlot {
    return {
      conversationId: row.conversation_id,
      activeTaskId: row.active_task_id,
      state: row.state,
      reservationId: row.reservation_id,
      fairnessSequence: row.fairness_sequence,
      lastServedAt: row.last_served_at,
      updatedAt: row.updated_at,
    };
  }
}
