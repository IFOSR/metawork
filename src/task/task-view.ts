/**
 * Unified read-only `TaskView` projection (2026-09-25 Task lifecycle state
 * convergence plan §7).
 *
 * One projection contract for TUI, Web, Feishu and command output. It is a pure
 * function over durable facts: it never mutates state, never calls a repository
 * and never lets a presentation surface re-derive reconciliation.
 *
 * The projection never equates `Task.status === 'running'` with "actively
 * executing": `executing` requires an active authorized Attempt.
 */

import type { SubtaskStatus, TaskStatus } from '../core/types.js';
import type { KernelAttemptKind, KernelSubtaskStatus } from '../kernel/control-kernel.js';
import type { KernelFailure } from '../core/kernel-failure.js';
import type { ExecutorAttemptTerminalState } from '../storage/executor-attempt-receipt-repo.js';
import type { KernelDispatchItemStatus } from '../kernel/control-kernel.js';
import type { GenerationReplanRequestStatus } from '../storage/generation-replan-request-repo.js';
import {
  isActiveDispatchStatus,
  isTerminalTaskLifecycle,
  toAttemptLifecycleState,
  toAttemptOutcome,
  toSubtaskLifecycleState,
  toTaskLifecycleState,
  type AttemptLifecycleState,
  type AttemptOutcome,
  type SubtaskLifecycleState,
  type TaskLifecycleState,
  type TaskUserFacingPhase,
} from './task-lifecycle.js';

export interface TaskViewAttemptFact {
  readonly attemptId: string;
  readonly subtaskId: string;
  readonly attemptKind: KernelAttemptKind;
  readonly dispatchStatus: KernelDispatchItemStatus;
  readonly lifecycle: AttemptLifecycleState;
  readonly outcome: AttemptOutcome | null;
  readonly createdAt: string;
  readonly settledAt: string | null;
}

export interface TaskViewReplanJobFact {
  readonly id: string;
  readonly status: GenerationReplanRequestStatus;
  readonly generationId: string;
  readonly sourceRevision: number;
  readonly updatedAt: string;
}

export interface TaskViewRecoveryFact {
  readonly applicationId: string;
  readonly action: string;
  readonly errorSummary: string | null;
  readonly updatedAt: string;
}

export interface TaskViewResultFact {
  readonly resultId: string;
  readonly completeness: 'complete' | 'partial' | 'incomplete';
  readonly certification: 'certified' | 'uncertified';
}

export interface TaskViewFacts {
  readonly task: {
    readonly id: string;
    readonly status: TaskStatus;
    readonly updatedAt: string | null;
  };
  readonly subtasks: readonly {
    readonly id: string;
    readonly status: KernelSubtaskStatus | SubtaskStatus;
  }[];
  readonly dispatches: readonly {
    readonly attemptId: string;
    readonly subtaskId: string;
    readonly status: KernelDispatchItemStatus;
    readonly attemptKind: KernelAttemptKind;
    readonly createdAt: string;
    readonly updatedAt: string;
  }[];
  readonly receipts: readonly {
    readonly attemptId: string;
    readonly terminalState: ExecutorAttemptTerminalState;
    readonly failure: KernelFailure | null;
    readonly completedAt: string;
  }[];
  readonly replanJobs: readonly TaskViewReplanJobFact[];
  readonly uncertainApplications: readonly TaskViewRecoveryFact[];
  /** Publication facts that still own delivery capacity. */
  readonly publications: readonly {
    readonly id: string;
    readonly status: string;
  }[];
  /** Named reasons a Kernel `complete_task` decision would currently be refused. */
  readonly completionResidue: readonly string[];
  readonly pendingPermission: { readonly requestId: string } | null;
  /** Durable retry wake scheduled by a Kernel `wait_for_retry` decision. */
  readonly retryWakeAt: string | null;
  readonly result: TaskViewResultFact | null;
}

export interface TaskView {
  readonly taskId: string;
  /** Canonical business lifecycle state. */
  readonly lifecycle: TaskLifecycleState;
  /** User-facing phase; the only value surfaces may render as prose. */
  readonly phase: TaskUserFacingPhase;
  readonly activeAttempt: {
    readonly attemptId: string;
    readonly subtaskId: string;
    readonly attemptKind: KernelAttemptKind;
    readonly ordinal: number;
    readonly lifecycle: AttemptLifecycleState;
    readonly outcome: AttemptOutcome | null;
  } | null;
  readonly subtaskStates: readonly {
    readonly subtaskId: string;
    readonly state: SubtaskLifecycleState;
  }[];
  readonly currentReplanJob: TaskViewReplanJobFact | null;
  readonly currentRecovery: TaskViewRecoveryFact | null;
  /** Bounded operational residue categories still owning the Task. */
  readonly blockingResidue: readonly string[];
  /** One canonical next authorized action, or `none` in a terminal phase. */
  readonly nextAuthorizedAction: TaskAction;
  /** Why the phase is what it is, in user-facing terms. */
  readonly explanation: string;
  readonly result: TaskViewResultFact | null;
  readonly timestamps: {
    readonly lastProgressAt: string | null;
    readonly lastAttemptSettledAt: string | null;
    readonly nextWakeAt: string | null;
  };
}

