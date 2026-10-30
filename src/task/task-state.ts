/**
 * Canonical Task state model (2026-10-22 Task state simplification design §1-§3).
 *
 * This module is the single owner of the persisted Task status vocabulary, the
 * one transition table and the pure `evaluateTaskState()` summary function. It
 * has no imports: no repository, no Kernel, no Runtime and no presentation
 * dependency, so every layer can depend on it without creating a cycle.
 *
 * Task has exactly six states. Operational records (Subtask, Attempt, service,
 * lease) keep their own state; they report facts and never invent a Task
 * conclusion. A phase describes the current action only, a reason describes
 * why the Task is in its state, and cleanup describes pending safe-shutdown
 * work. None of them are a second Task lifecycle.
 */

/** The six persisted Task states. */
export const TASK_STATUSES = [
  'queued',
  'running',
  'needs_action',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** States that end the Task. They never transition again. */
export const TERMINAL_TASK_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;
export type TerminalTaskStatus = (typeof TERMINAL_TASK_STATUSES)[number];

/** Non-terminal states. */
export const ACTIVE_TASK_STATUSES = ['queued', 'running', 'needs_action'] as const;
export type ActiveTaskStatus = (typeof ACTIVE_TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Readonly<Record<TaskStatus, string>> = Object.freeze({
  queued: '排队',
  running: '执行中',
  needs_action: '待处理',
  succeeded: '成功',
  failed: '失败',
  cancelled: '取消',
});

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

export function isTerminalTaskStatus(status: TaskStatus): status is TerminalTaskStatus {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

export function isActiveTaskStatus(status: TaskStatus): status is ActiveTaskStatus {
  return (ACTIVE_TASK_STATUSES as readonly string[]).includes(status);
}

/**
 * The one Task transition table (design §3.2).
 *
 * `created -> queued` is not a status transition: a Task row is created already
 * queued so half a Task never exists. Same-state submission is allowed for
 * reason/phase/cleanup updates and never bumps the version unless the payload
 * actually changes.
 */
const TASK_STATUS_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = Object.freeze({
  queued: Object.freeze(['running', 'needs_action', 'failed', 'cancelled'] as TaskStatus[]),
  running: Object.freeze(['queued', 'needs_action', 'succeeded', 'failed', 'cancelled'] as TaskStatus[]),
  needs_action: Object.freeze(['queued', 'cancelled'] as TaskStatus[]),
  succeeded: Object.freeze([] as TaskStatus[]),
  failed: Object.freeze([] as TaskStatus[]),
  cancelled: Object.freeze([] as TaskStatus[]),
});

export function isTaskStatusTransitionAllowed(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return TASK_STATUS_TRANSITIONS[from].includes(to);
}

export function allowedTaskStatusTransitions(from: TaskStatus): readonly TaskStatus[] {
  return TASK_STATUS_TRANSITIONS[from];
}

/**
 * Current operation phase. A phase only says what the system is doing right now.
 * It carries no transition table and never replaces the Task status.
 */
export const TASK_OPERATION_PHASES = [
  'executing',
  'publishing',
  'delivering',
  'starting_service',
  'retrying',
  'stopping',
  'verifying',
] as const;
export type TaskOperationPhase = (typeof TASK_OPERATION_PHASES)[number];

export function isTaskOperationPhase(value: unknown): value is TaskOperationPhase {
  return typeof value === 'string' && (TASK_OPERATION_PHASES as readonly string[]).includes(value);
}

/**
 * Stable reason codes. Free text is a bounded explanation attached to a code;
 * a code is what clients, tests and projections switch on.
 */
export const TASK_REASON_CODES = [
  'none',
  'user_cancelled',
  'result_acceptance_required',
  'input_required',
  'external_outcome_unknown',
  'no_authorized_driver',
  'port_in_use',
  'command_not_found',
  'service_start_failed',
  'service_health_timeout',
  'delivery_failed',
  'workspace_merge_conflict',
  'execution_failed',
  'retry_exhausted',
  'requirements_incomplete',
  'waiting_for_capacity',
  'cleanup_in_progress',
  'system_anomaly',
] as const;
export type TaskReasonCode = (typeof TASK_REASON_CODES)[number];

export function isTaskReasonCode(value: unknown): value is TaskReasonCode {
  return typeof value === 'string' && (TASK_REASON_CODES as readonly string[]).includes(value);
}

/** Bounds for `state_detail_json`. Detail is structured facts, never a log. */
export const TASK_STATE_DETAIL_LIMITS = Object.freeze({
  messageLength: 320,
  labelLength: 160,
  evidenceRefs: 8,
  unresolved: 8,
  pendingActions: 8,
  requiredWork: 24,
  cleanupObjects: 12,
  evidenceRefLength: 200,
});

export interface TaskReason {
  readonly code: TaskReasonCode;
  readonly message: string;
  readonly evidenceRefs: readonly string[];
}

export type TaskPendingActionKind =
  | 'accept_result'
  | 'retry_attempt'
  | 'provide_input'
  | 'resolve_recovery'
  | 'start_service';

export const TASK_PENDING_ACTION_KINDS: readonly TaskPendingActionKind[] = [
  'accept_result',
  'retry_attempt',
  'provide_input',
  'resolve_recovery',
  'start_service',
];

export function isTaskPendingActionKind(value: unknown): value is TaskPendingActionKind {
  return typeof value === 'string'
    && (TASK_PENDING_ACTION_KINDS as readonly string[]).includes(value);
}

/** Exact result identity a pending acceptance or retry refers to. */
export interface TaskPendingResultIdentity {
  readonly taskId: string;
  readonly generationId: string;
  readonly graphRevision: number;
  readonly subtaskId: string;
  readonly attemptId: string;
  readonly resultId: string;
}

export interface TaskPendingAction {
  readonly actionId: string;
  readonly kind: TaskPendingActionKind;
  readonly label: string;
  readonly reason: TaskReason;
  readonly result: TaskPendingResultIdentity | null;
  /** Isolated Workspace publication that this action accepts. */
  readonly publicationId?: string;
  readonly workspaceMerge?: { readonly jobId:string; readonly conflictVersion:number; readonly rowVersion:number };
}

export type TaskCleanupState = 'none' | 'pending' | 'blocked';

export interface TaskCleanupSummary {
  readonly state: TaskCleanupState;
  readonly objects: readonly string[];
  readonly reason: string;
}

export const NO_TASK_CLEANUP: TaskCleanupSummary = Object.freeze({
  state: 'none',
  objects: Object.freeze([]) as readonly string[],
  reason: '',
});

/** Required-work kinds a work chain must satisfy before the Task can succeed. */
export const TASK_REQUIRED_WORK_KINDS = [
  'execution',
  'integration',
  'workspace_delivery',
  'delivery',
  'safety_report',
  'service',
] as const;
export type TaskRequiredWorkKind = (typeof TASK_REQUIRED_WORK_KINDS)[number];

export const TASK_REQUIRED_WORK_STATES = [
  'pending',
  'running',
  'completed',
  'failed',
  'waiting_for_user',
] as const;
export type TaskRequiredWorkState = (typeof TASK_REQUIRED_WORK_STATES)[number];

export interface TaskRequiredWorkFact {
  readonly key: string;
  readonly kind: TaskRequiredWorkKind;
  readonly label: string;
  readonly state: TaskRequiredWorkState;
  readonly reason: TaskReason | null;
}

/** Persisted `state_detail_json` shape. */
export interface TaskStateDetail {
  readonly reason: TaskReason;
  readonly unresolved: readonly TaskReason[];
  readonly phase: TaskOperationPhase | null;
  readonly pendingActions: readonly TaskPendingAction[];
  readonly requiredWork: readonly TaskRequiredWorkFact[];
  readonly cleanup: TaskCleanupSummary;
  readonly nextWakeAt: string | null;
}

export const EMPTY_TASK_REASON: TaskReason = Object.freeze({
  code: 'none',
  message: '',
  evidenceRefs: Object.freeze([]) as readonly string[],
});

export const EMPTY_TASK_STATE_DETAIL: TaskStateDetail = Object.freeze({
  reason: EMPTY_TASK_REASON,
  unresolved: Object.freeze([]) as readonly TaskReason[],
  phase: null,
  pendingActions: Object.freeze([]) as readonly TaskPendingAction[],
  requiredWork: Object.freeze([]) as readonly TaskRequiredWorkFact[],
  cleanup: NO_TASK_CLEANUP,
  nextWakeAt: null,
});

export function createTaskReason(
  code: TaskReasonCode,
  message = '',
  evidenceRefs: readonly string[] = [],
): TaskReason {
  return {
    code,
    message: boundedText(message, TASK_STATE_DETAIL_LIMITS.messageLength),
    evidenceRefs: boundedStrings(evidenceRefs, TASK_STATE_DETAIL_LIMITS.evidenceRefs,
      TASK_STATE_DETAIL_LIMITS.evidenceRefLength),
  };
}

/** Clients read this snapshot; it is the whole current Task conclusion. */
export interface TaskStateSnapshot {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly stateVersion: number;
  readonly reason: TaskReason;
  readonly phase: TaskOperationPhase | null;
  readonly pendingActions: readonly TaskPendingAction[];
  readonly cleanup: TaskCleanupSummary;
  readonly nextWakeAt: string | null;
  readonly completedAt: string | null;
  readonly archivedAt: string | null;
  readonly retryOfTaskId: string | null;
}

/** Input facts for the one Task summary rule (design §3.3). */
export interface TaskEvaluationFacts {
  readonly taskId: string;
  readonly currentStatus: TaskStatus;
  /** A committed user cancellation fence exists. */
  readonly cancelFence: boolean;
  /** Required work derived from the authorized Work Graph revision. */
  readonly requiredWork: readonly TaskRequiredWorkFact[];
  /** Everything the user still has to resolve or confirm. */
  readonly pendingActions: readonly TaskPendingAction[];
  /** Authorized work that is ready and not blocked by a failed dependency. */
  readonly runnableWork: boolean;
  /** A real business action is happening (execution, publish, delivery, service start). */
  readonly activeOperation: { readonly phase: TaskOperationPhase; readonly reason: TaskReason | null } | null;
  /** A bounded automatic retry is authorized and armed. */
  readonly boundedRecovery: { readonly nextWakeAt: string; readonly reason: TaskReason | null } | null;
  /** Conversation slot reservation state for this Task. */
  readonly slot: 'none' | 'held';
  /** Ready work is only waiting for capacity or resource availability. */
  readonly capacityWaiting: boolean;
  /** Safe shutdown / verification facts for this Task's operations. */
  readonly cleanup: TaskCleanupSummary;
  /** Stable fallback reason the caller already knows (e.g. port conflict). */
  readonly failureReason: TaskReason | null;
  /** A caller-detected anomaly that is not expressible as work facts. */
  readonly anomaly: TaskReason | null;
  readonly observedAt: string;
}

export interface TaskEvaluation {
  readonly status: TaskStatus;
  readonly detail: TaskStateDetail;
}

/**
 * The one Task summary function.
 *
 * Pure: it never reads a repository, the clock or a log. The Kernel is the
 * policy caller; Gateway, recovery workers and service managers never call it
 * to change state themselves.
 */
export function evaluateTaskState(facts: TaskEvaluationFacts): TaskEvaluation {
  const evaluation = evaluate(facts);
  // `needs_action` never jumps straight to running: the Task re-enters the queue
  // and only an admitted dispatch (an active operation) makes it executing.
  return facts.currentStatus === 'needs_action' && evaluation.status === 'running'
    ? {
        status: 'queued',
        detail: { ...evaluation.detail, phase: null,
          reason: createTaskReason('waiting_for_capacity', '等待执行名额。') },
      }
    : evaluation;
}

function evaluate(facts: TaskEvaluationFacts): TaskEvaluation {
  // 1. A terminal Task keeps its conclusion. Cleanup and audit facts may still
  //    be recorded, but they never reopen the Task.
  if (isTerminalTaskStatus(facts.currentStatus)) {
    return {
      status: facts.currentStatus,
      detail: buildDetail(facts, requiredReasonForTerminal(facts.currentStatus, facts)),
    };
  }

  // 2. A committed user cancellation fence wins over every completion claim.
  if (facts.cancelFence) {
    return {
      status: 'cancelled',
      detail: buildDetail(facts, createTaskReason('user_cancelled', '用户取消了任务。')),
    };
  }

  // 3. Real work is happening: an active operation, a bounded automatic
  //    recovery, or runnable work that already owns the Conversation slot.
  if (facts.activeOperation) {
    return {
      status: 'running',
      detail: buildDetail(
        facts,
        facts.activeOperation.reason ?? primaryRunningReason(facts),
        facts.activeOperation.phase,
      ),
    };
  }
  if (facts.boundedRecovery) {
    return {
      status: 'running',
      detail: buildDetail(
        facts,
        facts.boundedRecovery.reason ?? createTaskReason('none', '自动重试已排期。'),
        'retrying',
      ),
    };
  }
  // Holding the slot is not by itself an action: a Task that leaves
  // `needs_action` re-enters the queue and only becomes `running` when the
  // dispatch is actually admitted (design §4.3 step 4/5).
  if (facts.slot === 'held' && facts.runnableWork && !facts.capacityWaiting
    && facts.currentStatus !== 'needs_action') {
    return {
      status: 'running',
      detail: buildDetail(facts, primaryRunningReason(facts), null),
    };
  }

  // 4. Required work definitively failed and no recovery remains this round.
  const failedRequired = facts.requiredWork.filter(work => work.state === 'failed');
  if (failedRequired.length > 0) {
    return {
      status: 'failed',
      detail: buildDetail(facts, failedRequired[0]!.reason ?? facts.failureReason
        ?? createTaskReason('execution_failed', '必需工作失败。')),
    };
  }

  // 5. Nothing can advance automatically and the user must act.
  if (facts.pendingActions.length > 0 && !facts.runnableWork) {
    return {
      status: 'needs_action',
      detail: buildDetail(facts, facts.pendingActions[0]!.reason),
    };
  }

  // 6. Every required work item is complete: the Task succeeded. Safe shutdown
  //    is verified by the release protocol, not by this function.
  if (facts.requiredWork.length > 0
    && facts.requiredWork.every(work => work.state === 'completed')) {
    return {
      status: 'succeeded',
      detail: buildDetail(facts, createTaskReason('none', '用户要求的必需工作已全部完成。')),
    };
  }

  // 7. Ready work is only missing a slot or a resource.
  if (facts.runnableWork || facts.capacityWaiting) {
    return {
      status: 'queued',
      detail: buildDetail(facts, createTaskReason('waiting_for_capacity', '等待执行名额。')),
    };
  }

  // 8. Nothing above holds: this is a system anomaly, never a default running
  //    Task. Safety uncertainty enters `needs_action`; a proven dead end fails.
  const anomaly = facts.anomaly
    ?? createTaskReason('no_authorized_driver', '没有可继续的授权工作，也没有明确的用户事项。');
  const uncertain = anomaly.code === 'no_authorized_driver'
    || anomaly.code === 'external_outcome_unknown'
    || anomaly.code === 'system_anomaly'
    || anomaly.code === 'input_required'
    || anomaly.code === 'result_acceptance_required'
    || facts.cleanup.state !== 'none';
  return uncertain
    ? { status: 'needs_action', detail: buildDetail(facts, anomaly) }
    : { status: 'failed', detail: buildDetail(facts, anomaly) };
}

function primaryRunningReason(facts: TaskEvaluationFacts): TaskReason {
  const running = facts.requiredWork.find(work => work.state === 'running');
  return running?.reason ?? facts.failureReason ?? createTaskReason('none', '系统正在执行任务。');
}

function requiredReasonForTerminal(status: TerminalTaskStatus, facts: TaskEvaluationFacts): TaskReason {
  const existing = facts.pendingActions[0]?.reason;
  if (status === 'cancelled') {
    return existing?.code === 'user_cancelled'
      ? existing
      : createTaskReason('user_cancelled', '用户取消了任务。');
  }
  if (status === 'failed') {
    return facts.failureReason ?? createTaskReason('execution_failed', '任务失败。');
  }
  return createTaskReason('none', '用户要求的必需工作已全部完成。');
}

function buildDetail(
  facts: TaskEvaluationFacts,
  reason: TaskReason,
  phase: TaskOperationPhase | null = null,
  extraUnresolved?: TaskReason,
): TaskStateDetail {
  const unresolved: TaskReason[] = [];
  const seen = new Set<string>([reason.code]);
  for (const work of facts.requiredWork) {
    if (work.state !== 'failed' && work.state !== 'waiting_for_user') continue;
    const workReason = work.reason;
    if (!workReason || seen.has(workReason.code)) continue;
    seen.add(workReason.code);
    unresolved.push(workReason);
  }
  for (const action of facts.pendingActions) {
    if (seen.has(action.reason.code)) continue;
    seen.add(action.reason.code);
    unresolved.push(action.reason);
  }
  if (extraUnresolved && !seen.has(extraUnresolved.code)) unresolved.push(extraUnresolved);
  return {
    reason,
    unresolved: unresolved.slice(0, TASK_STATE_DETAIL_LIMITS.unresolved),
    phase,
    pendingActions: facts.pendingActions.slice(0, TASK_STATE_DETAIL_LIMITS.pendingActions),
    requiredWork: facts.requiredWork.slice(0, TASK_STATE_DETAIL_LIMITS.requiredWork),
    cleanup: facts.cleanup,
    nextWakeAt: facts.boundedRecovery?.nextWakeAt ?? null,
  };
}

/**
 * Normalizes persisted detail JSON. Detail is always bounded and typed; an
 * unexpected field is dropped instead of being rendered to a client.
 */
export function normalizeTaskStateDetail(value: unknown): TaskStateDetail {
  if (!value || typeof value !== 'object') return EMPTY_TASK_STATE_DETAIL;
  const source = value as Record<string, unknown>;
  return {
    reason: normalizeReason(source.reason) ?? EMPTY_TASK_REASON,
    unresolved: Array.isArray(source.unresolved)
      ? source.unresolved
        .map(normalizeReason)
        .filter((entry): entry is TaskReason => entry !== null)
        .slice(0, TASK_STATE_DETAIL_LIMITS.unresolved)
      : [],
    phase: isTaskOperationPhase(source.phase) ? source.phase : null,
    pendingActions: Array.isArray(source.pendingActions)
      ? source.pendingActions
        .map(normalizePendingAction)
        .filter((entry): entry is TaskPendingAction => entry !== null)
        .slice(0, TASK_STATE_DETAIL_LIMITS.pendingActions)
      : [],
    requiredWork: Array.isArray(source.requiredWork)
      ? source.requiredWork
        .map(normalizeRequiredWork)
        .filter((entry): entry is TaskRequiredWorkFact => entry !== null)
        .slice(0, TASK_STATE_DETAIL_LIMITS.requiredWork)
      : [],
    cleanup: normalizeCleanup(source.cleanup),
    nextWakeAt: typeof source.nextWakeAt === 'string' && source.nextWakeAt.length > 0
      ? source.nextWakeAt
      : null,
  };
}

const CLEANUP_STATES: readonly TaskCleanupState[] = ['none', 'pending', 'blocked'];

export function normalizeCleanup(value: unknown): TaskCleanupSummary {
  if (!value || typeof value !== 'object') return NO_TASK_CLEANUP;
  const source = value as Record<string, unknown>;
  const state = typeof source.state === 'string'
    && (CLEANUP_STATES as readonly string[]).includes(source.state)
    ? source.state as TaskCleanupState
    : 'none';
  return {
    state,
    objects: Array.isArray(source.objects)
      ? boundedStrings(
        source.objects.filter((entry): entry is string => typeof entry === 'string'),
        TASK_STATE_DETAIL_LIMITS.cleanupObjects,
        TASK_STATE_DETAIL_LIMITS.evidenceRefLength,
      )
      : [],
    reason: boundedText(
      typeof source.reason === 'string' ? source.reason : '',
      TASK_STATE_DETAIL_LIMITS.messageLength,
    ),
  };
}

function normalizeReason(value: unknown): TaskReason | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  if (!isTaskReasonCode(source.code)) return null;
  return createTaskReason(
    source.code,
    typeof source.message === 'string' ? source.message : '',
    Array.isArray(source.evidenceRefs)
      ? source.evidenceRefs.filter((entry): entry is string => typeof entry === 'string')
      : [],
  );
}

function normalizePendingAction(value: unknown): TaskPendingAction | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  if (typeof source.actionId !== 'string' || !isTaskPendingActionKind(source.kind)) return null;
  const reason = normalizeReason(source.reason) ?? EMPTY_TASK_REASON;
  return {
    actionId: boundedText(source.actionId, TASK_STATE_DETAIL_LIMITS.evidenceRefLength),
    kind: source.kind,
    label: boundedText(
      typeof source.label === 'string' ? source.label : '',
      TASK_STATE_DETAIL_LIMITS.labelLength,
    ),
    reason,
    result: normalizePendingResultIdentity(source.result),
    ...(typeof source.publicationId === 'string' ? { publicationId: boundedText(source.publicationId, TASK_STATE_DETAIL_LIMITS.evidenceRefLength) } : {}),
  };
}

export function normalizePendingResultIdentity(value: unknown): TaskPendingResultIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  if (
    typeof source.taskId !== 'string'
    || typeof source.generationId !== 'string'
    || typeof source.graphRevision !== 'number'
    || typeof source.subtaskId !== 'string'
    || typeof source.attemptId !== 'string'
    || typeof source.resultId !== 'string'
  ) return null;
  return {
    taskId: source.taskId,
    generationId: source.generationId,
    graphRevision: source.graphRevision,
    subtaskId: source.subtaskId,
    attemptId: source.attemptId,
    resultId: source.resultId,
  };
}

