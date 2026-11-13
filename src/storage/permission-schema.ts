import type Database from 'better-sqlite3';

export function ensurePermissionResolutionSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS permission_resolutions (
    request_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    subtask_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    resolution TEXT NOT NULL CHECK(resolution IN ('approve', 'deny')),
    source TEXT NOT NULL CHECK(source IN ('command', 'button', 'planner')),
    planner_plan_id TEXT,
    created_at TEXT NOT NULL
  );
CREATE INDEX IF NOT EXISTS permission_resolutions_session
    ON permission_resolutions(session_id, created_at, request_id);`);
}

export function ensurePermissionWorkSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS permission_work_items (
    event_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK(event_type IN ('permission_requested', 'permission_resolution_received')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'processed')),
    processing_started_at TEXT,
    processed_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
CREATE INDEX IF NOT EXISTS permission_work_items_ready
    ON permission_work_items(status, created_at, event_id);
CREATE INDEX IF NOT EXISTS permission_work_items_request
    ON permission_work_items(request_id, event_type, status);`);
}
