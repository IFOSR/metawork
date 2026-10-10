import type { KernelDecisionAction } from './control-kernel.js';

/** Normalized fact supplied by the application; no clocks, network or credentials in Kernel. */
export interface ProductionAuthorizationFact { allowed: boolean; reason?: string }

export function allowsProduction(fact: ProductionAuthorizationFact | undefined): boolean {
  // Embedded compositions without commercial integration retain their explicit policy.
  return fact?.allowed !== false;
}

/** Shared pure policy for decision issuance, durable replay and pending launch. */
export function allowsKernelAction(action: KernelDecisionAction, fact: ProductionAuthorizationFact | undefined): boolean {
  if (allowsProduction(fact)) return true;
  switch (action.type) {
    case 'authorize_task_plan': case 'dispatch_batch': case 'resume_task': case 'probe_capacity':
    case 'wait_for_retry': case 'recover_retry_wake': case 'request_replan': case 'schedule_replan':
    case 'queue_generation_replan': case 'defer_task_plan_for_availability': case 'activate_deferred_task_plan':
    case 'request_merge_replan': case 'recover_workspace_attempt': case 'grant_capability': case 'escalate_capability':
      return false;
    case 'authorize_task_control':
      return ['cancel', 'pause', 'block'].includes(action.task.control ?? '');
    case 'resolve_recovery': return action.resolution !== 'retry';
    default: return true;
  }
}
