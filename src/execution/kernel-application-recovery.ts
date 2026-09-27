import type { KernelEvent } from '../kernel/control-kernel.js';
import type { KernelDecisionApplicationRecord } from '../kernel/kernel-workflow.js';
import type {
  KernelAttemptPayload,
  KernelAttemptKind,
  KernelDecisionAction,
  KernelDispatchItemStatus,
} from '../kernel/control-kernel.js';
import type {
  GenerationReplanRequestRecord,
  GenerationReplanRequestStatus,
} from '../storage/generation-replan-request-repo.js';
import type { WorkGraphRevisionRecord } from '../storage/work-graph-revision-repo.js';

export const LEGACY_SYSTEM_BINDING_CALLBACK_ERROR =
  'Conversation execution callback is unavailable: onDecisionApplying';
export const MERGE_REPLAN_SYSTEM_BINDING_CALLBACK_ERROR =
  'startup recovery requires the originating Conversation Planner for merge replan';

/**
 * Action-specific postcondition verdict (2026-09-25 plan §6).
 *
 * - `applied`: the declared postcondition is durably present.
 * - `retry_safe`: the postcondition is absent and re-applying the same Decision
 *   cannot duplicate a durable effect.
 * - `unresolved`: the outcome is unknowable or contradictory; the application
 *   stays `uncertain` and must reach the user as `recovery_required`.
 * - `not_managed`: a dedicated reconciler owns this action family.
 */
export type ApplicationPostconditionVerdict =
  | 'applied'
  | 'retry_safe'
  | 'unresolved'
  | 'not_managed';

export type ApplicationPostconditionFamily =
  | 'dispatch'
  | 'replan'
  | 'task_transition'
  | 'plan_activation'
  | 'observation_only'
  | 'not_managed';

export interface ApplicationPostconditionInspection {
  readonly family: ApplicationPostconditionFamily;
  readonly verdict: ApplicationPostconditionVerdict;
  readonly reason: string;
}

export interface DispatchItemFact {
  readonly attemptId: string;
  readonly decisionId: string;
  readonly causationId: string | null;
  readonly subtaskId: string;
  readonly generationId: string;
  readonly attemptKind: string;
  readonly bindingFingerprint: string;
  readonly configurationRevision: string;
  readonly sourceAttemptId: string | null;
  readonly status: KernelDispatchItemStatus;
}

export interface TaskFact {
  readonly id: string;
  readonly status: string;
  readonly dependencies: readonly { type: string; status: string }[];
}

export interface WorkGraphRevisionFact {
  readonly revision: number;
  readonly generationId: string;
  readonly authorizedDecisionId: string | null;
  readonly status: string;
}

export interface ApplicationPostconditionFacts {
  readonly application: KernelDecisionApplicationRecord;
  readonly task: TaskFact | null;
  readonly subtasks: readonly { id: string; status: string }[];
  readonly dispatchItems: readonly DispatchItemFact[];
  /** The graph revision named by the Decision, when the action names one. */
  readonly workGraphRevision: WorkGraphRevisionFact | null;
  readonly replanRequest: GenerationReplanRequestRecord | null;
  /** Replan Job looked up by its deterministic id, for `queue_generation_replan`. */
  readonly queuedReplanRequest: GenerationReplanRequestRecord | null;
}

/**
 * Narrow read ports one postcondition inspection needs. Both the startup sweep
 * and the explicit `/task recovery` diagnostic read through this seam so the
 * verdict the user sees is the same verdict recovery acts on.
 */
export interface ApplicationPostconditionFactSource {
  findTask(taskId: string): TaskFact | null;
  listSubtasks(taskId: string): readonly { id: string; status: string }[];
  listDispatchItems(taskId: string): readonly DispatchItemFact[];
  findWorkGraphRevision(taskId: string, revision: number): WorkGraphRevisionFact | null;
  findReplanRequest(
    taskId: string,
    generationId: string,
    sourceRevision: number,
  ): GenerationReplanRequestRecord | null;
  /** Replan Job by its deterministic id, independent of generation/revision. */
  findReplanRequestById(id: string): GenerationReplanRequestRecord | null;
}

