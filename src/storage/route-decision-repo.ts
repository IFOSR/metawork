import type Database from 'better-sqlite3';
import { routeDecisionInputHash, routeSelectionSource, type RouteDecision, type RouteRequest } from '../routing/router.js';

/** Durable append-only Router facts. Runtime owns when to write; this class
 * deliberately has no model or process dependency. */
export class RouteDecisionRepo {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS route_decisions (
        route_decision_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        subtask_id TEXT NOT NULL,
        graph_revision INTEGER NOT NULL,
        attempt_ordinal INTEGER NOT NULL,
        input_snapshot_hash TEXT NOT NULL,
        candidates_json TEXT NOT NULL,
        excluded_json TEXT NOT NULL,
        selected_json TEXT,
        decision_model_json TEXT NOT NULL,
        rationale TEXT NOT NULL,
        configuration_revision TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('selected', 'no_candidate')),
        created_at TEXT NOT NULL,
        UNIQUE(task_id, generation_id, subtask_id, attempt_ordinal)
      );
    `);
  }

  record(input: RouteRequest, decision: RouteDecision, checkCurrent?: () => void): 'inserted' | 'replayed' | 'conflict' {
    if (decision.taskId !== input.taskId || decision.generationId !== input.generationId
      || decision.subtaskId !== input.subtaskId || decision.graphRevision !== input.graphRevision
      || decision.attemptOrdinal !== input.attemptOrdinal || decision.configurationRevision !== input.configurationRevision
      || decision.inputSnapshotHash !== routeDecisionInputHash(input)
      || decision.inputSnapshotHash !== routeDecisionInputHash({ ...input,
        candidates: decision.candidates, excluded: decision.excluded })
      || (decision.outcome === 'selected') !== (decision.selected !== null)
      || (decision.outcome !== 'selected' && decision.outcome !== 'no_candidate')
      || !decision.routeDecisionId || !decision.rationale.trim()
      || !decision.decisionModel.providerRef || !decision.decisionModel.modelRef
      || (decision.selected && !input.candidates.some(candidate => sameCandidate(candidate, decision.selected!)))) {
      throw new Error('route_decision_input_mismatch');
    }
    return this.db.transaction(() => {
      checkCurrent?.();
      return this.recordValidated(input, decision);
    }).immediate();
  }

  private recordValidated(input: RouteRequest, decision: RouteDecision): 'inserted' | 'replayed' | 'conflict' {
    const existing = this.findByAttempt(input.taskId, input.generationId, input.subtaskId, input.attemptOrdinal);
    if (existing) {
      return existing.inputSnapshotHash === decision.inputSnapshotHash
        && existing.graphRevision === decision.graphRevision
        && (existing.selected === null ? decision.selected === null
          : decision.selected !== null && sameCandidate(existing.selected, decision.selected))
        && existing.decisionModel.providerRef === decision.decisionModel.providerRef
        && existing.decisionModel.modelRef === decision.decisionModel.modelRef
        && existing.rationale === decision.rationale
        && existing.configurationRevision === decision.configurationRevision
        && existing.outcome === decision.outcome
        ? 'replayed'
        : 'conflict';
    }
    this.db.prepare(`
      INSERT INTO route_decisions (
        route_decision_id, task_id, generation_id, subtask_id, graph_revision,
        attempt_ordinal, input_snapshot_hash, candidates_json, excluded_json,
        selected_json, decision_model_json, rationale, configuration_revision,
        outcome, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decision.routeDecisionId,
      input.taskId,
      input.generationId,
      input.subtaskId,
      input.graphRevision,
      input.attemptOrdinal,
      decision.inputSnapshotHash,
      JSON.stringify(decision.candidates),
      JSON.stringify(decision.excluded),
      decision.selected ? JSON.stringify(decision.selected) : null,
      JSON.stringify(decision.decisionModel),
      decision.rationale,
      decision.configurationRevision,
      decision.outcome,
      decision.createdAt,
    );
    return 'inserted';
  }

  findById(id: string): RouteDecision | null {
    const row = this.db.prepare('SELECT * FROM route_decisions WHERE route_decision_id = ?').get(id) as RouteRow | undefined;
    return row ? rowToDecision(row) : null;
  }

  findByAttempt(taskId: string, generationId: string, subtaskId: string, attemptOrdinal: number): RouteDecision | null {
    const row = this.db.prepare(`
      SELECT * FROM route_decisions
      WHERE task_id = ? AND generation_id = ? AND subtask_id = ? AND attempt_ordinal = ?
    `).get(taskId, generationId, subtaskId, attemptOrdinal) as RouteRow | undefined;
    return row ? rowToDecision(row) : null;
  }
}

function sameCandidate(left: NonNullable<RouteDecision['selected']>, right: NonNullable<RouteDecision['selected']>): boolean {
  return left.agentClassRef === right.agentClassRef && left.providerRef === right.providerRef
    && left.modelRef === right.modelRef && left.permissionProfileRef === right.permissionProfileRef;
}

interface RouteRow {
  route_decision_id: string;
  task_id: string;
  generation_id: string;
  subtask_id: string;
  graph_revision: number;
  attempt_ordinal: number;
  input_snapshot_hash: string;
  candidates_json: string;
  excluded_json: string;
  selected_json: string | null;
  decision_model_json: string;
  rationale: string;
  configuration_revision: string;
  outcome: RouteDecision['outcome'];
  created_at: string;
}

function rowToDecision(row: RouteRow): RouteDecision {
  const selection = routeSelectionSource({ rationale: row.rationale });
  return {
    routeDecisionId: row.route_decision_id,
    taskId: row.task_id,
    attemptOrdinal: row.attempt_ordinal,
    inputSnapshotHash: row.input_snapshot_hash,
    candidates: JSON.parse(row.candidates_json) as RouteDecision['candidates'],
    excluded: JSON.parse(row.excluded_json) as RouteDecision['excluded'],
    selected: row.selected_json ? JSON.parse(row.selected_json) as RouteDecision['selected'] : null,
    decisionModel: JSON.parse(row.decision_model_json) as RouteDecision['decisionModel'],
    rationale: row.rationale,
    configurationRevision: row.configuration_revision,
    generationId: row.generation_id,
    subtaskId: row.subtask_id,
    createdAt: row.created_at,
    outcome: row.outcome,
    graphRevision: row.graph_revision,
    ...selection,
  };
}
