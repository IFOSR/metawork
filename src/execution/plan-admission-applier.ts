/**
 * Direct plan admission seam (ADR-0055 §6, D2-3b-2c).
 *
 * Producers evaluate `authorizePlanAdmission` themselves and hand the result to
 * this applier. There is no Kernel event, decision or application record on the
 * path: the applied outcome is `task_plan_admission_results` under
 * `admission_<planId>`, and the graph revision records that same operation
 * identity.
 */
import type { PlanAdmissionOutcomeStatus } from './plan-admission-result-store.js';

export interface PlanAdmissionApplyContext {
  /** Saved proposal record id (the former plan event id). */
  proposalId: string;
  userInput: string;
  conversationId?: string;
  queryId?: string | null;
}

export interface PlanAdmissionAppliedResult {
  /** `admission_<planId>`; the only identity the Runtime keeps. */
  operationId: string;
  status: PlanAdmissionOutcomeStatus;
  taskId: string | null;
  reason: string;
  schedulingReason: string | null;
  /** User-visible text the outcome carries (direct reply or clarification). */
  displayText: string | null;
  /** The durable outcome already existed; no second effect was applied. */
  replayed: boolean;
}

/** One applier shape for foreground and background admission. */
export interface PlanAdmissionApplier {
  applyPlanAdmission(
    result: import('./plan-admission-policy.js').PlanAdmissionResult,
    context: PlanAdmissionApplyContext,
  ): Promise<PlanAdmissionAppliedResult>;
}