export function inspectApplicationAgainstSources(
  application: KernelDecisionApplicationRecord,
  sources: ApplicationPostconditionFactSource,
): ApplicationPostconditionInspection {
  const action = application.decision.action;
  const taskId = 'taskId' in action ? action.taskId : null;
  const namesRevision = action.type === 'authorize_task_plan'
    || action.type === 'activate_deferred_task_plan';
  return inspectApplicationPostcondition({
    application,
    task: taskId ? sources.findTask(taskId) : null,
    subtasks: taskId ? sources.listSubtasks(taskId) : [],
    dispatchItems: taskId ? sources.listDispatchItems(taskId) : [],
    workGraphRevision: taskId && namesRevision
      ? sources.findWorkGraphRevision(taskId, action.graphRevision)
      : null,
    replanRequest: action.type === 'schedule_replan' || action.type === 'request_replan'
      ? sources.findReplanRequest(action.taskId, action.generationId, action.sourceRevision)
      : action.type === 'defer_task_plan_for_availability'
        ? sources.findReplanRequest(
            action.taskId,
            action.proposalEvent.generationId,
            action.proposalEvent.targetGraphRevision - 1,
          )
        : null,
    queuedReplanRequest: action.type === 'queue_generation_replan'
      ? sources.findReplanRequestById(action.requestId)
      : null,
  });
}

/**
 * Action families that a dedicated reconciler already owns. The generic sweep
 * must not double-resolve them: cancellation has
 * `reconcileUncertainCancellations`, external effects have the outbox, and the
 * merge/system-binding paths have their own Kernel-authorized recovery events.
 */
const UNMANAGED_ACTIONS = new Set<string>([
  'cancel_task',
  'cancel_subtasks',
  'request_merge_replan',
  'resolve_recovery',
  'grant_capability',
  'deny_capability',
  'escalate_capability',
  'deliver_direct_reply',
  'authorize_task_control',
  'reject_request',
  'request_clarification',
  'record_permission_resolution',
  'recover_workspace_attempt',
]);

/**
 * Actions with no durable state write at all. `markApplied` inserts their
 * observation event atomically with the `applied` transition, and their apply
 * has no other effect, so re-applying the same Decision cannot duplicate
 * anything.
 */
const EFFECT_FREE_ACTIONS = new Set<string>([
  'no_op',
  'probe_capacity',
]);

export function inspectApplicationPostcondition(
  facts: ApplicationPostconditionFacts,
): ApplicationPostconditionInspection {
  const action = facts.application.decision.action;
  if (UNMANAGED_ACTIONS.has(action.type)) {
    return {
      family: 'not_managed',
      verdict: 'not_managed',
      reason: `${action.type} is owned by a dedicated reconciler`,
    };
  }
  switch (action.type) {
    case 'dispatch_batch':
      return inspectDispatch(facts, action.items);
    case 'schedule_replan':
    case 'request_replan':
      return inspectReplanScheduling(facts);
    case 'authorize_task_plan':
    case 'activate_deferred_task_plan':
      return inspectPlanActivation(facts);
    case 'block_work':
    case 'complete_task':
    case 'accept_partial_result':
      return inspectTaskTransition(facts);
    case 'resume_task':
      return inspectResume(facts);
    case 'park_for_replan':
      return inspectParkedForReplan(facts);
    case 'defer_task_plan_for_availability':
      return inspectAvailabilityDeferral(facts);
    case 'queue_generation_replan':
      return inspectQueuedGenerationReplan(facts);
    case 'wait_for_capacity':
      return inspectCapacityWait(facts);
    case 'wait_for_retry':
    case 'wait_for_partition':
      // The apply blocks the Task and emits the wake observation that is the
      // real continuation trigger. `markApplied` is atomic, so an uncertain
      // outcome proves the wake was never emitted; re-applying the same
      // Decision re-blocks (a no-op) and re-emits it.
      return {
        family: 'task_transition',
        verdict: 'retry_safe',
        reason: `${action.type} must re-emit its wake observation; re-application is idempotent`,
      };
    default:
      if (EFFECT_FREE_ACTIONS.has(action.type)) {
        return {
          family: 'observation_only',
          verdict: 'applied',
          reason: `${action.type} has no durable state write`,
        };
      }
      return {
        family: 'not_managed',
        verdict: 'unresolved',
        reason: `no postcondition is declared for ${action.type}`,
      };
  }
}

