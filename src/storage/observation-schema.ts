import { CONVERSATION_SEARCH_SCHEMA_SQL } from './conversation-history-search-repo.js';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { NOTIFICATION_ROUTING_SCHEMA_SQL } from './notification-routing-repo.js';
import { CLIENT_ACTION_REFERENCE_SCHEMA_SQL } from './client-action-reference-repo.js';
/** Rebuildable, sanitized Gateway read models; source facts remain authoritative. */
export const OBSERVATION_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS conversation_observation_identity (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), id TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS conversation_read_history_dirty (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(account_id, conversation_id, turn_id)
  );
  CREATE TABLE IF NOT EXISTS conversation_read_tombstones (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    PRIMARY KEY(account_id, conversation_id, turn_id)
  );
  CREATE TABLE IF NOT EXISTS client_navigation (
    account_id TEXT NOT NULL, principal_id TEXT NOT NULL, platform TEXT NOT NULL,
    channel_id TEXT NOT NULL, thread_id TEXT NOT NULL, workspace_id TEXT, conversation_id TEXT,
    PRIMARY KEY(account_id, principal_id, platform, channel_id, thread_id)
  );
  CREATE TABLE IF NOT EXISTS conversation_activity_views (
    task_id TEXT PRIMARY KEY, body_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conversation_activity_dirty (
    task_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS conversation_read_history_checkpoint (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, sequence INTEGER NOT NULL,
    PRIMARY KEY (account_id, conversation_id)
  );
  CREATE TABLE IF NOT EXISTS conversation_read_heads (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, epoch TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0, journal_sequence INTEGER NOT NULL DEFAULT 0, projector_version INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (account_id, conversation_id)
  );
  CREATE TABLE IF NOT EXISTS conversation_read_rebuilds (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, epoch TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0, journal_sequence INTEGER NOT NULL DEFAULT 0,
    history_sequence INTEGER NOT NULL DEFAULT 0, source_history_revision TEXT NOT NULL, projector_version INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (account_id, conversation_id)
  );
  CREATE TABLE IF NOT EXISTS conversation_read_turns (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, epoch TEXT NOT NULL, turn_id TEXT NOT NULL,
    first_sequence INTEGER NOT NULL, revision INTEGER NOT NULL, active INTEGER NOT NULL,
    body_json TEXT NOT NULL, byte_length INTEGER NOT NULL,
    PRIMARY KEY (account_id, conversation_id, epoch, turn_id)
  );
  CREATE INDEX IF NOT EXISTS conversation_read_turn_page ON conversation_read_turns
    (account_id, conversation_id, epoch, first_sequence DESC, turn_id DESC);
  CREATE INDEX IF NOT EXISTS conversation_read_task_turn ON conversation_read_turns
    (account_id, conversation_id, epoch, json_extract(body_json, '$.taskId'));
  CREATE INDEX IF NOT EXISTS conversation_read_answer_ref ON conversation_read_turns
    (account_id, conversation_id, json_extract(body_json, '$.answerRef.hash'));
  CREATE INDEX IF NOT EXISTS conversation_read_input_ref ON conversation_read_turns
    (account_id, conversation_id, json_extract(body_json, '$.userInputRef.hash'));
  CREATE INDEX IF NOT EXISTS conversation_read_active_turn_page ON conversation_read_turns
    (account_id, conversation_id, epoch, active, first_sequence DESC, turn_id DESC);
  CREATE TABLE IF NOT EXISTS conversation_read_changes (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, epoch TEXT NOT NULL, revision INTEGER NOT NULL,
    body_json TEXT NOT NULL, byte_length INTEGER NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, conversation_id, epoch, revision)
  );
  CREATE INDEX IF NOT EXISTS conversation_read_changes_age ON conversation_read_changes
    (account_id, created_at);
  CREATE INDEX IF NOT EXISTS conversation_read_changes_answer ON conversation_read_changes
    (account_id, conversation_id, json_extract(body_json, '$.answerRef.hash'));
  CREATE INDEX IF NOT EXISTS conversation_read_changes_input ON conversation_read_changes
    (account_id, conversation_id, json_extract(body_json, '$.userInputRef.hash'));
  CREATE TABLE IF NOT EXISTS conversation_read_bodies (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, hash TEXT NOT NULL,
    body BLOB NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (account_id, conversation_id, hash)
  );
  CREATE TABLE IF NOT EXISTS conversation_read_content_chunks (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, hash TEXT NOT NULL,
    byte_offset INTEGER NOT NULL, body BLOB NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (account_id, conversation_id, hash, byte_offset)
  );
  CREATE TABLE IF NOT EXISTS conversation_read_content_manifests (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, hash TEXT NOT NULL, byte_length INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (account_id, conversation_id, hash)
  );
  CREATE INDEX IF NOT EXISTS conversation_read_bodies_gc ON conversation_read_bodies(account_id, conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS conversation_read_chunks_gc ON conversation_read_content_chunks(account_id, conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS conversation_read_manifests_gc ON conversation_read_content_manifests(account_id, conversation_id, created_at);
  CREATE TABLE IF NOT EXISTS gateway_trace_read_heads (
    account_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    indexed_through INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, conversation_id)
  );
  CREATE TABLE IF NOT EXISTS gateway_trace_read_events (
    account_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    gateway_sequence INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    event_key TEXT NOT NULL,
    body_json TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    PRIMARY KEY (account_id, conversation_id, turn_id, event_id)
  );
  CREATE INDEX IF NOT EXISTS gateway_trace_read_page ON gateway_trace_read_events
    (account_id, conversation_id, turn_id, sequence, event_key, event_id);
`;

/** Source writes invalidate presentation transactionally; background Shell code owns projection. */
export function installObservationSchema(db: Database.Database): void {
  db.exec(OBSERVATION_SCHEMA_SQL);
  db.exec(CONVERSATION_SEARCH_SCHEMA_SQL);
  for (const table of ['conversation_read_bodies', 'conversation_read_content_manifests']) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS search_enqueue_${table} AFTER INSERT ON ${table} BEGIN
      INSERT OR IGNORE INTO conversation_content_search_queue(account_id, conversation_id, hash)
        VALUES (NEW.account_id, NEW.conversation_id, NEW.hash);
    END;
    CREATE TRIGGER IF NOT EXISTS search_remove_${table} AFTER DELETE ON ${table} BEGIN
      DELETE FROM conversation_content_search WHERE rowid IN (
        SELECT search_rowid FROM conversation_content_search_chunks
        WHERE account_id = OLD.account_id AND conversation_id = OLD.conversation_id AND hash = OLD.hash);
      DELETE FROM conversation_content_search_chunks
        WHERE account_id = OLD.account_id AND conversation_id = OLD.conversation_id AND hash = OLD.hash;
      DELETE FROM conversation_content_search_queue
        WHERE account_id = OLD.account_id AND conversation_id = OLD.conversation_id AND hash = OLD.hash;
    END`);
  }
  db.prepare('INSERT OR IGNORE INTO conversation_observation_identity(singleton, id) VALUES (1, ?)').run(randomUUID());
  db.exec(NOTIFICATION_ROUTING_SCHEMA_SQL);
  db.exec(CLIENT_ACTION_REFERENCE_SCHEMA_SQL);
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name));
  if (tables.has('conversation_history_turns')) for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
    const ref = operation === 'DELETE' ? 'OLD' : 'NEW';
    db.exec(`CREATE TRIGGER IF NOT EXISTS observation_history_${operation.toLowerCase()}
      AFTER ${operation} ON conversation_history_turns WHEN ${ref}.kind = 'conversation' BEGIN
        INSERT INTO conversation_read_history_dirty(account_id, conversation_id, turn_id)
        VALUES (${ref}.account_id, ${ref}.conversation_id, ${ref}.turn_id)
        ON CONFLICT(account_id, conversation_id, turn_id) DO UPDATE SET version = version + 1;
        ${operation === 'DELETE' ? `INSERT OR IGNORE INTO conversation_read_tombstones VALUES (OLD.account_id, OLD.conversation_id, OLD.turn_id);`
          : `DELETE FROM conversation_read_tombstones WHERE account_id = NEW.account_id AND conversation_id = NEW.conversation_id AND turn_id = NEW.turn_id;`}
      END`);
  }
  if (tables.has('permission_requests')) db.exec('CREATE INDEX IF NOT EXISTS permission_pending_page ON permission_requests(status, id, decision_id)');
  if (!tables.has('tasks')) return;
  const taskColumns = new Set((db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map(row => row.name));
  if (!['account_id', 'conversation_id', 'status'].every(column => taskColumns.has(column))) return;
  for (const [table, columns] of [
    ['kernel_dispatch_items', 'task_id, status'],
    ['generation_replan_requests', 'task_id, status'],
    ['workspace_publications', 'task_id, status'],
    ['retry_wakes', 'task_id, status, resume_at DESC'],
    ['kernel_decisions', 'task_id, id'],
  ]) if (tables.has(table!)) db.exec(`CREATE INDEX IF NOT EXISTS observation_witness_${table} ON ${table}(${columns})`);
  db.exec(`CREATE INDEX IF NOT EXISTS conversation_activity_tasks ON tasks(account_id, conversation_id, id)
    WHERE status IN ('created', 'ready', 'running', 'parked', 'blocked')`);
  for (const table of ['tasks', 'subtasks', 'kernel_dispatch_items', 'executor_attempt_receipts', 'executor_attempt_runtime',
    'work_graph_revisions', 'resource_leases', 'resource_waits', 'conversation_task_slots', 'task_schedule_entries',
    'generation_replan_requests', 'workspace_publications', 'retry_wakes', 'permission_requests', 'kernel_events', 'kernel_decision_applications']) {
    if (!tables.has(table)) continue;
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const ref = operation === 'DELETE' ? 'OLD' : 'NEW';
      const taskId = table === 'executor_attempt_runtime' ? `(SELECT task_id FROM kernel_dispatch_items WHERE attempt_id = ${ref}.attempt_id)`
        : table === 'tasks' ? `${ref}.id` : table === 'conversation_task_slots'
        ? `${ref}.active_task_id` : table === 'kernel_decision_applications'
        ? `(SELECT task_id FROM kernel_decisions WHERE id = ${ref}.decision_id)` : `${ref}.task_id`;
      db.exec(`CREATE TRIGGER IF NOT EXISTS observation_dirty_${table}_${operation.toLowerCase()}
        AFTER ${operation} ON ${table} BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT ${taskId}, 1 WHERE ${taskId} IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END`);
    }
  }
  if (tables.has('conversation_task_slots')) db.exec(`CREATE TRIGGER IF NOT EXISTS observation_released_slot
    AFTER UPDATE OF active_task_id ON conversation_task_slots WHEN OLD.active_task_id IS NOT NULL BEGIN
      INSERT INTO conversation_activity_dirty(task_id, version) VALUES (OLD.active_task_id, 1)
      ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
    END`);
  db.exec(`INSERT OR IGNORE INTO conversation_activity_dirty(task_id)
    SELECT id FROM tasks WHERE status IN ('created', 'ready', 'running', 'parked', 'blocked')`);
}
