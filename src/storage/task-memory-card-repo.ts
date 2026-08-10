import type Database from 'better-sqlite3';
import type { TaskSearchIndexRepo } from './task-search-index-repo.js';

interface TaskMemoryCardRow {
  id: string;
  task_id: string;
  title: string;
  goal: string;
  summary: string;
  key_decisions_json: string;
  changed_files_json: string;
  verification_commands_json: string;
  pitfalls_json: string;
  artifacts_json: string;
  outcome: TaskMemoryCardOutcome;
  source_candidate_id: string | null;
  created_at: string;
  updated_at: string;
}

export type TaskMemoryCardOutcome = 'success' | 'failed' | 'partial' | 'blocked';

export interface TaskMemoryCardRecord {
  id: string;
  taskId: string;
  title: string;
  goal: string;
  summary: string;
  keyDecisions: string[];
  changedFiles: string[];
  verificationCommands: string[];
  pitfalls: string[];
  artifacts: string[];
  outcome: TaskMemoryCardOutcome;
  sourceCandidateId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskMemoryCardInsert extends TaskMemoryCardRecord {}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value || '[]') as unknown;
  return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
}

function rowToTaskMemoryCard(row: TaskMemoryCardRow): TaskMemoryCardRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    title: row.title,
    goal: row.goal,
    summary: row.summary,
    keyDecisions: parseStringArray(row.key_decisions_json),
    changedFiles: parseStringArray(row.changed_files_json),
    verificationCommands: parseStringArray(row.verification_commands_json),
    pitfalls: parseStringArray(row.pitfalls_json),
    artifacts: parseStringArray(row.artifacts_json),
    outcome: row.outcome,
    sourceCandidateId: row.source_candidate_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TaskMemoryCardRepo {
  constructor(
    private readonly db: Database.Database,
    private readonly taskSearchIndexRepo?: TaskSearchIndexRepo,
  ) {}

  insert(record: TaskMemoryCardInsert): void {
    this.db.prepare(`
      INSERT INTO task_memory_cards (
        id, task_id, title, goal, summary, key_decisions_json, changed_files_json,
        verification_commands_json, pitfalls_json, artifacts_json, outcome,
        source_candidate_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        title = excluded.title,
        goal = excluded.goal,
        summary = excluded.summary,
        key_decisions_json = excluded.key_decisions_json,
        changed_files_json = excluded.changed_files_json,
        verification_commands_json = excluded.verification_commands_json,
        pitfalls_json = excluded.pitfalls_json,
        artifacts_json = excluded.artifacts_json,
        outcome = excluded.outcome,
        source_candidate_id = excluded.source_candidate_id,
        updated_at = excluded.updated_at
    `).run(
      record.id,
      record.taskId,
      record.title,
      record.goal,
      record.summary,
      JSON.stringify(record.keyDecisions),
      JSON.stringify(record.changedFiles),
      JSON.stringify(record.verificationCommands),
      JSON.stringify(record.pitfalls),
      JSON.stringify(record.artifacts),
      record.outcome,
      record.sourceCandidateId,
      record.createdAt,
      record.updatedAt,
    );
    this.taskSearchIndexRepo?.indexMemoryCard(record);
  }

  findByTaskId(taskId: string): TaskMemoryCardRecord | null {
    const row = this.db.prepare('SELECT * FROM task_memory_cards WHERE task_id = ?').get(taskId) as TaskMemoryCardRow | undefined;
    return row ? rowToTaskMemoryCard(row) : null;
  }

  listRecent(limit = 10): TaskMemoryCardRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM task_memory_cards
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit) as TaskMemoryCardRow[];
    return rows.map(rowToTaskMemoryCard);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM task_memory_cards').get() as { count: number };
    return row.count;
  }
}