/**
 * `resume_task` writes Subtask and Task state and then emits the
 * `dispatch_requested` observation that drives the *next* Decision. The
 * downstream `dispatch_batch` therefore carries its own Decision id, so the
 * resume is satisfied only when a dispatch item for the resumed Subtask in the
 * same generation is already durable (2026-09-25 review fix).
 */
function inspectResume(
  facts: ApplicationPostconditionFacts,
): ApplicationPostconditionInspection {
  const action = facts.application.decision.action;
  if (action.type !== 'resume_task') {
    return { family: 'not_managed', verdict: 'unresolved', reason: 'unexpected action' };
  }
  const targetSubtaskIds = action.subtaskIds.length > 0
    ? action.subtaskIds
    : action.recovery
      ? [action.recovery.subtaskId]
      : [];
  if (targetSubtaskIds.length === 0) {
    return {
      family: 'task_transition',
      verdict: 'unresolved',
      reason: 'resume does not name a Subtask or recovery target',
    };
  }
  const missingSubtasks = targetSubtaskIds.filter(subtaskId => (
    !facts.subtasks.some(item => item.id === subtaskId)
  ));
  if (missingSubtasks.length > 0) {
    return {
      family: 'task_transition',
      verdict: 'unresolved',
      reason: `resume targets missing Subtask(s): ${missingSubtasks.join(', ')}`,
    };
  }
  const stillBlocked = targetSubtaskIds.filter(subtaskId => (
    facts.subtasks.find(item => item.id === subtaskId)?.status === 'blocked'
  ));
  const dispatchLanded = targetSubtaskIds.every(subtaskId => facts.dispatchItems.some(item => (
    item.subtaskId === subtaskId
    && item.generationId === action.generationId
    && item.causationId === facts.application.decisionId
    && item.status !== 'cancelled'
    && (!action.recovery || (
      item.attemptKind === action.recovery.attemptKind
      && item.bindingFingerprint === action.recovery.bindingFingerprint
      && item.configurationRevision === action.recovery.authorizedBinding.configurationRevision
      && item.sourceAttemptId === action.recovery.sourceAttemptId
    ))
  )));
  if (stillBlocked.length === 0 && dispatchLanded) {
    return {
      family: 'task_transition',
      verdict: 'applied',
      reason: 'the resumed Subtask is unblocked and its downstream dispatch is durable',
    };
  }
  return {
    family: 'task_transition',
    verdict: 'retry_safe',
    reason: stillBlocked.length > 0
      ? `resume is incomplete: Subtask ${stillBlocked.join(', ')} is still blocked`
      : 'the resume continuation is not durable yet; replay is idempotent by Decision id',
  };
}

/**
 * A dispatch batch is satisfied only when each authorized item landed with its
 * full authorization identity: the same Decision, Subtask, generation, attempt
 * kind, binding fingerprint and configuration revision (2026-09-25 review fix).
 */
function inspectDispatch(
  facts: ApplicationPostconditionFacts,
  expected: readonly Extract<
    KernelDecisionAction,
    { type: 'dispatch_batch' }
  >['items'][number][],
): ApplicationPostconditionInspection {
  const decisionId = facts.application.decisionId;
  const matched = expected.filter(item => facts.dispatchItems.some(candidate => (
    candidate.attemptId === item.attemptId
    && candidate.decisionId === decisionId
    && candidate.subtaskId === item.subtaskId
    && candidate.attemptKind === item.attemptKind
    && candidate.bindingFingerprint === item.bindingFingerprint
    && candidate.configurationRevision === facts.application.decision.configurationRevision
  )));
  if (matched.length === expected.length && expected.length > 0) {
    return {
      family: 'dispatch',
      verdict: 'applied',
      reason: 'every authorized dispatch item landed with the same Decision and binding identity',
    };
  }
  if (matched.length === 0) {
    return {
      family: 'dispatch',
      verdict: 'retry_safe',
      reason: 'no authorized dispatch item landed; the Decision may be re-applied',
    };
  }
  return {
    family: 'dispatch',
    verdict: 'unresolved',
    reason: `partial dispatch batch: ${matched.length}/${expected.length} items landed with matching identity`,
  };
}

