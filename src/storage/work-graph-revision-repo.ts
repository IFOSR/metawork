import type Database from 'better-sqlite3';

export type WorkGraphRevisionStatus = 'active' | 'superseded' | 'completed';

export interface WorkGraphRevisionRecord {
  id: string;
  taskId: string;
  revision: number;
  generationId: string;
  authorizedDecisionId: string | null;
  proposalSource: 'initial' | 'replan';
  automaticReplan: boolean;
  status: WorkGraphRevisionStatus;
  createdAt: string;
  updatedAt: string;
}

interface RevisionRow {
  id: string;
  task_id: string;
  revision: number;
  generation_id: string;
  authorized_decision_id: string | null;
  proposal_source: 'initial' | 'replan';
  automatic_replan: number;
  status: WorkGraphRevisionStatus;
  created_at: string;
  updated_at: string;
}

export class WorkGraphRevisionRepo {
  constructor(private readonly db: Database.Database) {}

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  findActive(taskId: string): WorkGraphRevisionRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM work_graph_revisions WHERE task_id = ? AND status = 'active'
    `).get(taskId) as RevisionRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  find(taskId: string, revision: number): WorkGraphRevisionRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM work_graph_revisions WHERE task_id = ? AND revision = ?
    `).get(taskId, revision) as RevisionRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  activate(input: Omit<WorkGraphRevisionRecord, 'status'>): WorkGraphRevisionRecord {
    this.db.prepare(`
      UPDATE work_graph_revisions SET status = 'superseded', updated_at = ?
      WHERE task_id = ? AND status = 'active' AND revision <> ?
    `).run(input.updatedAt, input.taskId, input.revision);
    this.db.prepare(`
      INSERT INTO work_graph_revisions (
        id, task_id, revision, generation_id, authorized_decision_id,
        proposal_source, automatic_replan, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(task_id, revision) DO UPDATE SET
        generation_id = excluded.generation_id,
        authorized_decision_id = excluded.authorized_decision_id,
        proposal_source = excluded.proposal_source,
        automatic_replan = excluded.automatic_replan,
        status = 'active',
        updated_at = excluded.updated_at
    `).run(
      input.id, input.taskId, input.revision, input.generationId,
      input.authorizedDecisionId, input.proposalSource, input.automaticReplan ? 1 : 0,
      input.createdAt, input.updatedAt,
    );
    return this.find(input.taskId, input.revision)!;
  }

  complete(taskId: string, revision: number, now: string): void {
    this.db.prepare(`
      UPDATE work_graph_revisions SET status = 'completed', updated_at = ?
      WHERE task_id = ? AND revision = ? AND status = 'active'
    `).run(now, taskId, revision);
  }

  countAutomaticReplans(taskId: string, generationId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM work_graph_revisions
      WHERE task_id = ? AND generation_id = ? AND automatic_replan = 1
    `).get(taskId, generationId) as { count: number };
    return row.count;
  }
}

function rowToRecord(row: RevisionRow): WorkGraphRevisionRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    revision: row.revision,
    generationId: row.generation_id,
    authorizedDecisionId: row.authorized_decision_id,
    proposalSource: row.proposal_source,
    automaticReplan: row.automatic_replan === 1,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
