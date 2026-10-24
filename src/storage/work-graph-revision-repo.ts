import type Database from 'better-sqlite3';
import type { CompletionRequirementSpec } from '../task/task-state-facts.js';
import { parseCompletionRequirements } from '../task/task-completion-requirements.js';

export type WorkGraphRevisionStatus = 'active' | 'superseded' | 'completed';

export interface WorkGraphRevisionRecord {
  id: string;
  taskId: string;
  revision: number;
  generationId: string;
  configurationRevision: string;
  authorizedDecisionId: string | null;
  proposalSource: 'initial' | 'replan' | 'conflict_replan';
  automaticReplan: boolean;
  status: WorkGraphRevisionStatus;
  completionKind: 'full' | 'partial_accepted' | null;
  /** Requirement snapshot compiled when this revision was authorized. */
  completionRequirements: CompletionRequirementSpec[];
  createdAt: string;
  updatedAt: string;
}

interface RevisionRow {
  id: string;
  task_id: string;
  revision: number;
  generation_id: string;
  configuration_revision: string;
  authorized_decision_id: string | null;
  proposal_source: 'initial' | 'replan' | 'conflict_replan';
  automatic_replan: number;
  status: WorkGraphRevisionStatus;
  completion_kind: 'full' | 'partial_accepted' | null;
  completion_requirements_json: string | null;
  created_at: string;
  updated_at: string;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

export class WorkGraphRevisionRepo {
  constructor(private readonly db: Database.Database) {}

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation).immediate();
  }

  findActive(taskId: string): WorkGraphRevisionRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM work_graph_revisions WHERE task_id = ? AND status = 'active'
    `).get(taskId) as RevisionRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /** Most recent revision, used after a Task's graph is completed. */
  findLatest(taskId: string): WorkGraphRevisionRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM work_graph_revisions WHERE task_id = ?
      ORDER BY revision DESC LIMIT 1
    `).get(taskId) as RevisionRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  find(taskId: string, revision: number): WorkGraphRevisionRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM work_graph_revisions WHERE task_id = ? AND revision = ?
    `).get(taskId, revision) as RevisionRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  activate(
    input: Omit<
      WorkGraphRevisionRecord,
      'status' | 'completionKind' | 'completionRequirements'
    > & { completionRequirements?: CompletionRequirementSpec[] },
  ): WorkGraphRevisionRecord {
    const existing = this.find(input.taskId, input.revision);
    if (
      existing
      && (
        existing.generationId !== input.generationId
        || existing.configurationRevision !== input.configurationRevision
      )
    ) {
      throw new Error(
        `persisted Work Graph revision identity mismatch: ${input.taskId}/${input.revision}`,
      );
    }
    this.db.prepare(`
      UPDATE work_graph_revisions SET status = 'superseded', updated_at = ?
      WHERE task_id = ? AND status = 'active' AND revision <> ?
    `).run(input.updatedAt, input.taskId, input.revision);
    this.db.prepare(`
      INSERT INTO work_graph_revisions (
        id, task_id, revision, generation_id, configuration_revision, authorized_decision_id,
        proposal_source, automatic_replan, status, created_at, updated_at,
        completion_requirements_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      ON CONFLICT(task_id, revision) DO UPDATE SET
        generation_id = excluded.generation_id,
        configuration_revision = excluded.configuration_revision,
        authorized_decision_id = excluded.authorized_decision_id,
        proposal_source = excluded.proposal_source,
        automatic_replan = excluded.automatic_replan,
        status = 'active',
        updated_at = excluded.updated_at,
        completion_requirements_json = excluded.completion_requirements_json
    `).run(
      input.id, input.taskId, input.revision, input.generationId, input.configurationRevision,
      input.authorizedDecisionId, input.proposalSource, input.automaticReplan ? 1 : 0,
      input.createdAt, input.updatedAt, JSON.stringify(input.completionRequirements ?? []),
    );
    return this.find(input.taskId, input.revision)!;
  }

  /**
   * Records the requirement snapshot for an already-activated revision. It runs
   * in the same transaction as activation and Subtask materialization, so the
   * snapshot always references the persisted canonical Subtask ids.
   */
  setCompletionRequirements(
    taskId: string,
    revision: number,
    requirements: CompletionRequirementSpec[],
  ): void {
    this.db.prepare(`
      UPDATE work_graph_revisions SET completion_requirements_json = ?
      WHERE task_id = ? AND revision = ?
    `).run(JSON.stringify(requirements), taskId, revision);
  }

  complete(
    taskId: string,
    revision: number,
    now: string,
    completionKind: 'full' | 'partial_accepted' = 'full',
  ): void {
    this.db.prepare(`
      UPDATE work_graph_revisions
      SET status = 'completed', completion_kind = ?, updated_at = ?
      WHERE task_id = ? AND revision = ? AND status = 'active'
    `).run(completionKind, now, taskId, revision);
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
    configurationRevision: row.configuration_revision,
    authorizedDecisionId: row.authorized_decision_id,
    proposalSource: row.proposal_source,
    automaticReplan: row.automatic_replan === 1,
    status: row.status,
    completionKind: row.completion_kind,
    completionRequirements: parseCompletionRequirements(
      row.completion_requirements_json ? safeJson(row.completion_requirements_json) : [],
    ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