function inspectReplanScheduling(
  facts: ApplicationPostconditionFacts,
): ApplicationPostconditionInspection {
  if (isSatisfiedReplanScheduling({
    application: facts.application,
    replanRequest: facts.replanRequest,
  })) {
    return {
      family: 'replan',
      verdict: 'applied',
      reason: 'the Replan Job carries this Decision quiescence token',
    };
  }
  if (isRetrySafeUncertainReplanScheduling({
    application: facts.application,
    replanRequest: facts.replanRequest,
  })) {
    return {
      family: 'replan',
      verdict: 'retry_safe',
      reason: 'the Replan Job is still waiting for quiescence',
    };
  }
  return {
    family: 'replan',
    verdict: 'unresolved',
    reason: `Replan Job is ${facts.replanRequest?.status ?? 'missing'}`,
  };
}

function inspectPlanActivation(
  facts: ApplicationPostconditionFacts,
): ApplicationPostconditionInspection {
  const action = facts.application.decision.action;
  if (action.type !== 'authorize_task_plan' && action.type !== 'activate_deferred_task_plan') {
    return { family: 'plan_activation', verdict: 'unresolved', reason: 'unexpected action' };
  }
  const revision = facts.workGraphRevision;
  if (revision
    && revision.revision === action.graphRevision
    && revision.generationId === action.generationId) {
    // The revision must have been authorized by *this* Decision. A revision
    // written by another Decision is a conflict, not a success.
    const authorizedBy = revision.authorizedDecisionId;
    if (authorizedBy === null || authorizedBy === facts.application.decisionId) {
      return {
        family: 'plan_activation',
        verdict: 'applied',
        reason: `graph revision ${action.graphRevision} is durable and authorized by this Decision`,
      };
    }
    return {
      family: 'plan_activation',
      verdict: 'unresolved',
      reason: `graph revision ${action.graphRevision} was authorized by ${authorizedBy}`,
    };
  }
  if (action.type === 'authorize_task_plan' && action.proposalSource === 'initial') {
    return {
      family: 'plan_activation',
      verdict: 'retry_safe',
      reason: 'the initial graph revision did not land and its Task id is deterministic',
    };
  }
  return {
    family: 'plan_activation',
    verdict: 'unresolved',
    reason: 'a replan graph revision requires explicit recovery',
  };
}

function inspectTaskTransition(
  facts: ApplicationPostconditionFacts,
): ApplicationPostconditionInspection {
  const action = facts.application.decision.action;
  const taskStatus = facts.task?.status ?? null;
  if (action.type === 'complete_task' || action.type === 'accept_partial_result') {
    return taskStatus === 'done' || taskStatus === 'archived'
      ? { family: 'task_transition', verdict: 'applied', reason: 'the Task reached its terminal state' }
      : { family: 'task_transition', verdict: 'retry_safe', reason: 'the Task is not terminal yet' };
  }
  if (action.type === 'block_work') {
    // The Runtime performs the Subtask blocker write *before* the Task block, so
    // a half-applied decision leaves the Task `running` with a blocked Subtask.
    // The postcondition must require the whole operation, otherwise recovery
    // would skip the missing Task block (2026-09-25 review fix 3).
    const namedSubtask = action.subtaskId === null
      ? null
      : facts.subtasks.find(item => item.id === action.subtaskId) ?? null;
    if (action.subtaskId !== null && namedSubtask === null) {
      // A missing named target is not evidence that the Subtask was already
      // resolved. The durable effect cannot be verified in either Task state.
      return {
        family: 'task_transition',
        verdict: 'unresolved',
        reason: `the named Subtask ${action.subtaskId} does not exist`,
      };
    }
    const subtaskIncomplete = action.subtaskId !== null
      && action.preserveSubtaskState !== true
      && !['blocked', 'done', 'cancelled'].includes(namedSubtask!.status);
    if (taskStatus === 'blocked' && !subtaskIncomplete) {
      return { family: 'task_transition', verdict: 'applied', reason: 'the Task block is durable' };
    }
    return {
      family: 'task_transition',
      verdict: 'retry_safe',
      reason: taskStatus === 'blocked'
        ? `the Task is blocked but Subtask ${action.subtaskId} is still ${namedSubtask?.status}`
        : 'the Task block is not durable yet',
    };
  }
  if (action.type === 'park_for_replan') {
    return taskStatus === 'parked' || taskStatus === 'blocked'
      ? { family: 'task_transition', verdict: 'applied', reason: 'the Task is parked for replan' }
      : { family: 'task_transition', verdict: 'retry_safe', reason: 'the Task is not parked yet' };
  }
  return {
    family: 'task_transition',
    verdict: 'unresolved',
    reason: `no Task transition postcondition is declared for ${action.type}`,
  };
}

