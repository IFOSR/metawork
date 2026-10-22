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
  deriveTaskLifecycleState,
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

export interface TaskViewPendingDecisionFact {
  readonly expectedResult?: import('./safe-result-identity.js').PendingResultIdentity;
  readonly owner: 'kernel' | 'user' | 'recovery';
  readonly reason: 'uncertified_result' | 'missing_material' | 'permission' | 'uncertain_application' | 'recovery';
  readonly resultId: string | null;
  readonly attemptId: string | null;
  readonly actions: readonly ('accept_result' | 'retry_attempt' | 'resolve_recovery')[];
}

export interface TaskViewFacts {
  readonly serviceState?: string | null;
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
  /** A durable wake exists but cannot safely drive a continuation. */
  readonly retryWakeRecoveryRequired?: boolean;
  readonly capacityWaiting?: boolean;
  readonly deliveryState?: 'pending' | 'failed' | null;
  readonly result: TaskViewResultFact | null;
  /** A durable user decision derived from a safe result or recovery fact. */
  readonly pendingDecision?: TaskViewPendingDecisionFact | null;
}

import type { TaskUserState } from './task-user-state.js';
export { type TaskUserState, TASK_USER_STATE_LABELS } from './task-user-state.js';

export interface TaskView {
  readonly userState: TaskUserState;
  readonly userStateReason: string;
  readonly taskId: string;
  /** Canonical business lifecycle state. */
  readonly lifecycle: TaskLifecycleState;
  /** Internal detail phase; primary presentation uses userState. */
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
  /**
   * Why a `recovery_required` phase was reached, so a surface can offer the
   * right entry point instead of a generic message.
   */
  readonly recoveryDiagnosis: TaskViewRecoveryDiagnosis | null;
  readonly pendingDecision: TaskViewPendingDecisionFact | null;
  /** Why the phase is what it is, in user-facing terms. */
  readonly explanation: string;
  readonly result: TaskViewResultFact | null;
  readonly timestamps: {
    readonly lastProgressAt: string | null;
    readonly lastAttemptSettledAt: string | null;
    readonly nextWakeAt: string | null;
  };
}

export type TaskViewRecoveryDiagnosis = 'uncertain_application' | 'no_authorized_driver';

export type TaskAction =
  | 'await_attempt_settlement'
  | 'await_retry_wake'
  | 'await_planner_proposal'
  | 'resolve_uncertain_application'
  | 'await_publication'
  | 'await_user_input'
  | 'accept_result'
  | 'retry_attempt'
  | 'await_conversation_slot'
  | 'explicit_resume_required'
  | 'none';

export const ACTIVE_REPLAN_STATUSES: readonly GenerationReplanRequestStatus[] = [
  'pending_quiescence',
  'planning',
  'submitted',
  'waiting_for_availability',
];

