import type Database from 'better-sqlite3';
import { notificationFromTurn } from '../delivery/notification-routing.js';
import { SqliteNotificationRoutingStore } from '../storage/notification-routing-repo.js';
import { SqliteConversationReadModel } from '../storage/conversation-read-model-repo.js';

/** Identical transactional derivative hooks in foreground and background composition. */
export function createConversationReadModel(db: Database.Database): SqliteConversationReadModel {
  const notifications = new SqliteNotificationRoutingStore(db);
  return new SqliteConversationReadModel(db, Date.now, (accountId, turn) => {
    const fact = notificationFromTurn(accountId, turn);
    if (fact) notifications.capture(fact, Date.now());
    if (turn.taskId) db.prepare(`INSERT INTO conversation_activity_dirty(task_id, version) VALUES (?, 1)
      ON CONFLICT(task_id) DO UPDATE SET version = version + 1`).run(turn.taskId);
  });
}
