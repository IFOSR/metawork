/**
 * Canonical Subtask/Attempt lifecycle contracts.
 *
 * Task has exactly one state model: [`task-state.ts`](./task-state.ts). It owns
 * the six Task states, the one transition table and the pure summary function.
 * This module keeps the remaining operational machines only:
 *
 * - Subtask node lifecycle, owned by the Task Domain;
 * - Attempt protocol lifecycle and immutable outcome, owned by the Execution
 *   Runtime.
 *
 * Both are operational facts. They report evidence; they never invent a Task
 * conclusion.
 */

import type { SubtaskStatus } from '../core/types.js';
import type {
  KernelDispatchItemStatus,
  KernelSubtaskStatus,
} from '../kernel/control-kernel.js';
import type { ExecutorAttemptTerminalState } from '../storage/executor-attempt-receipt-repo.js';
import type { KernelFailure } from '../core/kernel-failure.js';

/** Business Subtask node lifecycle. Owned by Work Graph/Task Domain. */
export const SUBTASK_LIFECYCLE_STATES = [
  'pending',
  'executing',
  'awaiting_completion',
  'completed',
  'blocked',
  'cancelled',
] as const;
export type SubtaskLifecycleState = (typeof SUBTASK_LIFECYCLE_STATES)[number];

/** Technical attempt protocol state. Owned by Execution Runtime. */
export const ATTEMPT_LIFECYCLE_STATES = [
  'authorized',
  'launched',
  'running',
  'settling',
  'settled',
] as const;
export type AttemptLifecycleState = (typeof ATTEMPT_LIFECYCLE_STATES)[number];

/** Immutable attempt outcome after settlement. Flat, not nested in lifecycle. */
export const ATTEMPT_OUTCOMES = [
  'succeeded',
  'failed',
  'heartbeat_lost',
  'cancelled',
  'unknown',
] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

const SUBTASK_LIFECYCLE_BY_STATUS: Record<KernelSubtaskStatus | SubtaskStatus, SubtaskLifecycleState> = {
  ready: 'pending',
  running: 'executing',
  awaiting_integration: 'awaiting_completion',
  awaiting_decision: 'awaiting_completion',
  blocked: 'blocked',
  done: 'completed',
  cancelled: 'cancelled',
};

const ATTEMPT_LIFECYCLE_BY_DISPATCH: Record<KernelDispatchItemStatus, AttemptLifecycleState> = {
  pending_launch: 'authorized',
  launching: 'launched',
  running: 'running',
  cancelling: 'settling',
  terminal: 'settled',
  cancelled: 'settled',
  uncertain: 'settled',
};

export function toSubtaskLifecycleState(
  status: KernelSubtaskStatus | SubtaskStatus,
): SubtaskLifecycleState {
  return SUBTASK_LIFECYCLE_BY_STATUS[status] ?? 'pending';
}

export function toAttemptLifecycleState(
  status: KernelDispatchItemStatus,
): AttemptLifecycleState {
  return ATTEMPT_LIFECYCLE_BY_DISPATCH[status] ?? 'settled';
}

/**
 * Settlement is derived from the receipt, not from the dispatch item, because
 * only the immutable receipt proves the outcome was durably landed.
 */
export function toAttemptOutcome(input: {
  terminalState: ExecutorAttemptTerminalState | null;
  failure: KernelFailure | null;
}): AttemptOutcome | null {
  if (!input.terminalState) return null;
  if (input.terminalState === 'completed' || input.terminalState === 'uncertified_result') {
    return 'succeeded';
  }
  if (input.terminalState === 'cancelled_or_stale') return 'cancelled';
  if (input.terminalState === 'heartbeat_lost') return 'heartbeat_lost';
  if (input.terminalState === 'executor_failed' || input.terminalState === 'contract_blocked') {
    return input.failure?.kind === 'heartbeat_lost' ? 'heartbeat_lost' : 'failed';
  }
  return 'unknown';
}

/** True when a dispatch item still owns execution capacity. */
export function isActiveDispatchStatus(status: KernelDispatchItemStatus): boolean {
  return status === 'pending_launch'
    || status === 'launching'
    || status === 'running'
    || status === 'cancelling';
}

/** True when a dispatch item is settled and its facts are immutable. */
export function isSettledDispatchStatus(status: KernelDispatchItemStatus): boolean {
  return status === 'terminal' || status === 'cancelled' || status === 'uncertain';
}

/**
 * Subtask node transitions. Owned by Work Graph/Task Domain. A node may not go
 * back to `pending` once it produced an attempt receipt; that requires a new
 * graph revision instead.
 *
 * `completed` has exactly one outgoing transition: the Kernel-authorized repair
 * continuation (2026-10-27 realignment P0). A Subtask may have produced correct
 * code that does not run, and the code cannot be declared finished while the
 * required service is still broken. The reopen is intentionally narrow — it goes
 * back to `awaiting_completion`, never to `pending`, so the node keeps its
 * receipts, attempts and history and can only be re-executed through a new
 * authorized Attempt.
 */
const SUBTASK_TRANSITIONS: Record<SubtaskLifecycleState, readonly SubtaskLifecycleState[]> = {
  pending: ['executing', 'awaiting_completion', 'blocked', 'cancelled'],
  executing: ['pending', 'awaiting_completion', 'blocked', 'completed', 'cancelled'],
  awaiting_completion: ['pending', 'executing', 'completed', 'blocked', 'cancelled'],
  completed: ['awaiting_completion'],
  blocked: ['pending', 'executing', 'awaiting_completion', 'completed', 'cancelled'],
  cancelled: [],
};

/** True only for the Kernel-authorized repair reopen of a completed node. */
export function isSubtaskReopen(from: SubtaskLifecycleState, to: SubtaskLifecycleState): boolean {
  return from === 'completed' && to === 'awaiting_completion';
}

export function isSubtaskTransitionAllowed(
  from: SubtaskLifecycleState,
  to: SubtaskLifecycleState,
): boolean {
  if (from === to) return true;
  return SUBTASK_TRANSITIONS[from].includes(to);
}

/** Terminal Subtask node states. */
export function isTerminalSubtaskLifecycle(state: SubtaskLifecycleState): boolean {
  return state === 'completed' || state === 'cancelled';
}