/**
 * `park_for_replan` writes the Task's strategic `parked` state, so it is a real
 * transition rather than an observation.
 */
function inspectParkedForReplan(
  facts: ApplicationPostconditionFacts,
): ApplicationPostconditionInspection {
  const taskStatus = facts.task?.status ?? null;
  if (taskStatus === 'parked') {
    return { family: 'task_transition', verdict: 'applied', reason: 'the Task is parked' };
  }
  if (taskStatus !== null && ['done', 'archived', 'cancelled'].includes(taskStatus)) {
    return {
      family: 'task_transition',
      verdict: 'applied',
      reason: 'the Task already reached a terminal state',
    };
  }
  return {
    family: 'task_transition',
    verdict: 'retry_safe',
    reason: 'the Task is not parked yet',
  };
}

/**
 * `defer_task_plan_for_availability` persists the deferred proposal *and* blocks
 * the Task. Both halves are required: a persisted deferral with a still-running
 * Task must be re-applied so the block lands (2026-09-25 review fix).
 */
function inspectAvailabilityDeferral(
  facts: ApplicationPostconditionFacts,
): ApplicationPostconditionInspection {
  const deferred = facts.replanRequest?.status === 'waiting_for_availability';
  const taskStatus = facts.task?.status ?? null;
  if (deferred && taskStatus === 'blocked') {
    return {
      family: 'task_transition',
      verdict: 'applied',
      reason: 'the deferred proposal and the Task blocker are both durable',
    };
  }
  if (deferred) {
    return {
      family: 'task_transition',
      verdict: 'retry_safe',
      reason: `the proposal is deferred but the Task is ${taskStatus ?? 'missing'}`,
    };
  }
  return {
    family: 'task_transition',
    verdict: 'retry_safe',
    reason: `the Replan Job is ${facts.replanRequest?.status ?? 'missing'}; the deferral may be re-applied`,
  };
}

/**
 * `queue_generation_replan` persists the coalesced Replan Job and emits the
 * observation that lets the Kernel continue independent work. While the Task is
 * still executing, that observation is the only thing that will re-evaluate
 * quiescence, so it must be re-emitted rather than assumed.
 */
function inspectQueuedGenerationReplan(
  facts: ApplicationPostconditionFacts,
): ApplicationPostconditionInspection {
  const action = facts.application.decision.action;
  if (action.type !== 'queue_generation_replan') {
    return { family: 'not_managed', verdict: 'unresolved', reason: 'unexpected action' };
  }
  if (!facts.queuedReplanRequest) {
    return {
      family: 'replan',
      verdict: 'retry_safe',
      reason: 'the Replan Job was not persisted; the Decision may be re-applied',
    };
  }
  const taskStatus = facts.task?.status ?? null;
  if (taskStatus !== null && ['blocked', 'parked', 'done', 'archived', 'cancelled'].includes(taskStatus)) {
    return {
      family: 'replan',
      verdict: 'applied',
      reason: 'the Replan Job is durable and the Task is not executing',
    };
  }
  return {
    family: 'replan',
    verdict: 'retry_safe',
    reason: 'the Replan Job is durable but the quiescence observation still has to be re-emitted',
  };
}

