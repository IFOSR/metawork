/**
 * Task Runtime control-loop policy (ADR-0055 D3+D4+D5).
 *
 * The Runtime is the single producer of the whole control round. It owns
 * dispatch and capacity (D3), execution landing, failure/retry, attempt recovery
 * and permission gating (D4), and completion, resume, replan scheduling, managed
 * services and remaining-work retry (D5). This facade dispatches to the owning
 * pure lifecycle policies; it does not interpret Manager proposals or replace
 * Router model selection. Its
 * applier in `ControlExecutionRuntime` is the only writer of the resulting facts.
 *
 * The durable operation ledger is gone: the Runtime applies each operation
 * immediately and records one recovery item when an application is interrupted.
 */
import {
  decision,
  guardControlDecision,
  snapshotMatches,
  type ControlDecision,
  type ControlEvent,
  type ControlSnapshot,
} from '../control/control-contracts.js';
import type { ControlDecider } from '../control/control-workflow.js';
import {
  decideGenerationQuiescence,
  decideMergeConflict,
  decidePartitionConflict,
  decideSandboxRecovery,
  decideTaskResume,
} from './attempt-recovery-policy.js';
import { decideCapacity, decideDispatch } from './dispatch-policy.js';
import {
  decideContractFailure,
  decideExecutionResult,
  decideOutcome,
  decideTimer,
} from './failure-retry-policy.js';
import { decideManagedService } from './managed-service-policy.js';
import { decidePermission } from './permission-policy.js';
import { decideRecovery, decideRecoveryRequired } from './recovery-item-policy.js';
import { decideRemainingWorkRetry } from './remaining-work-retry-policy.js';

/**
 * Event families the Runtime control loop decides. `plan_proposed` is absent on
 * purpose: Task admission is a direct owner application (D2) and never becomes a
 * control event.
 */
export const RUNTIME_OWNED_CONTROL_EVENTS = [
  'dispatch_requested',
  'task_resume_requested',
  'capacity_signal',
  'execution_outcome',
  'handoff_contract_failed',
  'execution_result_observed',
  'timer_tick',
  'partition_conflict_observed',
  'sandbox_lost',
  'merge_conflict_observed',
  'generation_quiescence_observed',
  'recovery_resolution_requested',
  'recovery_required_observed',
  'permission_requested',
  'permission_resolution_received',
  'managed_service_requested',
  'task_remaining_work_retry_requested',
] as const satisfies readonly ControlEvent['type'][];

export type RuntimeOwnedControlEvent = (typeof RUNTIME_OWNED_CONTROL_EVENTS)[number];

const RUNTIME_OWNED = new Set<string>(RUNTIME_OWNED_CONTROL_EVENTS);

export function isRuntimeOwnedControlEvent(type: ControlEvent['type']): boolean {
  return RUNTIME_OWNED.has(type);
}

/** In-process facade for Task Runtime lifecycle policies; no durable ledger. */
export class ControlLoopPolicy implements ControlDecider {
  decide(event: ControlEvent, snapshot: ControlSnapshot): ControlDecision {
    if (event.type === 'plan_proposed') {
      throw new Error('plan admission must be handled by the Task Runtime admission owner');
    }
    if (!isRuntimeOwnedControlEvent(event.type)) {
      throw new Error(`${event.type} is not a Task Runtime control event`);
    }
    // The shared guard keeps the authorization fact and the event/snapshot
    // contract identical for every policy module.
    if (!snapshotMatches(event, snapshot)) {
      return guardControlDecision(
        event,
        snapshot,
        decision(event, { type: 'block_work', taskId: event.taskId ?? '', subtaskId: event.subtaskId ?? null }, 'event and snapshot do not match'),
      );
    }
    return guardControlDecision(event, snapshot, decideOwned(event, snapshot));
  }
}

function decideOwned(event: ControlEvent, snapshot: ControlSnapshot): ControlDecision {
  switch (event.type) {
    case 'dispatch_requested':
      return decideDispatch(event, snapshot as Extract<ControlSnapshot, { type: 'dispatch' }>);
    case 'task_resume_requested':
      return decideTaskResume(event, snapshot as Extract<ControlSnapshot, { type: 'dispatch' }>);
    case 'capacity_signal':
      return decideCapacity(event, snapshot as Extract<ControlSnapshot, { type: 'dispatch' }>);
    case 'execution_outcome':
      return decideOutcome(event, snapshot as Extract<ControlSnapshot, { type: 'dispatch' }>);
    case 'handoff_contract_failed':
      return decideContractFailure(event, snapshot as Extract<ControlSnapshot, { type: 'dispatch' }>);
    case 'execution_result_observed':
      return decideExecutionResult(event, snapshot as Extract<ControlSnapshot, { type: 'dispatch' }>);
    case 'timer_tick':
      return decideTimer(event, snapshot as Extract<ControlSnapshot, { type: 'timer' }>);
    case 'partition_conflict_observed':
      return decidePartitionConflict(event, snapshot as Extract<ControlSnapshot, { type: 'partition' }>);
    case 'sandbox_lost':
      return decideSandboxRecovery(event, snapshot as Extract<ControlSnapshot, { type: 'sandbox_recovery' }>);
    case 'merge_conflict_observed':
      return decideMergeConflict(event, snapshot as Extract<ControlSnapshot, { type: 'dispatch' }>);
    case 'generation_quiescence_observed':
      return decideGenerationQuiescence(event, snapshot as Extract<ControlSnapshot, { type: 'dispatch' }>);
    case 'recovery_resolution_requested':
      return decideRecovery(event, snapshot as Extract<ControlSnapshot, { type: 'recovery' }>);
    case 'recovery_required_observed':
      return decideRecoveryRequired(event, snapshot as Extract<ControlSnapshot, { type: 'recovery_required' }>);
    case 'permission_requested':
    case 'permission_resolution_received':
      return decidePermission(event, snapshot as Extract<ControlSnapshot, { type: 'permission' }>);
    case 'managed_service_requested':
      return decideManagedService(event, snapshot as Extract<ControlSnapshot, { type: 'service_control' }>);
    case 'task_remaining_work_retry_requested':
      return decideRemainingWorkRetry(event, snapshot as Extract<ControlSnapshot, { type: 'remaining_work_retry' }>);
    default:
      throw new Error(`${event.type} is not a Task Runtime control event`);
  }
}
