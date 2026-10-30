import type Database from 'better-sqlite3';

/** Schema 62: private Workspace Git and Task-level FIFO delivery. */
export function installWorkspaceGitSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_git_roots (
      workspace_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, canonical_path TEXT NOT NULL UNIQUE,
      repository_path TEXT NOT NULL, integration_path TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('initializing','ready','recovering','failed')),
      main_commit TEXT, delivered_commit TEXT, next_sequence INTEGER NOT NULL DEFAULT 1,
      active_job_id TEXT, row_version INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversation_git_worktrees (
      worktree_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace_git_roots(workspace_id),
      conversation_id TEXT NOT NULL, incarnation INTEGER NOT NULL, branch TEXT NOT NULL, root_path TEXT NOT NULL,
      base_commit TEXT NOT NULL, head_commit TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('creating','idle','executing','awaiting_delivery','conflicted','retained','cleaning','cleaned','failed')),
      owner_task_id TEXT, owner_token TEXT, cleanup_requested_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_live_conversation_worktree ON conversation_git_worktrees(conversation_id) WHERE state <> 'cleaned';
    CREATE UNIQUE INDEX IF NOT EXISTS one_live_conversation_branch ON conversation_git_worktrees(workspace_id, branch) WHERE state <> 'cleaned';
    CREATE TABLE IF NOT EXISTS conversation_execution_bindings (
      task_id TEXT NOT NULL REFERENCES tasks(id), generation_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspace_git_roots(workspace_id), conversation_id TEXT NOT NULL,
      worktree_id TEXT NOT NULL REFERENCES conversation_git_worktrees(worktree_id), incarnation INTEGER NOT NULL,
      user_root TEXT NOT NULL, execution_root TEXT NOT NULL, task_base_commit TEXT NOT NULL,
      binding_fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(task_id,generation_id)
    );
    CREATE TABLE IF NOT EXISTS task_workspace_changes (
      change_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), generation_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspace_git_roots(workspace_id), conversation_id TEXT NOT NULL,
      worktree_id TEXT NOT NULL REFERENCES conversation_git_worktrees(worktree_id),
      base_commit TEXT NOT NULL, result_commit TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('sealing','sealed','held','queued','delivered','abandoned')),
      delivery_policy TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(task_id,generation_id,result_commit)
    );
    CREATE INDEX IF NOT EXISTS conversation_changes ON task_workspace_changes(conversation_id,created_at);
    CREATE TABLE IF NOT EXISTS workspace_merge_jobs (
      job_id TEXT PRIMARY KEY, change_id TEXT NOT NULL UNIQUE REFERENCES task_workspace_changes(change_id),
      request_id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL REFERENCES tasks(id),
      workspace_id TEXT NOT NULL REFERENCES workspace_git_roots(workspace_id), conversation_id TEXT NOT NULL,
      source_commit TEXT NOT NULL, sequence INTEGER NOT NULL, expected_main TEXT, external_commit TEXT, merged_commit TEXT,
      state TEXT NOT NULL CHECK(state IN ('queued','preparing','merging','conflicted','writing','recovering','delivered','cancelled')),
      conflict_version INTEGER NOT NULL DEFAULT 0, cancel_requested INTEGER NOT NULL DEFAULT 0,
      operation_id TEXT NOT NULL, row_version INTEGER NOT NULL DEFAULT 0, error TEXT,
      queued_at TEXT NOT NULL, merge_started_at TEXT, delivered_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(workspace_id,sequence)
    );
    CREATE INDEX IF NOT EXISTS workspace_merge_queue ON workspace_merge_jobs(workspace_id,sequence);
    CREATE TABLE IF NOT EXISTS workspace_merge_files (
      job_id TEXT NOT NULL REFERENCES workspace_merge_jobs(job_id), ordinal INTEGER NOT NULL,
      relative_path TEXT NOT NULL, operation TEXT NOT NULL,
      before_kind TEXT, before_blob TEXT, before_mode TEXT, after_kind TEXT, after_blob TEXT, after_mode TEXT,
      before_sha256 TEXT, after_sha256 TEXT,
      state TEXT NOT NULL CHECK(state IN ('pending','prepared','applied','conflicted')),
      backup_blob TEXT, last_error TEXT, PRIMARY KEY(job_id,ordinal), UNIQUE(job_id,relative_path)
    );
    CREATE INDEX IF NOT EXISTS pending_writeback_files ON workspace_merge_files(job_id,state,ordinal);
    CREATE TABLE IF NOT EXISTS workspace_git_operations (
      operation_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL REFERENCES workspace_git_roots(workspace_id), conversation_id TEXT,
      kind TEXT NOT NULL, owner_token TEXT, owner_process TEXT,
      state TEXT NOT NULL CHECK(state IN ('prepared','applying','applied','needs_recovery')),
      expected_ref TEXT, target_commit TEXT, payload_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS workspace_git_unfinished_operations ON workspace_git_operations(state,updated_at);
    CREATE TABLE IF NOT EXISTS service_git_worktrees (
      service_worktree_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace_git_roots(workspace_id),
      service_id TEXT NOT NULL, source_task_id TEXT REFERENCES tasks(id), source_commit TEXT NOT NULL,
      project_path TEXT NOT NULL, root_path TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('preparing','ready','running','stopped','retained','cleaning','cleaned','failed')),
      process_token TEXT, runtime_dirty INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(workspace_id,service_id,source_commit)
    );
  `);
  const add = (table: string, column: string, type: string) => {
    const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (columns.length && !columns.some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  };
  for (const [column, type] of [['worktree_id','TEXT'],['worktree_incarnation','INTEGER'],['before_commit','TEXT'],['after_commit','TEXT']]) add('executor_attempt_runtime', column, type);
  for (const column of ['source_commit','source_task_id','operation_task_id','project_path','service_worktree_id']) add('managed_local_services', column, 'TEXT');
  for (const column of ['git_commit','git_relative_path']) add('artifact_versions', column, 'TEXT');
}
