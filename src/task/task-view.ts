/**
 * Unified read-only `TaskView` projection (2026-10-22 Task state simplification §6.1).
 *
 * Task has one conclusion and this projection does not recompute it. The current
 * status, reason, phase, pending actions, cleanup summary and version all come
 * from the persisted `TaskStateSnapshot`; this module only assembles the
 * operational detail (active Attempt, Subtask states, result, timestamps) that a
 * surface needs next to that conclusion.
 *
 * There is no raw-status fallback and no second lifecycle vocabulary. A surface
 * that needs "is it finished" reads `state.status`.
 */

import type { SubtaskStatus, TaskStatus } from '../core/types.js';
import type { KernelAttemptKind, KernelSubtaskStatus } from '../kernel/control-kernel.js';
import type { KernelFailure } from '../core/kernel-failure.js';
import type { ExecutorAttemptTerminalState } from '../storage/executor-attempt-receipt-repo.js';
import type { KernelDispatchItemStatus } from '../kernel/control-kernel.js';
import type { GenerationReplanRequestStatus } from '../storage/generation-replan-request-repo.js';
import {
  isActiveDispatchStatus,
  toAttemptLifecycleState,
  toAttemptOutcome,
  toSubtaskLifecycleState,
  type AttemptLifecycleState,
  type AttemptOutcome,
  type SubtaskLifecycleState,
} from './task-lifecycle.js';
import {
  TASK_STATUS_LABELS,
  isTerminalTaskStatus,
  normalizeCleanup,
  normalizeTaskStateDetail,
  type TaskCleanupSummary,
  type TaskPendingAction,
  type TaskStateDetail,
  type TaskStateSnapshot,
  type TaskStatus as TaskStateStatus,
} from './task-state.js';

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
    readonly stateVersion: number;
    readonly stateDetail: TaskStateDetail;
    readonly completedAt?: string | null;
    readonly archivedAt?: string | null;
    readonly retryOfTaskId?: string | null;
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
  /** Named reasons the Kernel would currently refuse a `complete_task` decision. */
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

export interface TaskView {
  readonly taskId: string;
  /** The one Task conclusion every surface reads. */
  readonly state: TaskStateSnapshot;
  /** Convenience mirror of `state.status` for surfaces that only render a label. */
  readonly status: TaskStateStatus;
  readonly statusLabel: string;
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
  /** One canonical next authorized action, or `none` in a terminal state. */
  readonly nextAuthorizedAction: TaskAction;
  /**
   * Why a recovery state was reached, so a surface can offer the right entry
   * point instead of a generic message.
   */
  readonly recoveryDiagnosis: TaskViewRecoveryDiagnosis | null;
  readonly pendingActions: readonly TaskPendingAction[];
  readonly cleanup: TaskCleanupSummary;
  /** Why the state is what it is, in user-facing terms. */
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
 * Projects a Task view from the persisted conclusion plus operational details.
 * It never derives a status of its own.
 */
export function projectTaskView(facts: TaskViewFacts): TaskView {
  const attempts = orderAttempts(facts);
  const activeAttempt = attempts.find(attempt => (
    isActiveDispatchStatus(attempt.dispatchStatus) && attempt.dispatchStatus !== 'pending_launch'
    && (attempt.settledAt === null || attempt.dispatchStatus === 'cancelling')
  )) ?? null;
  const replanJob = facts.replanJobs
    .filter(job => ACTIVE_REPLAN_STATUSES.includes(job.status))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  const recovery = [...facts.uncertainApplications]
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))[0] ?? null;
  const publishingResidue = facts.publications
    .filter(publication => RESIDUAL_PUBLICATION_STATUSES.has(publication.status));
  const detail = normalizeTaskStateDetail(facts.task.stateDetail);
  const cleanup = normalizeCleanup(detail.cleanup);
  const status = facts.task.status;
  const blockingResidue = deriveBlockingResidue({
    activeAttempt,
    replanJob,
    recovery,
    retryWakeRecoveryRequired: facts.retryWakeRecoveryRequired === true,
    publishingResidue: publishingResidue.map(publication => `publication:${publication.status}`),
    completionResidue: facts.completionResidue,
    pendingPermission: facts.pendingPermission,
    cleanup,
  });
  const recoveryDiagnosis: TaskViewRecoveryDiagnosis | null = recovery
    ? 'uncertain_application'
    : facts.retryWakeRecoveryRequired
      || detail.reason.code === 'no_authorized_driver'
      ? 'no_authorized_driver'
      : null;
  return {
    taskId: facts.task.id,
    state: {
      taskId: facts.task.id,
      status,
      stateVersion: facts.task.stateVersion,
      reason: detail.reason,
      phase: detail.phase,
      pendingActions: detail.pendingActions,
      cleanup,
      nextWakeAt: detail.nextWakeAt ?? facts.retryWakeAt,
      completedAt: facts.task.completedAt ?? null,
      archivedAt: facts.task.archivedAt ?? null,
      retryOfTaskId: facts.task.retryOfTaskId ?? null,
    },
    status,
    statusLabel: TASK_STATUS_LABELS[status],
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
    nextAuthorizedAction: nextAuthorizedAction(status, detail, recoveryDiagnosis),
    recoveryDiagnosis,
    pendingActions: detail.pendingActions,
    cleanup,
    explanation: explain(status, detail),
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
      nextWakeAt: detail.nextWakeAt ?? facts.retryWakeAt ?? replanJob?.updatedAt ?? null,
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
  cleanup: TaskCleanupSummary;
}): string[] {
  const residue: string[] = [];
  if (input.activeAttempt) residue.push(`attempt:${input.activeAttempt.attemptId}`);
  if (input.replanJob) residue.push(`replan:${input.replanJob.id}`);
  if (input.recovery) residue.push(`application:${input.recovery.applicationId}`);
  if (input.retryWakeRecoveryRequired) residue.push('retry_wake:recovery_required');
  residue.push(...input.publishingResidue);
  residue.push(...input.completionResidue.map(reason => `completion:${reason}`));
  if (input.pendingPermission) residue.push(`permission:${input.pendingPermission.requestId}`);
  residue.push(...input.cleanup.objects.map(object => `cleanup:${object}`));
  return residue;
}

