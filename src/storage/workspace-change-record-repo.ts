import type Database from 'better-sqlite3';

export type WorkspaceChangeCoverage = 'complete' | 'partial' | 'unavailable';

export interface WorkspaceChangedFileSummary {
  /** Workspace-relative path (slash separated), or an absolute path outside the Workspace. */
  path: string;
  added: number;
  deleted: number;
  binary?: true;
  scratch?: true;
}

export interface WorkspaceChangeRecord {
  recordId: string;
  taskId: string;
  generationId: string | null;
  subtaskId: string | null;
  attemptId: string | null;
  conversationId: string | null;
  workspaceId: string;
  userTurnId: string | null;
  beforeTree: string | null;
  afterTree: string | null;
  files: WorkspaceChangedFileSummary[];
  totalFiles: number;
  addedLines: number;
  deletedLines: number;
  coverage: WorkspaceChangeCoverage;
  missingReasons: string[];
  createdAt: string;
}

interface ChangeRecordRow {
  record_id: string;
  task_id: string;
  generation_id: string | null;
  subtask_id: string | null;
  attempt_id: string | null;
  conversation_id: string | null;
  workspace_id: string;
  user_turn_id: string | null;
  before_tree: string | null;
  after_tree: string | null;
  files_json: string;
  total_files: number;
  added_lines: number;
  deleted_lines: number;
  coverage: WorkspaceChangeCoverage;
  missing_reasons_json: string;
  created_at: string;
}

function recordFromRow(row: ChangeRecordRow): WorkspaceChangeRecord {
  return {
    recordId: row.record_id,
    taskId: row.task_id,
    generationId: row.generation_id,
    subtaskId: row.subtask_id,
    attemptId: row.attempt_id,
    conversationId: row.conversation_id,
    workspaceId: row.workspace_id,
    userTurnId: row.user_turn_id,
    beforeTree: row.before_tree,
    afterTree: row.after_tree,
    files: JSON.parse(row.files_json) as WorkspaceChangedFileSummary[],
    totalFiles: row.total_files,
    addedLines: row.added_lines,
    deletedLines: row.deleted_lines,
    coverage: row.coverage,
    missingReasons: JSON.parse(row.missing_reasons_json) as string[],
    createdAt: row.created_at,
  };
}

/** Durable "what changed this round" facts. Coverage degrades; the record never blocks completion. */
export class WorkspaceChangeRecordRepo {
  constructor(private readonly db: Database.Database) {}

  /** Idempotent by recordId so a retried flush cannot duplicate a round. */
  insert(record: WorkspaceChangeRecord): WorkspaceChangeRecord {
    this.db.prepare(`
      INSERT OR IGNORE INTO workspace_change_records (
        record_id, task_id, generation_id, subtask_id, attempt_id, conversation_id,
        workspace_id, user_turn_id, before_tree, after_tree, files_json, total_files,
        added_lines, deleted_lines, coverage, missing_reasons_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.recordId,
      record.taskId,
      record.generationId,
      record.subtaskId,
      record.attemptId,
      record.conversationId,
      record.workspaceId,
      record.userTurnId,
      record.beforeTree,
      record.afterTree,
      JSON.stringify(record.files),
      record.totalFiles,
      record.addedLines,
      record.deletedLines,
      record.coverage,
      JSON.stringify(record.missingReasons),
      record.createdAt,
    );
    return this.find(record.recordId) ?? record;
  }

  find(recordId: string): WorkspaceChangeRecord | null {
    const row = this.db.prepare('SELECT * FROM workspace_change_records WHERE record_id = ?')
      .get(recordId) as ChangeRecordRow | undefined;
    return row ? recordFromRow(row) : null;
  }

  findByAttempt(attemptId: string): WorkspaceChangeRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM workspace_change_records WHERE attempt_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(attemptId) as ChangeRecordRow | undefined;
    return row ? recordFromRow(row) : null;
  }

  listByTask(taskId: string, limit = 20): WorkspaceChangeRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM workspace_change_records WHERE task_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(taskId, limit) as ChangeRecordRow[];
    return rows.map(recordFromRow);
  }
}
