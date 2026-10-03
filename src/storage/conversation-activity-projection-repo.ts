import type Database from 'better-sqlite3';
import type { ConversationActivityProjectionStore } from '../session/conversation-activity-projection.js';
import type { ConversationActivityTask } from '../session/conversation-activity-source.js';
import type { ConversationTaskSummary } from '../session/conversation-activity-types.js';

export class SqliteConversationActivityProjection implements ConversationActivityProjectionStore {
  constructor(private readonly db: Database.Database,
    private readonly onCommitted?: (taskId: string, value: ConversationTaskSummary) => void) {}
  nextDirty() {
    this.db.transaction(() => {
      const removed = this.db.prepare(`SELECT task_id FROM conversation_activity_dirty
        WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = task_id) LIMIT 64`).all() as Array<{ task_id: string }>;
      for (const row of removed) {
        this.db.prepare('DELETE FROM conversation_activity_views WHERE task_id = ?').run(row.task_id);
        this.db.prepare('DELETE FROM conversation_activity_dirty WHERE task_id = ?').run(row.task_id);
      }
    }).immediate();
    const row = this.db.prepare(`SELECT tasks.id, substr(tasks.title, 1, 160) AS title,
      tasks.status, tasks.updated_at AS updatedAt, dirty.version
      FROM conversation_activity_dirty dirty JOIN tasks ON tasks.id = dirty.task_id
      ORDER BY dirty.rowid LIMIT 1`).get() as (ConversationActivityTask & { version: number }) | undefined;
    if (!row) return null;
    const { version, ...task } = row;
    return { task, version };
  }
  read(taskId: string): ConversationTaskSummary | null {
    const row = this.db.prepare('SELECT body_json FROM conversation_activity_views WHERE task_id = ?')
      .get(taskId) as { body_json: string } | undefined;
    return row ? JSON.parse(row.body_json) as ConversationTaskSummary : null;
  }
  commit(taskId: string, version: number, value: ConversationTaskSummary): void {
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO conversation_activity_views(task_id, body_json) VALUES (?, ?)
        ON CONFLICT(task_id) DO UPDATE SET body_json = excluded.body_json`).run(taskId, JSON.stringify(value));
      this.db.prepare('DELETE FROM conversation_activity_dirty WHERE task_id = ? AND version = ?').run(taskId, version);
      this.onCommitted?.(taskId, value);
    }).immediate();
  }
}