/**
 * `wait_for_capacity` blocks the Task and relies on the periodic capacity
 * recheck as its wake, which is driven independently of this Decision. Once the
 * block is durable the Decision is complete.
 */
function inspectCapacityWait(
  facts: ApplicationPostconditionFacts,
): ApplicationPostconditionInspection {
  const task = facts.task;
  if (task?.status === 'blocked') {
    return {
      family: 'task_transition',
      verdict: 'applied',
      reason: 'the capacity blocker is durable and the periodic recheck owns the wake',
    };
  }
  if (task !== null && ['done', 'archived', 'cancelled'].includes(task.status)) {
    return { family: 'task_transition', verdict: 'applied', reason: 'the Task is terminal' };
  }
  return {
    family: 'task_transition',
    verdict: 'retry_safe',
    reason: 'the capacity blocker is not durable yet',
  };
}

/**
 * Postcondition for the durable Replan Job action family (2026-09-25 plan §6).
 *
 * `schedule_replan` and its legacy predecessor `request_replan` are satisfied
 * once the Job carries the quiescence token derived from this exact Decision,
 * because that token is only written together with the durable Job state
 * transition. A Job still in `pending_quiescence` is safe to retry; anything
 * else must fail closed through Kernel-authorized recovery rather than loop.
 */
export function isSatisfiedReplanScheduling(input: {
  application: KernelDecisionApplicationRecord;
  replanRequest: GenerationReplanRequestRecord | null;
}): boolean {
  const action = input.application.decision.action;
  if (input.application.status !== 'uncertain') return false;
  if (action.type !== 'schedule_replan' && action.type !== 'request_replan') return false;
  const request = input.replanRequest;
  if (!request || request.taskId !== action.taskId) return false;
  if (action.type === 'schedule_replan' && request.id !== action.replanJobId) return false;
  if (request.quiescenceToken !== `quiescence_${input.application.decisionId}`) return false;
  return ['planning', 'submitted', 'waiting_for_availability', 'resolved', 'failed']
    .includes(request.status);
}

/** True when an uncertain replan scheduling is safe to re-apply unchanged. */
export function isRetrySafeUncertainReplanScheduling(input: {
  application: KernelDecisionApplicationRecord;
  replanRequest: GenerationReplanRequestRecord | null;
}): boolean {
  const action = input.application.decision.action;
  if (input.application.status !== 'uncertain') return false;
  if (action.type !== 'schedule_replan' && action.type !== 'request_replan') return false;
  return input.replanRequest?.status === 'pending_quiescence';
}

export function isRetrySafeLegacySystemBindingReplan(input: {
  taskId: string;
  application: KernelDecisionApplicationRecord;
  activeRevision: WorkGraphRevisionRecord | null;
  replanRequest: GenerationReplanRequestRecord | null;
}): boolean {
  const action = input.application.decision.action;
  return Boolean(
    input.activeRevision
    && input.application.status === 'uncertain'
    && input.application.errorSummary === LEGACY_SYSTEM_BINDING_CALLBACK_ERROR
    && action.type === 'authorize_task_plan'
    && action.taskId === input.taskId
    && action.proposalSource === 'replan'
    && action.generationId === input.activeRevision.generationId
    && action.graphRevision === input.activeRevision.revision + 1
    && input.replanRequest?.status === 'submitted',
  );
}

export function legacySystemBindingRecoveryEvent(input: {
  taskId: string;
  application: KernelDecisionApplicationRecord;
  sessionId: string;
  occurredAt: string;
}): Extract<KernelEvent, { type: 'recovery_resolution_requested' }> {
  return {
    schemaVersion: 5,
    configurationRevision: input.application.decision.configurationRevision,
    type: 'recovery_resolution_requested',
    id: `recovery_event_system_binding_${input.application.id}`,
    correlationId: input.taskId,
    causationId: input.application.decisionId,
    occurredAt: input.occurredAt,
    sessionId: input.sessionId,
    taskId: input.taskId,
    recoveryItemId: input.application.id,
    resolution: 'retry',
  };
}

