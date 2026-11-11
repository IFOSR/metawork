import type Database from 'better-sqlite3';
import type { ConversationDeletionPort } from '../session/conversation-deletion.js';
import { ensurePlanProposalSchema } from './plan-proposal-repo.js';
import { ensurePlanAdmissionResultSchema } from './plan-admission-result-repo.js';

/** Account scoped cleanup. Domain identity/status facts survive without query content. */
export class SqliteConversationDeletionStore implements ConversationDeletionPort {
  constructor(private readonly db: Database.Database) {
    ensurePlanProposalSchema(db);
    ensurePlanAdmissionResultSchema(db);
  }
  begin(accountId: string, conversationId: string): void {
    this.db.transaction(() => {
      const now = new Date().toISOString();
      this.db.prepare(`INSERT OR IGNORE INTO conversation_deletions VALUES (?, ?, 'pending', ?)`)
        .run(accountId, conversationId, now);
      this.db.prepare(`UPDATE task_plan_proposals
        SET delivery = 'invalidated', delivery_reason = 'conversation_deleted', updated_at = ?
        WHERE delivery = 'pending'
          AND COALESCE(json_extract(request_json, '$.conversationId'), json_extract(request_json, '$.sessionId')) = ?`)
        .run(now, conversationId);
    }).immediate();
  }
  pending(accountId: string): string[] {
    return (this.db.prepare("SELECT conversation_id FROM conversation_deletions WHERE account_id = ? AND state = 'pending' LIMIT 50")
      .all(accountId) as { conversation_id: string }[]).map(row => row.conversation_id);
  }
  complete(accountId: string, conversationId: string): void {
    this.db.prepare("UPDATE conversation_deletions SET state = 'completed' WHERE account_id = ? AND conversation_id = ?")
      .run(accountId, conversationId);
  }
  cleanLocal(accountId: string, conversationId: string): void {
    this.db.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM conversation_deletions WHERE account_id = ? AND conversation_id = ?')
        .get(accountId, conversationId)) throw new Error('deletion_not_fenced');
      // Terminal audit rows retain their identities and states. Only this fenced,
      // atomic erasure transaction may redact immutable runtime text; restore
      // the original guards before commit (rollback restores them on any error).
      const guards = this.db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
        AND name IN ('executor_attempt_receipts_immutable_update', 'subtask_handoffs_immutable_update', 'result_references_immutable_update')`)
        .all() as { name: string; sql: string }[];
      for (const guard of guards) this.db.exec(`DROP TRIGGER ${guard.name}`);
      // Proposals contain original input, attachments and prepared routing.
      // Erase even unadmitted proposals, which have no Task row to join.
      this.db.prepare(`DELETE FROM task_plan_admission_results WHERE proposal_id IN (
        SELECT proposal_id FROM task_plan_proposals
        WHERE COALESCE(json_extract(request_json, '$.conversationId'), json_extract(request_json, '$.sessionId')) = ?
      )`).run(conversationId);
      this.db.prepare(`DELETE FROM task_plan_origins WHERE proposal_id IN (
        SELECT proposal_id FROM task_plan_proposals
        WHERE COALESCE(json_extract(request_json, '$.conversationId'), json_extract(request_json, '$.sessionId')) = ?
      )`).run(conversationId);
      this.db.prepare(`DELETE FROM task_plan_proposals
        WHERE COALESCE(json_extract(request_json, '$.conversationId'), json_extract(request_json, '$.sessionId')) = ?`)
        .run(conversationId);
      const metadata = this.db.prepare('SELECT metadata_json FROM conversation_metadata_projection WHERE account_id = ? AND conversation_id = ?')
        .get(accountId, conversationId) as { metadata_json: string } | undefined;
      const plannerId = metadata ? (JSON.parse(metadata.metadata_json) as { plannerSessionId?: string }).plannerSessionId : undefined;
      const plannerIds = new Set((this.db.prepare(`SELECT DISTINCT planner_session_id FROM planner_transcript_turns
        WHERE account_id = ? AND conversation_id = ?`).all(accountId, conversationId) as { planner_session_id: string }[])
        .map(row => row.planner_session_id));
      plannerIds.add(conversationId);
      if (plannerId) plannerIds.add(plannerId);
      for (const plannerId of plannerIds) {
        this.db.prepare(`UPDATE planner_tool_calls SET arguments_summary_json = '{}', result_summary_json = '{}'
          WHERE planner_run_id IN (SELECT id FROM planner_runs WHERE session_id = ?)`).run(plannerId);
        this.db.prepare('UPDATE planner_runs SET error_summary = NULL WHERE session_id = ?').run(plannerId);
        this.db.prepare('DELETE FROM planner_proposal_submissions WHERE session_id = ?').run(plannerId);
        this.db.prepare('DELETE FROM planner_proposal_turns WHERE session_id = ?').run(plannerId);
        this.db.prepare('DELETE FROM interactions WHERE session_id = ? AND task_id IS NULL').run(plannerId);
      }
      const tasks = this.db.prepare('SELECT id FROM tasks WHERE account_id = ? AND conversation_id = ?')
        .all(accountId, conversationId) as { id: string }[];
      for (const { id } of tasks) {
        this.db.prepare('DELETE FROM task_execution_evidence WHERE task_id = ?').run(id);
        this.db.prepare('DELETE FROM interactions WHERE task_id = ?').run(id);
        const redactions: Record<string, string> = {
          tasks: "title = '[deleted]', goal = NULL, summary = '', snapshot_json = '[]', resources_json = '[]', state_detail_json = '{}', last_scheduling_reason = '', last_interruption_reason = '', archived_at = COALESCE(archived_at, datetime('now'))",
          subtasks: "title = '[deleted]', goal = '', result = '', error = NULL, acceptance_json = '[]', context_refs_json = '[]', verification_json = '{}'",
          effect_outbox: "payload_json = '{}', status = CASE WHEN status IN ('pending','sending') THEN 'failed' ELSE status END, error_summary = NULL",
          dispatch_items: "attempt_payload_json = '{}', status = CASE WHEN status = 'pending_launch' THEN 'cancelled' ELSE status END, error_summary = NULL",
          executor_attempt_receipts: "raw_response = '', parsing_json = '{}', verification_json = '{}', error_detail = NULL, failure_json = NULL",
          subtask_handoffs: "items_json = '[]'",
          task_schedule_entries: "payload_json = '{}', state = 'terminal'",
          task_events: "message = '', payload_json = '{}'",
          work_unit_events: "message = '', payload_json = '{}'",
          executor_route_events: "user_input = '', reason = '', result = NULL, candidates_json = '[]'",
          executor_skill_usage_events: "message = '', payload_json = '{}'",
          task_operation_results: "message = ''",
          task_state_changes: "detail_json = '{}'",
          task_state_projection_outbox: "detail_json = '{}'",
          workspace_publications: "original_completion_json = '{}', error_summary = NULL",
          generation_replan_requests: "deferred_plan_json = NULL, error_summary = NULL, availability_explanation = NULL",
          result_references: "required_items_json = '[]'",
          work_graph_revisions: "completion_requirements_json = '[]'",
        };
        for (const [table, assignments] of Object.entries(redactions)) {
          this.db.prepare(`UPDATE ${table} SET ${assignments} WHERE ${table === 'tasks' ? 'id' : 'task_id'} = ?`).run(id);
        }
        this.db.prepare(`UPDATE executor_attempt_runtime SET progress_json = '{}', continuation_token = NULL
          WHERE attempt_id IN (SELECT attempt_id FROM executor_attempt_receipts WHERE task_id = ?)`).run(id);
        this.db.prepare('DELETE FROM task_memory_cards WHERE task_id = ?').run(id);
        this.db.prepare('DELETE FROM task_search_index WHERE task_id = ?').run(id);
        this.db.prepare('DELETE FROM conversation_activity_views WHERE task_id = ?').run(id);
        // Derived projections must stop retrying an erased Task. Leaving the
        // outbox and activity queue rows behind made the projector re-queue the
        // Conversation every 100ms and fail with conversation_deleted forever.
        this.db.prepare('DELETE FROM conversation_activity_dirty WHERE task_id = ?').run(id);
        this.db.prepare(`UPDATE task_state_projection_outbox
          SET dispatched_at = COALESCE(dispatched_at, datetime('now')), detail_json = '{}'
          WHERE task_id = ?`).run(id);
      }
      for (const guard of guards) this.db.exec(guard.sql);
      if (metadata) {
        const value = JSON.parse(metadata.metadata_json) as Record<string, unknown>;
        value.title = '[deleted]'; value.preview = ''; value.archived = true;
        this.db.prepare('UPDATE conversation_metadata_projection SET metadata_json = ? WHERE account_id = ? AND conversation_id = ?')
          .run(JSON.stringify(value), accountId, conversationId);

      }
      this.db.prepare(`DELETE FROM notification_outbox WHERE route_id IN (SELECT id FROM notification_routes
        WHERE account_id = ? AND conversation_id = ?)`).run(accountId, conversationId);
      this.db.prepare(`DELETE FROM notification_route_seeds WHERE route_id IN (SELECT id FROM notification_routes
        WHERE account_id = ? AND conversation_id = ?)`).run(accountId, conversationId);
      this.db.prepare('DELETE FROM notification_routes WHERE account_id = ? AND conversation_id = ?').run(accountId, conversationId);
      this.db.prepare(`DELETE FROM gateway_command_admissions WHERE account_id = ? AND json_extract(body_json, '$.conversationId') = ?`)
        .run(accountId, conversationId);
      this.db.prepare(`DELETE FROM client_action_references WHERE json_extract(body_json, '$.accountId') = ?
        AND json_extract(body_json, '$.conversationId') = ?`).run(accountId, conversationId);
      this.db.prepare('DELETE FROM workspace_directory_projection WHERE account_id = ? AND conversation_id = ?').run(accountId, conversationId);
      // A deleted Conversation owns no execution capacity any more, and its
      // scheduling entry must not keep a slot occupied for recovery to trip on.
      this.db.prepare(`UPDATE conversation_task_slots
        SET active_task_id = NULL, state = 'free', reservation_id = NULL, updated_at = datetime('now')
        WHERE conversation_id = ? AND active_task_id IS NOT NULL`).run(conversationId);
      this.db.prepare(`UPDATE task_schedule_entries SET state = 'terminal', payload_json = '{}'
        WHERE task_id IN (SELECT id FROM tasks WHERE account_id = ? AND conversation_id = ?)
          AND state <> 'terminal'`).run(accountId, conversationId);
      this.db.prepare('DELETE FROM interactions WHERE session_id = ?').run(conversationId);
      this.db.prepare('DELETE FROM planner_proposal_submissions WHERE session_id = ?').run(conversationId);
      this.db.prepare('DELETE FROM planner_proposal_turns WHERE session_id = ?').run(conversationId);
      this.db.prepare('DELETE FROM planner_turn_inputs WHERE conversation_id = ?').run(conversationId);
      const scoped = [
        'conversation_content_search', 'conversation_content_search_queue', 'conversation_content_search_chunks',
        'conversation_read_turns', 'conversation_read_changes', 'conversation_read_bodies',
        'conversation_read_content_chunks', 'conversation_read_content_manifests', 'conversation_read_heads',
        'conversation_read_rebuilds', 'conversation_read_history_checkpoint', 'conversation_read_history_dirty',
        'conversation_history_turns', 'conversation_history_streams', 'gateway_trace_read_events', 'gateway_trace_read_heads',
        'conversation_result_content_refs', 'planner_transcript_turns', 'conversation_memory_receipts', 'conversation_turn_outbox', 'conversation_turn_answers', 'conversation_turn_cancellations', 'conversation_turns', 'conversation_turn_migration',
        'memory_recall_candidates', 'memory_recall_layers', 'gateway_turn_task_observations', 'conversation_derived_content',
      ];
      for (const table of scoped) this.db.prepare(`DELETE FROM ${table} WHERE account_id = ? AND conversation_id = ?`).run(accountId, conversationId);
      // History invalidation triggers may have added rows while deleting history.
      this.db.prepare('DELETE FROM conversation_read_history_dirty WHERE account_id = ? AND conversation_id = ?').run(accountId, conversationId);
      this.db.prepare(`DELETE FROM conversation_turn_bodies WHERE account_id = ?
        AND NOT EXISTS (SELECT 1 FROM conversation_turns t WHERE t.account_id = conversation_turn_bodies.account_id AND t.user_input_hash = body_hash)
        AND NOT EXISTS (SELECT 1 FROM conversation_turn_answers a WHERE a.account_id = conversation_turn_bodies.account_id AND a.body_hash = conversation_turn_bodies.body_hash)
        AND NOT EXISTS (SELECT 1 FROM conversation_result_content_refs r WHERE r.account_id = conversation_turn_bodies.account_id AND r.body_hash = conversation_turn_bodies.body_hash)
        AND NOT EXISTS (SELECT 1 FROM conversation_derived_content d WHERE d.account_id = conversation_turn_bodies.account_id AND d.body_hash = conversation_turn_bodies.body_hash)`)
        .run(accountId);
      // `observation_dirty_*` triggers re-queue projection work for every
      // sub-task and dispatch row this transaction touched, so the erasure has
      // to clear that queue last. Otherwise the activity projector wakes every
      // 100ms for a Conversation that no longer exists and fails forever.
      this.db.prepare(`DELETE FROM conversation_activity_dirty WHERE task_id IN
        (SELECT id FROM tasks WHERE account_id = ? AND conversation_id = ?)`)
        .run(accountId, conversationId);
      this.db.prepare(`DELETE FROM conversation_activity_views WHERE task_id IN
        (SELECT id FROM tasks WHERE account_id = ? AND conversation_id = ?)`)
        .run(accountId, conversationId);
      this.db.prepare(`UPDATE task_state_projection_outbox
        SET dispatched_at = COALESCE(dispatched_at, datetime('now')), detail_json = '{}'
        WHERE task_id IN (SELECT id FROM tasks WHERE account_id = ? AND conversation_id = ?)`)
        .run(accountId, conversationId);
    }).immediate();
  }
}
