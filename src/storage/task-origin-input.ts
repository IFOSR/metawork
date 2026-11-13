import type Database from 'better-sqlite3';
import { SqliteConversationTurnStore } from './conversation-turn-repo.js';

/** Resolve the original request, including its output constraints, after restart. */
export function readTaskOriginInput(db: Database.Database, input: {
  accountId: string; conversationId: string; taskId: string;
}): { queryId: string; userInput: string } | null {
  const linked = db.prepare(`SELECT q.query_id, q.turn_id
    FROM query_task_links l JOIN query_usage_contexts q ON q.query_id = l.query_id
    JOIN tasks t ON t.id = l.task_id
    WHERE l.task_id = ? AND q.account_id = ? AND q.conversation_id = ?
      AND t.account_id = q.account_id AND t.conversation_id = q.conversation_id
    ORDER BY l.linked_at, l.query_id LIMIT 1`)
    .get(input.taskId, input.accountId, input.conversationId) as { query_id: string; turn_id: string | null } | undefined;
  if (!linked?.turn_id) return null;
  const store = new SqliteConversationTurnStore(db);
  const turn = store.find({ accountId: input.accountId, conversationId: input.conversationId, turnId: linked.turn_id });
  if (!turn) throw new Error('task_origin_turn_unavailable');
  return { queryId: linked.query_id, userInput: store.readBody(input.accountId, turn.input.hash).text };
}
