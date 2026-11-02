import type Database from 'better-sqlite3';

/** Durable ownership fences outlive lease TTL and are released only after settlement. */
export function installConversationAttemptOwnerSchema(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(subtasks)').all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'workspace_effect')) {
    db.exec("ALTER TABLE subtasks ADD COLUMN workspace_effect TEXT CHECK(workspace_effect IN ('read_only','write','unknown'))");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_attempt_owners (
    conversation_id TEXT NOT NULL,
    token TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL UNIQUE,
    access_mode TEXT NOT NULL CHECK(access_mode IN ('read','write')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS conversation_attempt_owners_conversation
    ON conversation_attempt_owners(conversation_id);`);
}
