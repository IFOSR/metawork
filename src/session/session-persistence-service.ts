import { storeDerivedContent } from '../storage/conversation-content-references.js';
// Persists session interaction transcript records behind a small service used
// by conversation and execution flows.
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { generateInteractionId } from '../utils/id.js';

export interface InteractionRecordInput {
  turnId?: string | null;
  conversationId?: string;
  accountId?: string;
  taskId: string | null;
  sessionId: string;
  userInput: string;
  systemOutput: string;
  executorUsed: string;
}

/** Writes session transcript records to SQLite. */
export class SessionPersistenceService {
  constructor(private readonly db: Database.Database) {}

  recordInteraction(input: InteractionRecordInput): void {
    this.db.transaction(() => {
      const scope = input.taskId ? this.db.prepare(`SELECT account_id, conversation_id FROM tasks WHERE id = ?`).get(input.taskId) as
        { account_id: string; conversation_id: string | null } | undefined : undefined;
      const turn = input.turnId ? this.db.prepare(`SELECT account_id, conversation_id, turn_id FROM conversation_turns WHERE turn_id = ? AND conversation_id = ?`)
        .get(input.turnId, input.conversationId ?? input.sessionId) as { account_id: string; conversation_id: string; turn_id: string } | undefined : undefined;
      const linked = input.taskId ? this.db.prepare(`SELECT q.turn_id FROM query_task_links l JOIN query_usage_contexts q ON q.query_id = l.query_id
        WHERE l.task_id = ? ORDER BY q.accepted_at DESC LIMIT 1`).get(input.taskId) as { turn_id: string | null } | undefined : undefined;
      const accountId = turn?.account_id ?? scope?.account_id ?? input.accountId;
      const conversationId = turn?.conversation_id ?? scope?.conversation_id ?? input.conversationId;
      const turnId = turn?.turn_id ?? linked?.turn_id ?? input.turnId ?? null;
      const reference = (kind: string, text: string) => accountId && conversationId
        ? storeDerivedContent(this.db, { accountId, conversationId, turnId, kind, text }) : null;
      const inputRef = reference('task_instruction', input.userInput);
      const outputRef = reference('interaction_output', input.systemOutput);
      const id = turnId && inputRef && outputRef
        ? `int_${createHash('sha256').update(JSON.stringify([accountId, conversationId, turnId,
          input.taskId, input.executorUsed, inputRef, outputRef])).digest('hex')}` : generateInteractionId();
      this.db.prepare(`INSERT OR IGNORE INTO interactions(id, task_id, session_id, user_input, system_output, executor_used, created_at,
        input_content_ref, output_content_ref, derived_from_turn_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.taskId, input.sessionId, inputRef ? null : input.userInput,
          outputRef ? null : input.systemOutput, input.executorUsed, new Date().toISOString(), inputRef, outputRef, turnId);
    }).immediate();
  }
}
