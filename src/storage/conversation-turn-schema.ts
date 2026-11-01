import type Database from 'better-sqlite3';
/** Authoritative bodies are independent of every projection epoch and its GC. */
export const CONVERSATION_TURN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversation_turn_bodies (
  account_id TEXT NOT NULL, body_hash TEXT NOT NULL, body BLOB NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length >= 0), format TEXT NOT NULL DEFAULT 'text/plain',
  created_at TEXT NOT NULL, PRIMARY KEY(account_id, body_hash)
);
CREATE TABLE IF NOT EXISTS conversation_turns (
  account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  sequence INTEGER NOT NULL, request_key TEXT NOT NULL, user_input_hash TEXT NOT NULL,
  final_answer_revision INTEGER, created_at TEXT NOT NULL,
  PRIMARY KEY(account_id, conversation_id, turn_id),
  UNIQUE(account_id, conversation_id, sequence), UNIQUE(account_id, conversation_id, request_key),
  FOREIGN KEY(account_id, user_input_hash) REFERENCES conversation_turn_bodies(account_id, body_hash)
);
CREATE TABLE IF NOT EXISTS conversation_turn_answers (
  account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  revision INTEGER NOT NULL, revision_key TEXT NOT NULL, body_hash TEXT NOT NULL,
  source_task_id TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY(account_id, conversation_id, turn_id, revision),
  UNIQUE(account_id, conversation_id, turn_id, revision_key),
  FOREIGN KEY(account_id, conversation_id, turn_id) REFERENCES conversation_turns(account_id, conversation_id, turn_id) ON DELETE CASCADE,
  FOREIGN KEY(account_id, body_hash) REFERENCES conversation_turn_bodies(account_id, body_hash)
);
CREATE TABLE IF NOT EXISTS conversation_turn_outbox (
  account_id TEXT NOT NULL, event_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  event_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(account_id, event_id)
);
CREATE TABLE IF NOT EXISTS conversation_deletions (
  account_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','completed')), created_at TEXT NOT NULL,
  PRIMARY KEY(account_id, conversation_id)
);
CREATE TABLE IF NOT EXISTS conversation_turn_migration (
  account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  classification TEXT NOT NULL, evidence_json TEXT NOT NULL,
  PRIMARY KEY(account_id, conversation_id, turn_id)
);
CREATE TABLE IF NOT EXISTS conversation_derived_content (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  derived_from_turn_id TEXT, kind TEXT NOT NULL, body_hash TEXT NOT NULL,
  FOREIGN KEY(account_id, body_hash) REFERENCES conversation_turn_bodies(account_id, body_hash)
);
CREATE TABLE IF NOT EXISTS conversation_result_content_refs (
  result_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, body_hash TEXT NOT NULL,
  FOREIGN KEY(account_id, body_hash) REFERENCES conversation_turn_bodies(account_id, body_hash)
);
CREATE TABLE IF NOT EXISTS conversation_memory_attempts (
  account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, started_at TEXT NOT NULL,
  PRIMARY KEY(account_id, conversation_id)
);
CREATE TABLE IF NOT EXISTS planner_transcript_turns (
  account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  planner_session_id TEXT NOT NULL, input_hash TEXT NOT NULL, transcript_hash TEXT NOT NULL,
  integrity TEXT NOT NULL CHECK(integrity IN ('match','derived')), created_at TEXT NOT NULL,
  PRIMARY KEY(account_id, conversation_id, turn_id, planner_session_id)
);
CREATE TABLE IF NOT EXISTS conversation_memory_receipts (
  account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  input_hash TEXT NOT NULL, answer_hash TEXT NOT NULL, acknowledged_at TEXT NOT NULL,
  PRIMARY KEY(account_id, conversation_id, turn_id, input_hash, answer_hash)
);
CREATE VIEW IF NOT EXISTS conversation_memory_turns AS
SELECT t.account_id, t.conversation_id, t.turn_id, t.sequence AS first_sequence,
  t.user_input_hash AS input_hash, a.body_hash AS answer_hash,
  EXISTS (SELECT 1 FROM conversation_memory_receipts r WHERE r.account_id = t.account_id
    AND r.conversation_id = t.conversation_id AND r.turn_id = t.turn_id
    AND r.input_hash = t.user_input_hash AND r.answer_hash = a.body_hash) AS deposited,
  json_set(h.body_json, '$.interactionKind', COALESCE(json_extract(h.body_json, '$.interactionKind'), 'ai_turn'),
    '$.status', CASE task.status WHEN 'succeeded' THEN 'completed' WHEN 'needs_action' THEN 'blocked'
      WHEN 'failed' THEN 'failed' WHEN 'cancelled' THEN 'cancelled' WHEN 'running' THEN 'running'
      WHEN 'queued' THEN 'running' WHEN 'pending' THEN 'running' ELSE json_extract(h.body_json, '$.status') END,
    '$.startedAt', t.created_at, '$.completedAt', COALESCE(a.created_at, t.created_at), '$.id', t.turn_id) AS body_json
