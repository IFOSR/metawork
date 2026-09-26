import type { KernelEvent } from '../kernel/control-kernel.js';
import type { KernelDecisionApplicationRecord } from '../kernel/kernel-workflow.js';
import type { KernelAttemptPayload, KernelAttemptKind, KernelDispatchItemStatus } from '../kernel/control-kernel.js';
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

export interface ApplicationPostconditionFacts {
  readonly application: KernelDecisionApplicationRecord;
  readonly task: { id: string; status: string } | null;
  readonly subtasks: readonly { id: string; status: string }[];
  readonly dispatchItems: readonly {
    attemptId: string;
    decisionId: string;
    subtaskId: string;
    status: KernelDispatchItemStatus;
  }[];
  /** The graph revision named by the Decision, when the action names one. */
  readonly workGraphRevision: Pick<
    WorkGraphRevisionRecord,
    'revision' | 'generationId' | 'authorizedDecisionId'
  > | null;
  readonly replanRequest: GenerationReplanRequestRecord | null;
}

/**
 * Narrow read ports one postcondition inspection needs. Both the startup sweep
 * and the explicit `/task recovery` diagnostic read through this seam so the
 * verdict the user sees is the same verdict recovery acts on.
 */
export interface ApplicationPostconditionFactSource {
  findTask(taskId: string): { id: string; status: string } | null;
  listSubtasks(taskId: string): readonly { id: string; status: string }[];
  listDispatchItems(taskId: string): readonly {
    attemptId: string;
    decisionId: string;
    subtaskId: string;
    status: KernelDispatchItemStatus;
  }[];
  findWorkGraphRevision(
    taskId: string,
    revision: number,
  ): Pick<WorkGraphRevisionRecord, 'revision' | 'generationId' | 'authorizedDecisionId'> | null;
  findReplanRequest(
    taskId: string,
    generationId: string,
    sourceRevision: number,
  ): GenerationReplanRequestRecord | null;
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
 * Actions whose only durable effect is the observation event that
 * `markApplied` inserts atomically with the `applied` transition. Re-applying
 * the same Decision id is therefore idempotent.
 */
/**
 * Actions whose durable effect is an observation event created by
 * `markApplied` together with the `applied` transition. Re-applying the same
 * Decision is safe **only because** the Runtime's apply for these actions is
 * itself replay-idempotent (deterministic observation ids are deduplicated by
 * the inbox, and state writes are guarded). `resume_task` is the one action
 * here that does mutate Task/Subtask state, so its apply must never short
 * circuit a replay before emitting the observation.
 */
const OBSERVATION_ONLY_ACTIONS = new Set<string>([
  'no_op',
  'wait_for_retry',
  'wait_for_capacity',
  'probe_capacity',
  'wait_for_partition',
  'park_for_replan',
  'queue_generation_replan',
  'defer_task_plan_for_availability',
]);

/**
 * `resume_task` mutates Task/Subtask state before emitting its dispatch
 * observation, so it is retry-safe only in the sense that its apply must be
 * replay-idempotent. Kept separate so the contract is explicit.
 */
const RESUME_ACTIONS = new Set<string>(['resume_task']);

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
      return inspectDispatch(facts, action.items.map(item => item.attemptId));
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
    default:
      if (OBSERVATION_ONLY_ACTIONS.has(action.type)) {
        return {
          family: 'observation_only',
          verdict: 'retry_safe',
          reason: `${action.type} only emits its Decision observation and is idempotent by Decision id`,
        };
      }
      if (RESUME_ACTIONS.has(action.type) && action.type === 'resume_task') {
        return inspectResume(facts);
      }
      return {
        family: 'not_managed',
        verdict: 'unresolved',
        reason: `no postcondition is declared for ${action.type}`,
      };
  }
}

/**
 * `resume_task` is satisfied once the resumed Subtask is no longer blocked and
 * the Task is back in an executing-facing state; the dispatch observation is
 * emitted deterministically by the same apply, so a replay that completes the
 * remaining steps is the correct recovery action.
 */
function inspectResume(
  facts: ApplicationPostconditionFacts,
): ApplicationPostconditionInspection {
  const action = facts.application.decision.action;
  if (action.type !== 'resume_task') {
    return { family: 'not_managed', verdict: 'unresolved', reason: 'unexpected action' };
  }
  const taskStatus = facts.task?.status ?? null;
  const blockedSubtasks = action.subtaskIds.filter(subtaskId => (
    facts.subtasks.find(item => item.id === subtaskId)?.status === 'blocked'
  ));
  if (
    taskStatus === 'running'
    && blockedSubtasks.length === 0
    && facts.dispatchItems.some(item => item.decisionId === facts.application.decisionId)
  ) {
    return {
      family: 'observation_only',
      verdict: 'applied',
      reason: 'the resumed Task re-entered execution and its dispatch item is durable',
    };
  }
  return {
    family: 'observation_only',
    verdict: 'retry_safe',
    reason: blockedSubtasks.length > 0
      ? `resume is incomplete: Subtask ${blockedSubtasks.join(', ')} is still blocked`
      : 'resume has not produced its dispatch fact yet; replay is idempotent by Decision id',
  };
}

function inspectDispatch(
  facts: ApplicationPostconditionFacts,
  expectedAttemptIds: readonly string[],
): ApplicationPostconditionInspection {
  const decisionId = facts.application.decisionId;
  const present = expectedAttemptIds.filter(attemptId => facts.dispatchItems.some(
    item => item.attemptId === attemptId && item.decisionId === decisionId,
  ));
  if (present.length === expectedAttemptIds.length && expectedAttemptIds.length > 0) {
    return {
      family: 'dispatch',
      verdict: 'applied',
      reason: 'every authorized dispatch item exists with the same Decision id',
    };
  }
  if (present.length === 0) {
    return {
      family: 'dispatch',
      verdict: 'retry_safe',
      reason: 'no authorized dispatch item landed; the Decision may be re-applied',
    };
  }
  return {
    family: 'dispatch',
    verdict: 'unresolved',
    reason: `partial dispatch batch: ${present.length}/${expectedAttemptIds.length} items landed`,
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
    return {
      family: 'plan_activation',
      verdict: 'applied',
      reason: `graph revision ${action.graphRevision} is durable`,
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
    const subtaskResolved = action.subtaskId === null
      || action.preserveSubtaskState === true
      || namedSubtask === null
      || ['blocked', 'done', 'cancelled'].includes(namedSubtask.status);
    if (taskStatus === 'blocked' && subtaskResolved) {
      return { family: 'task_transition', verdict: 'applied', reason: 'the Task block is durable' };
    }
    return {
      family: 'task_transition',
      verdict: 'retry_safe',
      reason: taskStatus === 'blocked'
        ? `the Task is blocked but Subtask ${action.subtaskId} is still ${namedSubtask?.status ?? 'missing'}`
        : 'the Task block is not durable yet',
    };
  }
  return {
    family: 'task_transition',
    verdict: 'unresolved',
    reason: `no Task transition postcondition is declared for ${action.type}`,
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
