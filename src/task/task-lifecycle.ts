/**
 * Canonical Task/Subtask/Attempt lifecycle contracts (2026-09-25 Task lifecycle
 * state convergence plan §2, §3, §4).
 *
 * This module is the single owner of the mapping between the persisted raw
 * status vocabulary and the canonical lifecycle vocabulary. It is pure: no
 * repository, Kernel, Runtime or presentation dependency.
 *
 * Two of these machines are business lifecycle state; the rest are operational
 * facts or protocols. Attempt lifecycle and outcome are deliberately separate:
 * an attempt can be `settled` while its outcome is `heartbeat_lost`, and the
 * Task may still be `executing` or `coordinating` because of that fact.
 */

import type { SubtaskStatus, TaskStatus } from '../core/types.js';
import type {
  KernelDispatchItemStatus,
  KernelSubtaskStatus,
} from '../kernel/control-kernel.js';
import type { ExecutorAttemptTerminalState } from '../storage/executor-attempt-receipt-repo.js';
import type { KernelFailure } from '../core/kernel-failure.js';

/** Business Task lifecycle. Owned by the Task Domain. */
export const TASK_LIFECYCLE_STATES = [
  'queued',
  'executing',
  'coordinating',
  'waiting_for_user',
  'blocked',
  'completed',
  'failed',
  'cancelled',
] as const;
export type TaskLifecycleState = (typeof TASK_LIFECYCLE_STATES)[number];

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

/**
 * Read-only user-facing phase (plan §7). Never equates `running` with all
 * non-terminal work; every value answers "what is happening to my Task now".
 */
export const TASK_USER_FACING_PHASES = [
  'queued',
  'executing',
  'retrying',
  'waiting_for_plan',
  'waiting_for_user',
  'publishing',
  'recovery_required',
  'blocked',
  'completed',
  'failed',
  'cancelled',
] as const;
export type TaskUserFacingPhase = (typeof TASK_USER_FACING_PHASES)[number];

const TASK_LIFECYCLE_BY_STATUS: Record<TaskStatus, TaskLifecycleState> = {
  created: 'queued',
  ready: 'queued',
  running: 'executing',
  parked: 'coordinating',
  blocked: 'blocked',
  done: 'completed',
  archived: 'completed',
  cancelled: 'cancelled',
};

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

/**
 * Explicit raw → canonical Task mapping. Callers that need to present Task
 * status must use this instead of passing the persisted column through.
 */
export function toTaskLifecycleState(status: TaskStatus): TaskLifecycleState {
  return TASK_LIFECYCLE_BY_STATUS[status] ?? 'coordinating';
}

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
 * Phase 4 transition guard: the Task Domain owns these transitions and rejects
 * cross-layer writes that skip them. Kept here so every caller shares one rule.
 */
const TASK_TRANSITIONS: Record<TaskLifecycleState, readonly TaskLifecycleState[]> = {
  queued: ['executing', 'coordinating', 'waiting_for_user', 'blocked', 'failed', 'cancelled'],
  executing: ['coordinating', 'waiting_for_user', 'blocked', 'completed', 'failed', 'cancelled'],
  // `queued` is reachable again after an explicit unblock or resume, which is
  // how the Kernel clears a resolver blocker without going back to execution.
  coordinating: ['queued', 'executing', 'waiting_for_user', 'blocked', 'completed', 'failed', 'cancelled'],
  waiting_for_user: ['queued', 'executing', 'coordinating', 'blocked', 'completed', 'failed', 'cancelled'],
  blocked: ['queued', 'executing', 'coordinating', 'waiting_for_user', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isTaskTransitionAllowed(
  from: TaskLifecycleState,
  to: TaskLifecycleState,
): boolean {
  if (from === to) return true;
  return TASK_TRANSITIONS[from].includes(to);
}

/**
 * Subtask node transitions. Owned by Work Graph/Task Domain. A node may not go
 * back to `pending` once it produced an attempt receipt; that requires a new
 * graph revision instead.
 */
const SUBTASK_TRANSITIONS: Record<SubtaskLifecycleState, readonly SubtaskLifecycleState[]> = {
  pending: ['executing', 'awaiting_completion', 'blocked', 'cancelled'],
  executing: ['pending', 'awaiting_completion', 'blocked', 'completed', 'cancelled'],
  awaiting_completion: ['executing', 'completed', 'blocked', 'cancelled'],
  completed: [],
  blocked: ['pending', 'executing', 'awaiting_completion', 'completed', 'cancelled'],
  cancelled: [],
};

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

/**
 * Fact-aware canonical Task lifecycle (2026-09-25 plan §4).
 *
 * The persisted column cannot express `coordinating`, so the canonical state is
 * refined by durable facts: a Task with no active authorized Attempt is never
 * `executing`, and outstanding coordination work makes it `coordinating`
 * instead of `blocked` or `waiting_for_user`.
 */
export function deriveTaskLifecycleState(input: {
  status: TaskStatus;
  hasActiveAttempt: boolean;
  hasOutstandingReplanJob: boolean;
  hasPendingRetryWake: boolean;
  hasPendingUserDecision: boolean;
}): TaskLifecycleState {
  const persisted = toTaskLifecycleState(input.status);
  if (isTerminalTaskLifecycle(persisted)) return persisted;
  if (input.hasPendingUserDecision) return 'waiting_for_user';
  if (persisted === 'blocked') return 'blocked';
  if (input.hasActiveAttempt) return 'executing';
  if (input.hasOutstandingReplanJob || input.hasPendingRetryWake) return 'coordinating';
  if (persisted === 'queued') return 'queued';
  // A persisted `running` Task without an active Attempt is coordinating the
  // next authorized action, never executing.
  return 'coordinating';
}

/** Terminal business lifecycle states. */
export function isTerminalTaskLifecycle(
  state: TaskLifecycleState,
): state is Extract<TaskLifecycleState, 'completed' | 'failed' | 'cancelled'> {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}