function normalizeRequiredWork(value: unknown): TaskRequiredWorkFact | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  if (
    typeof source.key !== 'string'
    || typeof source.kind !== 'string'
    || !(TASK_REQUIRED_WORK_KINDS as readonly string[]).includes(source.kind)
    || typeof source.state !== 'string'
    || !(TASK_REQUIRED_WORK_STATES as readonly string[]).includes(source.state)
  ) return null;
  return {
    key: boundedText(source.key, TASK_STATE_DETAIL_LIMITS.evidenceRefLength),
    kind: source.kind as TaskRequiredWorkKind,
    label: boundedText(
      typeof source.label === 'string' ? source.label : '',
      TASK_STATE_DETAIL_LIMITS.labelLength,
    ),
    state: source.state as TaskRequiredWorkState,
    reason: normalizeReason(source.reason),
  };
}

function boundedText(value: string, limit: number): string {
  const normalized = value.replace(/[\r\n\t]+/gu, ' ').trim();
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

function boundedStrings(values: readonly string[], limit: number, length: number): string[] {
  const unique: string[] = [];
  for (const value of values) {
    const bounded = boundedText(value, length);
    if (!bounded || unique.includes(bounded)) continue;
    unique.push(bounded);
    if (unique.length >= limit) break;
  }
  return unique;
}
