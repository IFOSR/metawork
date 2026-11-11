/**
 * Durable Task Runtime admission outcome (ADR-0055 §6, D2-3b-2b).
 *
 * `PlanProposalStore` records what the Manager produced. This store records
 * what the Runtime did with it: authorized or queued a Task and graph,
 * rejected it, asked the user to clarify, replied directly, or deferred it
 * until Executors recover.
 *
 * It is deliberately *not* a decision ledger. It carries no replayable action,
 * no policy input and no Kernel envelope, so nothing can re-derive authority
 * from it. `task_plan_proposals.delivery` stays a transport receipt; only this
 * record says what was applied.
 */

export type PlanAdmissionOutcomeStatus =
  | 'authorized'
  | 'queued'
  | 'deferred'
  | 'rejected'
  | 'clarification'
  | 'no_action'
  | 'task_control'
  | 'permission_resolution';

export interface PlanAdmissionResultRecord {
  /** `admission_<planId>`: the same identity proposal and graph revision use. */
  operationId: string;
  proposalId: string;
  status: PlanAdmissionOutcomeStatus;
  taskId: string | null;
  generationId: string | null;
  graphRevision: number | null;
  reason: string;
  /** Bounded outcome detail (question, reply, explanation, scheduling reason). */
  detail: Record<string, string> | null;
  appliedAt: string;
}

export interface PlanAdmissionResultInput {
  /** Operation identity from the saved proposal (`admission_<planId>`). */
  operationId: string;
  proposalId: string;
  status: PlanAdmissionOutcomeStatus;
  reason: string;
  taskId?: string | null;
  generationId?: string | null;
  graphRevision?: number | null;
  detail?: Record<string, string> | null;
  appliedAt: string;
}

/** Task Runtime owns the applied admission outcome of a saved proposal. */
export interface PlanAdmissionResultStore {
  find(proposalId: string): PlanAdmissionResultRecord | null;
  /**
   * Records the outcome once per proposal. An identical replay returns the
   * persisted record; any different status or payload is a conflict, so a late
   * or competing writer cannot rewrite what was already applied.
   */
  record(input: PlanAdmissionResultInput): PlanAdmissionResultRecord;
}

/** Canonical comparison of the persisted identity and outcome payload. */
export function planAdmissionResultIdentity(input: {
  status: PlanAdmissionOutcomeStatus;
  taskId?: string | null;
  generationId?: string | null;
  graphRevision?: number | null;
  detail?: Record<string, string> | null;
}): string {
  const detail = input.detail
    ? Object.fromEntries(Object.entries(input.detail).sort(([left], [right]) => left.localeCompare(right)))
    : null;
  return JSON.stringify({
    status: input.status,
    taskId: input.taskId ?? null,
    generationId: input.generationId ?? null,
    graphRevision: input.graphRevision ?? null,
    detail,
  });
}