export const RESIDUAL_PUBLICATION_STATUSES = new Set([
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
  const attempts = orderAttempts(facts);
  const activeAttempt = attempts.find(attempt => (
    isActiveDispatchStatus(attempt.dispatchStatus) && attempt.dispatchStatus !== 'pending_launch'
    && (attempt.settledAt === null || attempt.dispatchStatus === 'cancelling')
  )) ?? null;
  const queuedAttempts = attempts.filter(attempt => attempt.dispatchStatus === 'pending_launch');
  const replanJob = facts.replanJobs
    .filter(job => ACTIVE_REPLAN_STATUSES.includes(job.status))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  const recovery = [...facts.uncertainApplications]
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))[0] ?? null;
  const publishingResidue = facts.publications
    .filter(publication => RESIDUAL_PUBLICATION_STATUSES.has(publication.status));
  // Canonical lifecycle comes from durable facts, not the persisted column
  // alone: a `running` Task with no active Attempt is coordinating work.
  const lifecycle = deriveTaskLifecycleState({
    status: facts.task.status,
    hasActiveAttempt: activeAttempt !== null,
    hasOutstandingReplanJob: replanJob !== null,
    hasPendingRetryWake: facts.retryWakeAt !== null,
    hasPendingUserDecision: facts.pendingPermission !== null,
  });
  const blockingResidue = deriveBlockingResidue({
    activeAttempt,
    replanJob,
    recovery,
    retryWakeRecoveryRequired: facts.retryWakeRecoveryRequired === true,
    publishingResidue: publishingResidue.map(publication => `publication:${publication.status}`),
    completionResidue: facts.completionResidue,
    pendingPermission: facts.pendingPermission,
  });

  // A Task can only be `coordinating` when a durable driver exists (an active
  // Attempt, a retry wake, a Replan Job or a publication). Without one the
  // phase must say so instead of implying a driver that is not there
  // (2026-09-25 review fix 6).
  const recoveryDiagnosis: TaskViewRecoveryDiagnosis | null = recovery
    ? 'uncertain_application'
    : facts.retryWakeRecoveryRequired
      ? 'no_authorized_driver'
      : lifecycle === 'coordinating'
        ? 'no_authorized_driver'
        : null;
  const phase = derivePhase({
    lifecycle,
    activeAttempt: activeAttempt !== null,
    queuedAttempt: queuedAttempts.length > 0,
    retryWakeRecoveryRequired: facts.retryWakeRecoveryRequired === true,
    retryWakeAt: facts.retryWakeAt,
    replanJob: replanJob !== null,
    recovery: recovery !== null,
    publishing: publishingResidue.length > 0,
    pendingPermission: facts.pendingPermission !== null,
    result: facts.result,
  });

  const automaticPublication = publishingResidue.some(item => ['pending', 'applying', 'cancelling'].includes(item.status));
  const userState: TaskUserState = isTerminalTaskLifecycle(lifecycle) ? 'finished'
    : activeAttempt || automaticPublication || facts.deliveryState === 'pending' ? 'executing'
      : facts.capacityWaiting || queuedAttempts.length > 0 || (facts.retryWakeAt && !facts.retryWakeRecoveryRequired)
        || (replanJob && replanJob.status !== 'waiting_for_availability') || lifecycle === 'queued' ? 'waiting'
      : 'needs_action';
  const pendingDecision = isTerminalTaskLifecycle(lifecycle) ? null
    : facts.pendingDecision ?? null;
  const explanation = facts.capacityWaiting || (phase === 'queued' && queuedAttempts.length > 0)
    ? '等待执行名额；名额释放后系统会自动继续。'
    : explain({ phase, lifecycle, blockingResidue, recoveryDiagnosis });
  const userStateReason = (userState === 'finished'
    ? explain({ phase: lifecycle as 'completed' | 'failed' | 'cancelled', lifecycle, blockingResidue, recoveryDiagnosis })
    : userState === 'needs_action' && facts.serviceState && facts.serviceState !== 'healthy'
      && !pendingDecision && facts.subtasks.length > 0 && facts.subtasks.every(item => item.status === 'done')
      ? '代码已交付，服务尚未通过健康检查。请查询服务状态，并显式启动或重启服务。'
    : userState === 'needs_action' && (pendingDecision?.reason === 'uncertified_result' || facts.deliveryState === 'failed' || recoveryDiagnosis === 'no_authorized_driver')
      ? (pendingDecision?.reason === 'uncertified_result'
        ? `结果已安全保存，但完成验收还缺少执行说明。请接受并交付${pendingDecision.actions.includes('retry_attempt') ? '，或重新执行' : ''}。`
        : facts.deliveryState === 'failed' ? '文件交付失败，请继续未完成部分；已完成的执行不会重跑。' : '没有找到可以继续任务的执行记录。请继续未完成部分。')
      : explanation)
    + (activeAttempt && facts.subtasks.some(subtask => subtask.status === 'blocked')
      ? ' 另有子任务需要处理，独立工作继续。' : '');

  return {
    taskId: facts.task.id,
    lifecycle,
    phase,
    userState,
    userStateReason,
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
    nextAuthorizedAction: nextAuthorizedAction(phase, phase === 'recovery_required' ? recoveryDiagnosis : null,
      isTerminalTaskLifecycle(lifecycle) ? null : pendingDecision),
    recoveryDiagnosis,
    pendingDecision: pendingDecision ?? null,
    explanation: phase === 'queued' && queuedAttempts.length > 0
      ? '等待执行名额；名额释放后系统会自动继续。'
      : explain({ phase, lifecycle, blockingResidue, recoveryDiagnosis })
        + (activeAttempt && facts.subtasks.some(subtask => subtask.status === 'blocked')
          ? ` 另有 ${facts.subtasks.filter(subtask => subtask.status === 'blocked').length} 个子任务待处理，其余独立工作继续。` : ''),
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
  retryWakeRecoveryRequired: boolean;
  publishingResidue: readonly string[];
  completionResidue: readonly string[];
  pendingPermission: { readonly requestId: string } | null;
}): string[] {
  const residue: string[] = [];
  if (input.activeAttempt) residue.push(`attempt:${input.activeAttempt.attemptId}`);
  if (input.replanJob) residue.push(`replan:${input.replanJob.id}`);
  if (input.recovery) residue.push(`application:${input.recovery.applicationId}`);
  if (input.retryWakeRecoveryRequired) residue.push('retry_wake:recovery_required');
  residue.push(...input.publishingResidue);
  residue.push(...input.completionResidue.map(reason => `completion:${reason}`));
  if (input.pendingPermission) residue.push(`permission:${input.pendingPermission.requestId}`);
  return residue;
}

