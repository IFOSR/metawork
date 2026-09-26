/**
 * Unified residue reader for Task slot cleanup (ADR-0042 amendment to ADR-0037;
 * implementation plan §3, S4).
 *
 * A Conversation slot may only be released once every category of durable
 * residue has converged. `cancelling`, `uncertain`, live sandbox and claimed
 * WorkUnit facts are *not* residue that a reconciler may shortcut: they must be
 * resolved along the existing Kernel authorization path. This module is the one
 * place that decides what "still occupied" means; it never mutates state.
 */

import type Database from 'better-sqlite3';
import type { WorkUnitClaimService } from './work-unit-claim-service.js';

export interface TaskResidueReaderDeps {
  readonly db: Database.Database;
  readonly dispatchItemRepo: {
    hasBlockingResidue(taskId: string, generationId?: string): boolean;
  };
  readonly publicationRepo: {
    hasBlockingResidue(taskId: string, generationId?: string): boolean;
  };
  readonly workUnitClaimService: Pick<WorkUnitClaimService, 'hasClaimedByTask'>;
}

export const TASK_RESIDUE_CATEGORIES = [
  'dispatch',
  'publication',
  'execution_backend',
  'work_unit',
  'resource_lease',
  'generation_replan',
  'kernel_application',
  'attempt_receipt',
] as const;

export type TaskResidueCategory = (typeof TASK_RESIDUE_CATEGORIES)[number];

export class TaskResidueReader {
  constructor(private readonly deps: TaskResidueReaderDeps) {}

  /**
   * Every blocking category, in a stable order. An empty array means the Task
   * owns no live or uncertain side effects and its slot may be released.
   */
  blockingReasons(
    taskId: string,
    generationId: string | null,
    excludedDecisionId?: string,
  ): TaskResidueCategory[] {
    const reasons: TaskResidueCategory[] = [];
    const generation = generationId ? ' AND generation_id = ?' : '';
    const dispatchGeneration = generationId ? ' AND dispatch.generation_id = ?' : '';
    const parameters = generationId ? [taskId, generationId] : [taskId];
    if (this.deps.dispatchItemRepo.hasBlockingResidue(taskId, generationId ?? undefined)) {
      reasons.push('dispatch');
    }
    if (this.deps.publicationRepo.hasBlockingResidue(taskId, generationId ?? undefined)) {
      reasons.push('publication');
    }
    if (this.deps.db.prepare(`
      SELECT 1 FROM attempt_sandboxes
      WHERE task_id = ?${generation}
        AND status IN ('created', 'running', 'paused')
      LIMIT 1
    `).get(...parameters)) reasons.push('execution_backend');
    if (this.deps.workUnitClaimService.hasClaimedByTask(taskId)) reasons.push('work_unit');
    if (this.deps.db.prepare(`
      SELECT 1 FROM resource_leases
      WHERE task_id = ?${generation} AND released_at IS NULL
      LIMIT 1
    `).get(...parameters)) reasons.push('resource_lease');
    if (this.deps.db.prepare(`
      SELECT 1 FROM generation_replan_requests
      WHERE task_id = ?${generation}
        AND status IN (
          'pending_quiescence', 'planning', 'submitted', 'waiting_for_availability'
        )
      LIMIT 1
    `).get(...parameters)) reasons.push('generation_replan');
    const applicationParameters: unknown[] = [taskId];
    let decisionFilter = '';
    if (excludedDecisionId) {
      decisionFilter = ' AND application.decision_id <> ?';
      applicationParameters.push(excludedDecisionId);
    }
    if (this.deps.db.prepare(`
      SELECT 1
      FROM kernel_decision_applications AS application
      INNER JOIN kernel_events AS event ON event.id = application.event_id
      WHERE event.task_id = ?
        AND application.status IN ('pending', 'applying', 'uncertain')
        ${decisionFilter}
      LIMIT 1
    `).get(...applicationParameters)) reasons.push('kernel_application');
    if (this.deps.db.prepare(`
      SELECT 1
      FROM kernel_dispatch_items AS dispatch
      LEFT JOIN executor_attempt_receipts AS receipt
        ON receipt.attempt_id = dispatch.attempt_id
      WHERE dispatch.task_id = ?${dispatchGeneration}
        AND dispatch.status = 'terminal'
        AND (dispatch.work_unit_id IS NOT NULL OR dispatch.sandbox_container_id IS NOT NULL)
        AND receipt.attempt_id IS NULL
      LIMIT 1
    `).get(...parameters)) reasons.push('attempt_receipt');
    return reasons;
  }

  hasResidue(taskId: string, generationId: string | null = null): boolean {
    return this.blockingReasons(taskId, generationId).length > 0;
  }
}