export type TaskAction =
  | 'await_attempt_settlement'
  | 'await_retry_wake'
  | 'await_planner_proposal'
  | 'resolve_uncertain_application'
  | 'await_publication'
  | 'await_user_input'
  | 'await_conversation_slot'
  | 'explicit_resume_required'
  | 'none';

const ACTIVE_REPLAN_STATUSES: readonly GenerationReplanRequestStatus[] = [
  'pending_quiescence',
  'planning',
  'submitted',
  'waiting_for_availability',
];

const RESIDUAL_PUBLICATION_STATUSES = new Set([
  'pending',
  'applying',
  'conflicted',
  'cancelling',
  'uncertain',
]);

/**
 * Deterministic projection priority (plan §7):
 *
 * active Attempt -> executing; retry wake -> retrying; pending Replan Job ->
 * waiting_for_plan; uncertain application -> recovery_required; publication
 * residue -> publishing; terminal lifecycle; pending user decision ->
 * waiting_for_user; remaining residue -> blocked; otherwise canonical queue.
 */
export function projectTaskView(facts: TaskViewFacts): TaskView {
  const lifecycle = toTaskLifecycleState(facts.task.status);
  const attempts = orderAttempts(facts);
  const activeAttempt = attempts.find(attempt => (
    isActiveDispatchStatus(attempt.dispatchStatus)
  )) ?? null;
  const replanJob = facts.replanJobs
    .filter(job => ACTIVE_REPLAN_STATUSES.includes(job.status))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  const recovery = [...facts.uncertainApplications]
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))[0] ?? null;
  const publishingResidue = facts.publications
    .filter(publication => RESIDUAL_PUBLICATION_STATUSES.has(publication.status));
  const blockingResidue = deriveBlockingResidue({
    activeAttempt,
    replanJob,
    recovery,
    publishingResidue: publishingResidue.map(publication => `publication:${publication.status}`),
    completionResidue: facts.completionResidue,
    pendingPermission: facts.pendingPermission,
  });

  const phase = derivePhase({
    lifecycle,
    activeAttempt: activeAttempt !== null,
    retryWakeAt: facts.retryWakeAt,
    replanJob: replanJob !== null,
    recovery: recovery !== null,
    publishing: publishingResidue.length > 0,
    pendingPermission: facts.pendingPermission !== null,
    result: facts.result,
  });

  return {
    taskId: facts.task.id,
    lifecycle,
    phase,
    activeAttempt: activeAttempt
      ? {
          attemptId: activeAttempt.attemptId,
          subtaskId: activeAttempt.subtaskId,
          attemptKind: activeAttempt.attemptKind,
          ordinal: attempts.indexOf(activeAttempt) + 1,
          lifecycle: activeAttempt.lifecycle,
          outcome: activeAttempt.outcome,
        }
      : null,
    subtaskStates: facts.subtasks.map(subtask => ({
      subtaskId: subtask.id,
      state: toSubtaskLifecycleState(subtask.status),
    })),
    currentReplanJob: replanJob,
    currentRecovery: recovery,
    blockingResidue,
    nextAuthorizedAction: nextAuthorizedAction(phase),
    explanation: explain({ phase, lifecycle, blockingResidue }),
    result: facts.result,
    timestamps: {
      lastProgressAt: latestTimestamp([
        facts.task.updatedAt,
        ...facts.dispatches.map(item => item.updatedAt),
        ...facts.receipts.map(item => item.completedAt),
        ...facts.replanJobs.map(job => job.updatedAt),
        ...facts.uncertainApplications.map(item => item.updatedAt),
      ]),
      lastAttemptSettledAt: latestTimestamp(
        facts.receipts.map(item => item.completedAt),
      ),
      nextWakeAt: facts.retryWakeAt ?? replanJob?.updatedAt ?? null,
    },
  };
}