function nextAuthorizedAction(
  status: TaskStateStatus,
  detail: TaskStateDetail,
  diagnosis: TaskViewRecoveryDiagnosis | null,
): TaskAction {
  if (detail.pendingActions.some(action => action.kind === 'accept_result')) return 'accept_result';
  if (detail.pendingActions.some(action => action.kind === 'retry_attempt')) return 'retry_attempt';
  if (isTerminalTaskStatus(status)) return 'none';
  switch (status) {
    case 'queued':
      return 'await_conversation_slot';
    case 'running':
      switch (detail.phase) {
        case 'retrying':
          return 'await_retry_wake';
        case 'publishing':
        case 'delivering':
          return 'await_publication';
        case 'verifying':
          return 'await_planner_proposal';
        case 'stopping':
          return 'await_attempt_settlement';
        default:
          return 'await_attempt_settlement';
      }
    case 'needs_action':
      if (diagnosis === 'uncertain_application') return 'resolve_uncertain_application';
      return 'await_user_input';
    default:
      return 'none';
  }
}

function explain(status: TaskStatus, detail: TaskStateDetail): string {
  const reasonText = detail.reason.message
    || defaultReasonText(detail.reason.code);
  if (isTerminalTaskStatus(status)) {
    return reasonText || defaultStatusText(status);
  }
  const phaseText = detail.phase ? PHASE_TEXT[detail.phase] : '';
  const base = reasonText || defaultStatusText(status);
  const cleanupText = detail.cleanup.state === 'none'
    ? ''
    : `（${detail.cleanup.state === 'blocked' ? '清理需要核实' : '正在清理'}：${detail.cleanup.objects.join('、') || '无具体对象'}）`;
  return `${phaseText}${base}${cleanupText}`;
}

const PHASE_TEXT: Readonly<Record<NonNullable<TaskStateDetail['phase']>, string>> = {
  executing: '正在执行：',
  publishing: '正在集成发布：',
  delivering: '正在交付文件：',
  starting_service: '正在启动服务：',
  retrying: '等待自动重试：',
  stopping: '正在安全停止：',
  verifying: '正在核实结果：',
};

function defaultStatusText(status: TaskStatus): string {
  return `任务${TASK_STATUS_LABELS[status]}。`;
}

function defaultReasonText(code: TaskStateDetail['reason']['code']): string {
  switch (code) {
    case 'none':
    case 'waiting_for_capacity':
    case 'cleanup_in_progress':
      return '';
    case 'user_cancelled':
      return '用户取消了任务。';
    case 'result_acceptance_required':
      return '结果已安全保存，需要接受后才能继续交付。';
    case 'input_required':
      return '需要用户补充信息或确认。';
    case 'external_outcome_unknown':
      return '外部操作结果未知，需要核实。';
    case 'no_authorized_driver':
      return '没有可以继续的授权工作，需要恢复或重新发起。';
    case 'port_in_use':
      return '端口已被占用，代码已保留。';
    case 'command_not_found':
      return '所需的命令不存在。';
    case 'service_start_failed':
      return '服务未能启动。';
    case 'service_health_timeout':
      return '服务未在期限内通过健康检查。';
    case 'delivery_failed':
      return '文件交付失败。';
    case 'execution_failed':
      return '必需工作失败。';
    case 'retry_exhausted':
      return '自动重试已耗尽，任务结束。';
    case 'requirements_incomplete':
      return '用户要求的必需工作尚未全部完成。';
    case 'system_anomaly':
      return '系统发现异常状态，需要确认。';
  }
}

function latestTimestamp(values: readonly (string | null | undefined)[]): string | null {
  const present = values.filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (present.length === 0) return null;
  return present.reduce((latest, value) => (value > latest ? value : latest));
}