function derivePhase(input: {
  lifecycle: TaskLifecycleState;
  activeAttempt: boolean;
  queuedAttempt: boolean;
  retryWakeRecoveryRequired: boolean;
  retryWakeAt: string | null;
  replanJob: boolean;
  recovery: boolean;
  publishing: boolean;
  pendingPermission: boolean;
  result: TaskViewResultFact | null;
}): TaskUserFacingPhase {
  if (input.activeAttempt) return 'executing';
  if (input.queuedAttempt) return 'queued';
  if (input.retryWakeRecoveryRequired) return 'recovery_required';
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
  if (input.lifecycle === 'queued') return 'queued';
  // Nothing above is driving the Task: a persisted `running` Task with no
  // active Attempt, no retry wake and no Replan Job must not claim it is
  // waiting for a plan that was never requested. It is a recovery situation.
  return 'recovery_required';
}

function nextAuthorizedAction(
  phase: TaskUserFacingPhase,
  diagnosis: TaskViewRecoveryDiagnosis | null,
  pendingDecision: TaskViewPendingDecisionFact | null | undefined,
): TaskAction {
  if (pendingDecision?.reason === 'uncertified_result') return 'accept_result';
  switch (phase) {
    case 'executing':
      return 'await_attempt_settlement';
    case 'retrying':
      return 'await_retry_wake';
    case 'waiting_for_plan':
      return 'await_planner_proposal';
    case 'recovery_required':
      return diagnosis === 'uncertain_application'
        ? 'resolve_uncertain_application'
        : 'explicit_resume_required';
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
  recoveryDiagnosis: TaskViewRecoveryDiagnosis | null;
}): string {
  switch (input.phase) {
    case 'executing':
      return 'An authorized Attempt is actively running.';
    case 'retrying':
      return 'The Kernel scheduled a bounded retry wake for the next Attempt.';
    case 'waiting_for_plan':
      return 'The Kernel requested a Replan Job; a Planner proposal is still outstanding.';
    case 'recovery_required':
      return input.recoveryDiagnosis === 'uncertain_application'
        ? 'A Kernel action outcome is uncertain and must be reconciled before the Task can continue.'
        : 'No authorized Attempt, retry wake, Replan Job or publication is driving the Task; '
          + 'explicit recovery is required.';
    case 'publishing':
      return 'Execution finished but publication or certification is still pending.';
    case 'waiting_for_user':
      return 'The Kernel is waiting for a user decision before continuing.';
    case 'queued':
      return 'The Task is admitted and waiting for a Conversation slot.';
    case 'blocked':
      return input.blockingResidue.length > 0
        ? `任务需要处理：${input.blockingResidue.join('、')}。请查看原因并继续。`
        : '任务需要处理，请选择继续或重新执行。';
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