function orderAttempts(facts: TaskViewFacts): TaskViewAttemptFact[] {
  const receiptByAttempt = new Map(facts.receipts.map(receipt => [receipt.attemptId, receipt]));
  return [...facts.dispatches]
    .sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt)
      || left.attemptId.localeCompare(right.attemptId)
    ))
    .map(dispatch => {
      const receipt = receiptByAttempt.get(dispatch.attemptId) ?? null;
      return {
        attemptId: dispatch.attemptId,
        subtaskId: dispatch.subtaskId,
        attemptKind: dispatch.attemptKind,
        dispatchStatus: dispatch.status,
        lifecycle: toAttemptLifecycleState(dispatch.status),
        outcome: receipt
          ? toAttemptOutcome({ terminalState: receipt.terminalState, failure: receipt.failure })
          : null,
        createdAt: dispatch.createdAt,
        settledAt: receipt ? receipt.completedAt : null,
      };
    });
}

function deriveBlockingResidue(input: {
  activeAttempt: TaskViewAttemptFact | null;
  replanJob: TaskViewReplanJobFact | null;
  recovery: TaskViewRecoveryFact | null;
  publishingResidue: readonly string[];
  completionResidue: readonly string[];
  pendingPermission: { readonly requestId: string } | null;
}): string[] {
  const residue: string[] = [];
  if (input.activeAttempt) residue.push(`attempt:${input.activeAttempt.attemptId}`);
  if (input.replanJob) residue.push(`replan:${input.replanJob.id}`);
  if (input.recovery) residue.push(`application:${input.recovery.applicationId}`);
  residue.push(...input.publishingResidue);
  residue.push(...input.completionResidue.map(reason => `completion:${reason}`));
  if (input.pendingPermission) residue.push(`permission:${input.pendingPermission.requestId}`);
  return residue;
}

function derivePhase(input: {
  lifecycle: TaskLifecycleState;
  activeAttempt: boolean;
  retryWakeAt: string | null;
  replanJob: boolean;
  recovery: boolean;
  publishing: boolean;
  pendingPermission: boolean;
  result: TaskViewResultFact | null;
}): TaskUserFacingPhase {
  if (input.activeAttempt) return 'executing';
  if (input.retryWakeAt) return 'retrying';
  if (input.replanJob) {
    return input.lifecycle === 'blocked' ? 'blocked' : 'waiting_for_plan';
  }
  if (input.recovery) return 'recovery_required';
  if (input.publishing) return 'publishing';
  if (isTerminalTaskLifecycle(input.lifecycle)) return input.lifecycle;
  if (input.pendingPermission) return 'waiting_for_user';
  if (input.lifecycle === 'blocked') return 'blocked';
  if (input.lifecycle === 'waiting_for_user') return 'waiting_for_user';
  if (input.lifecycle === 'coordinating') return 'waiting_for_plan';
  if (input.lifecycle === 'executing') {
    // A `running` Task with no active Attempt is never "executing"; it either
    // has residue above or is waiting for its next authorized action.
    return 'waiting_for_plan';
  }
  return 'queued';
}

function nextAuthorizedAction(phase: TaskUserFacingPhase): TaskAction {
  switch (phase) {
    case 'executing':
      return 'await_attempt_settlement';
    case 'retrying':
      return 'await_retry_wake';
    case 'waiting_for_plan':
      return 'await_planner_proposal';
    case 'recovery_required':
      return 'resolve_uncertain_application';
    case 'publishing':
      return 'await_publication';
    case 'waiting_for_user':
      return 'await_user_input';
    case 'queued':
      return 'await_conversation_slot';
    case 'blocked':
      return 'explicit_resume_required';
    case 'completed':
    case 'failed':
    case 'cancelled':
      return 'none';
  }
}

function explain(input: {
  phase: TaskUserFacingPhase;
  lifecycle: TaskLifecycleState;
  blockingResidue: readonly string[];
}): string {
  switch (input.phase) {
    case 'executing':
      return 'An authorized Attempt is actively running.';
    case 'retrying':
      return 'The Kernel scheduled a bounded retry wake for the next Attempt.';
    case 'waiting_for_plan':
      return 'The Kernel requested a Replan Job; a Planner proposal is still outstanding.';
    case 'recovery_required':
      return 'A Kernel action outcome is uncertain and must be reconciled.';
    case 'publishing':
      return 'Execution finished but publication or certification is still pending.';
    case 'waiting_for_user':
      return 'The Kernel is waiting for a user decision before continuing.';
    case 'queued':
      return 'The Task is admitted and waiting for a Conversation slot.';
    case 'blocked':
      return input.blockingResidue.length > 0
        ? `The Task is blocked by: ${input.blockingResidue.join(', ')}.`
        : 'The Task is blocked and requires an explicit resume.';
    case 'completed':
      return 'The Task completed and its certification and publication are clear.';
    case 'failed':
      return 'The Task reached a terminal failure.';
    case 'cancelled':
      return 'The Task was cancelled.';
  }
}

function latestTimestamp(values: readonly (string | null | undefined)[]): string | null {
  const present = values.filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (present.length === 0) return null;
  return present.reduce((latest, value) => (value > latest ? value : latest));
}
