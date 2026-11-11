/**
 * Transitional persistence adapter for D2-3. Admission policy has one owner;
 * the existing inbox/application records stay until direct admission can recover
 * saved Manager proposals without another model turn. Delete with that cutover.
 */
import type { ControlDecision, ControlDecisionAction, ControlEvent, ControlSnapshot } from '../control/control-contracts.js';
import type { ControlDecider } from '../control/control-workflow.js';
import { allowsControlAction } from '../control/production-authorization.js';
import { authorizePlanAdmission, type PlanAdmissionResult, type PlanAdmissionRequest } from './plan-admission-policy.js';

export function withPlanAdmission(kernel: ControlDecider): ControlDecider {
  return {
    decide(event, snapshot) {
      if (event.type !== 'plan_proposed') return kernel.decide(event, snapshot);
      return decidePlanAdmissionForLedger(event, snapshot);
    },
  };
}

function decidePlanAdmissionForLedger(
  event: Extract<ControlEvent, { type: 'plan_proposed' }>,
  snapshot: ControlSnapshot,
): ControlDecision {
  const envelope = {
    schemaVersion: 5 as const,
    configurationRevision: event.configurationRevision,
    id: `decision_${event.id}`,
    eventId: event.id,
  };
  if (snapshot.type !== 'plan_admission') {
    return { ...envelope, action: { type: 'block_work', taskId: event.taskId ?? '', subtaskId: event.subtaskId ?? null }, reason: 'event and snapshot do not match' };
  }
  const result = authorizePlanAdmission(event, { ...snapshot, configuration: snapshot.kernelConfiguration });
  const action = ledgerAction(result, event);
  if (!allowsControlAction(action, snapshot.productionAuthorization)) {
    return {
      ...envelope,
      action: { type: 'block_work', taskId: event.taskId ?? '', subtaskId: event.subtaskId ?? null, preserveSubtaskState: true },
      reason: snapshot.productionAuthorization?.reason ?? 'official_authorization_required',
    };
  }
  return { ...envelope, action, reason: result.reason };
}

function ledgerAction(
  result: PlanAdmissionResult,
  event: Extract<ControlEvent, { type: 'plan_proposed' }>,
): ControlDecisionAction {
  switch (result.status) {
    case 'rejected': return { type: 'reject_request' };
    case 'clarification': return { type: 'request_clarification', question: result.question };
    case 'no_action': return { type: 'no_op' };
    case 'task_control': return { type: 'authorize_task_control', task: result.task };
    case 'permission_resolution': {
      const { status, reason, ...resolution } = result;
      return { type: 'record_permission_resolution', ...resolution };
    }
    case 'authorized': {
      const { status, reason, ...authorization } = result;
      return { type: 'authorize_task_plan', ...authorization };
    }
    case 'deferred': {
      const { status, reason, proposal, ...deferred } = result;
      return { type: 'defer_task_plan_for_availability', ...deferred, proposalEvent: event };
    }
  }
}

/** Existing application transport only; the saved proposal remains owner input. */
export function replanProposalEvent(
  proposal: PlanAdmissionRequest,
  replanRequestId: string,
  triggerOperationId: string | null,
): Extract<ControlEvent, { type: 'plan_proposed' }> {
  return {
    ...proposal, schemaVersion: 5, type: 'plan_proposed',
    correlationId: replanRequestId, causationId: triggerOperationId,
  };
}