FROM conversation_turns t JOIN conversation_history_turns h
  ON h.account_id = t.account_id AND h.conversation_id = t.conversation_id AND h.turn_id = t.turn_id AND h.kind = 'conversation'
LEFT JOIN conversation_turn_answers a ON a.account_id = t.account_id AND a.conversation_id = t.conversation_id
  AND a.turn_id = t.turn_id AND a.revision = t.final_answer_revision
LEFT JOIN tasks task ON task.id = COALESCE(a.source_task_id, json_extract(h.body_json, '$.taskId'))
  AND task.account_id = t.account_id AND task.conversation_id = t.conversation_id
WHERE NOT EXISTS (SELECT 1 FROM conversation_deletions d WHERE d.account_id = t.account_id AND d.conversation_id = t.conversation_id);
`;

export function installConversationContentReferences(db: Database.Database): void {
  const exists = (table: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  if (!exists('interactions')) return;
  const columns = (db.prepare('PRAGMA table_info(interactions)').all() as { name: string }[]).map(c => c.name);
  for (const column of ['input_content_ref', 'output_content_ref', 'derived_from_turn_id']) {
    if (!columns.includes(column)) db.exec(`ALTER TABLE interactions ADD COLUMN ${column} TEXT`);
  }
  const evidenceColumns = (db.prepare('PRAGMA table_info(task_execution_evidence)').all() as { name: string }[]).map(c => c.name);
  if (exists('task_execution_evidence') && !evidenceColumns.includes('content_ref')) db.exec('ALTER TABLE task_execution_evidence ADD COLUMN content_ref TEXT');
  const proposalColumns = (db.prepare('PRAGMA table_info(planner_proposal_turns)').all() as { name: string }[]).map(c => c.name);
  if (exists('planner_proposal_turns') && !proposalColumns.includes('input_hash')) db.exec('ALTER TABLE planner_proposal_turns ADD COLUMN input_hash TEXT');
  if (exists('planner_proposal_turns') && !proposalColumns.includes('source_turn_id')) db.exec('ALTER TABLE planner_proposal_turns ADD COLUMN source_turn_id TEXT');
  db.exec(`CREATE VIEW IF NOT EXISTS interaction_contents AS
    SELECT i.id, i.task_id, i.session_id, i.executor_used, i.created_at, i.derived_from_turn_id, ir.kind AS input_kind,
      CASE WHEN i.input_content_ref IS NULL THEN i.user_input ELSE CAST(ib.body AS TEXT) END AS user_input,
      CASE WHEN i.output_content_ref IS NULL THEN i.system_output ELSE CAST(ob.body AS TEXT) END AS system_output
    FROM interactions i
    LEFT JOIN conversation_derived_content ir ON ir.id = i.input_content_ref
    LEFT JOIN conversation_turn_bodies ib ON ib.account_id = ir.account_id AND ib.body_hash = ir.body_hash
    LEFT JOIN conversation_derived_content ore ON ore.id = i.output_content_ref
    LEFT JOIN conversation_turn_bodies ob ON ob.account_id = ore.account_id AND ob.body_hash = ore.body_hash;
    DROP TRIGGER IF EXISTS trg_task_search_index_interactions_insert;
    CREATE TRIGGER trg_task_search_index_interactions_insert AFTER INSERT ON interactions WHEN NEW.task_id IS NOT NULL BEGIN
      DELETE FROM task_search_index WHERE source_kind = 'interaction' AND source_id = NEW.id;
      INSERT INTO task_search_index(task_id, source_kind, source_id, title, body, tags, created_at, updated_at)
      SELECT task_id, 'interaction', id, '', substr(COALESCE(user_input,'') || char(10) || COALESCE(system_output,''), 1, 4000),
        'interaction', created_at, created_at FROM interaction_contents WHERE id = NEW.id;
    END;`);
}