export function isRetrySafeMergeRepairReplan(input: {
  taskId: string;
  application: KernelDecisionApplicationRecord;
  publication: {
    id: string;
    taskId: string;
    status: string;
  } | null;
  dispatchItems: Array<{
    attemptKind: KernelAttemptKind;
    status: KernelDispatchItemStatus;
    attemptPayload: KernelAttemptPayload;
    errorSummary: string | null;
  }>;
}): boolean {
  const action = input.application.decision.action;
  if (
    input.application.status !== 'uncertain'
    || input.application.errorSummary !== MERGE_REPLAN_SYSTEM_BINDING_CALLBACK_ERROR
    || action.type !== 'request_merge_replan'
    || action.taskId !== input.taskId
    || input.publication?.id !== action.publicationId
    || input.publication.taskId !== input.taskId
    || input.publication.status !== 'parked'
  ) {
    return false;
  }
  return input.dispatchItems.some(item => (
    item.attemptKind === 'merge_repair'
    && item.status === 'terminal'
    && item.attemptPayload?.protocol === 'metaclaw:merge-repair:v1'
    && item.attemptPayload.publicationId === action.publicationId
    && /EACCES: permission denied, open .*[\\/]\.metaclaw[\\/]merge-repair[\\/].*\.(?:base|ours|theirs)'?$/u
      .test(item.errorSummary ?? '')
  ));
}

export function mergeRepairReplanRecoveryEvent(input: {
  taskId: string;
  application: KernelDecisionApplicationRecord;
  sessionId: string;
  occurredAt: string;
}): Extract<KernelEvent, { type: 'recovery_resolution_requested' }> {
  return {
    schemaVersion: 5,
    configurationRevision: input.application.decision.configurationRevision,
    type: 'recovery_resolution_requested',
    id: `recovery_event_merge_replan_${input.application.id}`,
    correlationId: input.taskId,
    causationId: input.application.decisionId,
    occurredAt: input.occurredAt,
    sessionId: input.sessionId,
    taskId: input.taskId,
    recoveryItemId: input.application.id,
    resolution: 'retry',
  };
}

export function isSupersededMergeReplanApplication(input: {
  taskId: string;
  application: KernelDecisionApplicationRecord;
  publication: {
    id: string;
    taskId: string;
    subtaskId: string;
    status: string;
  } | null;
  subtask: {
    id: string;
    taskId: string;
    status: string;
  } | null;
}): boolean {
  const action = input.application.decision.action;
  return Boolean(
    input.application.status === 'uncertain'
    && input.application.errorSummary === MERGE_REPLAN_SYSTEM_BINDING_CALLBACK_ERROR
    && action.type === 'request_merge_replan'
    && action.taskId === input.taskId
    && input.publication?.id === action.publicationId
    && input.publication.taskId === input.taskId
    && input.publication.subtaskId === action.subtaskId
    && input.publication.status === 'integrated'
    && input.subtask?.id === action.subtaskId
    && input.subtask.taskId === input.taskId
    && input.subtask.status === 'done'
  );
}

export function mergeReplanAssumeAppliedRecoveryEvent(input: {
  taskId: string;
  application: KernelDecisionApplicationRecord;
  sessionId: string;
  occurredAt: string;
}): Extract<KernelEvent, { type: 'recovery_resolution_requested' }> {
  return {
    schemaVersion: 5,
    configurationRevision: input.application.decision.configurationRevision,
    type: 'recovery_resolution_requested',
    id: `recovery_event_merge_replan_superseded_${input.application.id}`,
    correlationId: input.taskId,
    causationId: input.application.decisionId,
    occurredAt: input.occurredAt,
    sessionId: input.sessionId,
    taskId: input.taskId,
    recoveryItemId: input.application.id,
    resolution: 'assume_applied',
  };
}
