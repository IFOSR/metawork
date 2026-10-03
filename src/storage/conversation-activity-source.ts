import type Database from 'better-sqlite3';
import type { ConversationActivitySource, ConversationActivityTask } from '../session/conversation-activity-source.js';

export class SqliteConversationActivitySource implements ConversationActivitySource {
  constructor(private readonly db: Database.Database) {}

  latestProgress(taskId: string, generationId: string): string | null {
    const row = this.db.prepare(`SELECT substr(json_extract(runtime.progress_json, '$.text'), 1, 1024) AS text
      FROM kernel_dispatch_items dispatch JOIN executor_attempt_runtime runtime ON runtime.attempt_id = dispatch.attempt_id
      WHERE dispatch.task_id = ? AND dispatch.generation_id = ? ORDER BY runtime.updated_at DESC LIMIT 1`)
      .get(taskId, generationId) as { text: string | null } | undefined;
    return row?.text ?? null;
  }

  page(accountId: string, conversationId: string, cursor?: string, limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('invalid_activity_limit');
    let after = '';
    if (cursor) {
      try {
        if (cursor.length > 2048) throw new Error();
        const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(value) || value.length !== 4 || value[0] !== 1 || value[1] !== accountId
          || value[2] !== conversationId || typeof value[3] !== 'string') throw new Error();
        after = value[3];
      } catch { throw new Error('invalid_activity_cursor'); }
    }
    const rows = this.db.prepare(`SELECT id, substr(title, 1, 160) AS title, status, updated_at AS updatedAt FROM tasks
      WHERE account_id = ? AND conversation_id = ? AND id > ?
        AND status IN ('created', 'ready', 'running', 'parked', 'blocked')
      UNION SELECT id, substr(title, 1, 160) AS title, status, updated_at AS updatedAt FROM tasks
      WHERE account_id = ? AND conversation_id = ? AND id > ?
        AND id = (SELECT active_task_id FROM conversation_task_slots WHERE conversation_id = ?)
      ORDER BY id LIMIT ?`).all(accountId, conversationId, after, accountId, conversationId, after, conversationId, limit + 1) as ConversationActivityTask[];
    const tasks = rows.slice(0, limit);
    return { tasks, nextCursor: rows.length > limit ? Buffer.from(JSON.stringify([1, accountId, conversationId, tasks.at(-1)!.id])).toString('base64url') : null };
  }
}
