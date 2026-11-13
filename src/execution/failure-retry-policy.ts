/**
 * Task Runtime failure and retry policy (ADR-0055 D4).
 *
 * Formerly the retired outcome deciders and
 * the execution-landing branches (`handoff_contract_failed`,
 * `execution_result_observed`, retry/capacity wake). Failure classification,
 * retry delay, fallback binding selection and the bounded automatic replan are
 * Runtime-owned facts now; `wait_for_retry` stays a durable local wake.
 */
import { authorizedExecutorBindingFingerprint } from '../core/authorized-executor-binding.js';
import {
  decision,
  type ControlDecision,
  type ControlEvent,
  type ControlSnapshot,
  type ControlSubtaskFact,
} from '../control/control-contracts.js';
import { unavailableAgentClasses } from '../control/plan-routing-eligibility.js';
import { isTerminalTaskStatus } from '../task/task-state.js';
import {
  addMilliseconds,
  generationReplanRequestId,
  nextUsableBinding,
  resourceGrantForSubtask,
  singleDispatchBatch,
} from './attempt-dispatch-plan.js';
import { decideDispatch } from './dispatch-policy.js';

/** Largest response the Runtime will re-ask an Executor to correct in place. */
export const MAX_CORRECTION_INPUT_BYTES = 128 * 1024;

export function decideOutcome(event: Extract<ControlEvent, { type: 'execution_outcome' }>, snapshot: Extract<ControlSnapshot, { type: 'dispatch' }>): ControlDecision {
  if (!event.taskId) return decision(event, { type: 'block_work', taskId: '', subtaskId: event.subtaskId ?? null }, 'outcome has no Task');
  if (event.terminalKind === 'failed') {
    return decideFailure(event, snapshot);
  }
  return decideDispatch(event, snapshot);
}

export function decideFailure(
  event: Extract<ControlEvent, { type: 'execution_outcome' }>,
  snapshot: Extract<ControlSnapshot, { type: 'dispatch' }>,
): ControlDecision {
  const taskId = event.taskId!;
  const subtask = snapshot.subtasks.find(item => item.id === event.subtaskId);
  const failure = event.failure;
  if (!subtask || !event.attemptId || !failure) {
    return decision(event, { type: 'block_work', taskId, subtaskId: event.subtaskId ?? null }, 'failure facts are incomplete');
  }
  if (event.attemptKind === 'contract_correction') {
    return decision(
      event,
      {
        type: 'block_work',
        taskId,
        subtaskId: event.subtaskId ?? null,
        preserveSubtaskState: true,
      },
      'metadata correction failed; safe result remains uncertified and requires explicit resolution',
    );
  }
  if (event.attemptKind === 'merge_repair') {
    return decision(
      event,
      { type: 'no_op' },
      'merge repair failure is governed by the publication conflict chain',
    );
  }
  if (failure.code === 'startup_orphaned_work') {
    return decision(event, { type: 'block_work', taskId, subtaskId: subtask.id }, 'startup orphaned work requires explicit recovery');
  }
  if (
    failure.code === 'workspace_source_missing'
    || failure.code === 'workspace_binding_missing'
    || failure.code === 'dispatch_context_invalid'
  ) {
    return decision(
      event,
      { type: 'block_work', taskId, subtaskId: subtask.id, preserveSubtaskState: true },
      `${failure.code} requires Workspace/context repair before explicit resume`,
    );
  }
  if (snapshot.task?.status === 'cancelled' || subtask.status === 'cancelled') {
    return decision(event, { type: 'no_op' }, 'cancellation fence makes the late attempt outcome stale');
  }
  if (!snapshot.automaticRecoveryAllowed || snapshot.recoverySafety === 'external_non_idempotent') {
    return decision(event, { type: 'block_work', taskId, subtaskId: subtask.id }, 'automatic recovery cannot prove external effect safety');
  }
  // Background extraction can replace a recalled asset between planning and
  // preparation. No Executor ran: refresh semantics once, not the route.
  if (failure.stage === 'context_preparation' && failure.attemptStarted === false
    && failure.externalSideEffect === false && [
      'memory_asset_not_found', 'memory_revision_changed', 'memory_not_in_recall_snapshot',
      'memory_not_authorized', 'task_resource_not_authorized',
    ].includes(failure.code)) {
    if (snapshot.automaticReplansUsed < 1) {
      return decision(event, { type: 'queue_generation_replan', taskId,
        generationId: snapshot.generationId, sourceRevision: snapshot.graphRevision,
        requestId: generationReplanRequestId(taskId, snapshot.generationId, snapshot.graphRevision),
      }, `${failure.code}: refresh the context snapshot before replanning unstarted work`);
    }
    return decision(event, { type: 'block_work', taskId, subtaskId: subtask.id, blockerKind: 'system' },
      `任务资料在执行前变化或不可用，自动重新规划已用尽：${failure.code}`);
  }
  if (failure.kind === 'configuration' || failure.kind === 'adapter' || failure.kind === 'permission' || failure.kind === 'unknown' || failure.kind === 'stale' || failure.kind === 'cancelled') {
    return decision(event, { type: 'block_work', taskId, subtaskId: subtask.id }, `${failure.kind} requires explicit recovery`);
  }
  const retryable = ['network', 'timeout', 'infrastructure', 'heartbeat_lost'].includes(failure.kind);
  const bindingAttempts = new Set([
    event.attemptId,
    ...snapshot.attempts.filter(attempt =>
      attempt.subtaskId === subtask.id && attempt.bindingFingerprint === event.bindingFingerprint
      && attempt.attemptKind !== 'contract_correction'
    ).map(attempt => attempt.attemptId),
    ...snapshot.dispatchItems.filter(item =>
      item.subtaskId === subtask.id && item.bindingFingerprint === event.bindingFingerprint
    ).map(item => item.attemptId),
  ]).size;
  if (retryable && bindingAttempts <= 2) {
    const delayMs = failure.kind === 'network' ? 5_000 : 30_000;
    return decision(event, {
      type: 'wait_for_retry',
      taskId,
      subtaskId: subtask.id,
      resumeAt: addMilliseconds(event.occurredAt, delayMs),
      authorizedBinding: event.authorizedBinding,
      bindingFingerprint: event.bindingFingerprint,
      sourceAttemptId: event.attemptId,
    }, `same route retry delayed after ${failure.kind}`);
  }
  if (!retryable && ![
    'authentication', 'configuration', 'adapter', 'capability_mismatch', 'task_failed', 'quality_failed',
    'provider_quota',
  ].includes(failure.kind)) {
    return decision(event, { type: 'block_work', taskId, subtaskId: subtask.id }, `${failure.kind} has no safe recovery policy`);
  }
  return fallbackOrReplan(event, snapshot, subtask);
}

export function fallbackOrReplan(
  event: Extract<ControlEvent, { type: 'execution_outcome' }>,
  snapshot: Extract<ControlSnapshot, { type: 'dispatch' }>,
  subtask: ControlSubtaskFact,
): ControlDecision {
  const attempted = new Set([event.bindingFingerprint,
    ...snapshot.attempts
      .filter(attempt => attempt.subtaskId === subtask.id && attempt.attemptKind !== 'contract_correction')
      .map(attempt => attempt.bindingFingerprint),
    ...snapshot.dispatchItems.filter(item => item.subtaskId === subtask.id)
      .map(item => item.bindingFingerprint),
  ]);
  const binding = nextUsableBinding(subtask, snapshot, event.occurredAt, attempted);
  if (binding) {
    return decision(event, singleDispatchBatch(
      event, event.taskId!, subtask.id, binding, 'fallback',
      event.attemptId!, 'recovery_packet', resourceGrantForSubtask(snapshot, subtask.id),
      null,
    ), 're-ask Router using the remaining eligible routes');
  }
  // Routing exhaustion is a structured no-candidate block, never an implicit
  // semantic replan or a default model. Router persists that outcome.
  return decision(event, singleDispatchBatch(
    event, event.taskId!, subtask.id, event.authorizedBinding, 'fallback',
    event.attemptId!, 'recovery_packet', resourceGrantForSubtask(snapshot, subtask.id), null,
  ), 're-ask Router after the previous route failed');
}

export function decideContractFailure(event: Extract<ControlEvent, { type: 'handoff_contract_failed' }>, snapshot: Extract<ControlSnapshot, { type: 'dispatch' }>): ControlDecision {
  if (!event.taskId || !event.subtaskId) return decision(event, { type: 'block_work', taskId: event.taskId ?? '', subtaskId: event.subtaskId ?? null }, 'contract failure identity is incomplete');
  if (
    event.violations.some(violation => violation.code !== 'completion_malformed'
      || violation.path === 'reportPath')
    || event.receiptCount !== 1
    || event.responseBytes > MAX_CORRECTION_INPUT_BYTES
    || !snapshot.correctionSupportedAgentClasses.includes(event.authorizedBinding.agentClassRef)
  ) {
    return decision(event, { type: 'block_work', taskId: event.taskId, subtaskId: event.subtaskId }, 'response-only correction is unavailable or already exhausted');
  }
  return decision(event, singleDispatchBatch(
    event, event.taskId, event.subtaskId, event.authorizedBinding, 'contract_correction',
    event.attemptId ?? null, 'fresh', resourceGrantForSubtask(snapshot, event.subtaskId),
    {
      protocol: 'completion-correction-v2',
      completionContract: event.contract,
      violations: event.violations,
    },
  ), 'one response-only contract correction authorized');
}

export function decideExecutionResult(
  event: Extract<ControlEvent, { type: 'execution_result_observed' }>,
  snapshot: Extract<ControlSnapshot, { type: 'dispatch' }>,
): ControlDecision {
  if (!event.taskId || !event.subtaskId) {
    return decision(
      event,
      { type: 'block_work', taskId: event.taskId ?? '', subtaskId: event.subtaskId ?? null },
      'execution result identity is incomplete',
    );
  }
  if (event.safety === 'safety_blocked' || event.deliverability === 'quarantined') {
    return decision(
      event,
      { type: 'block_work', taskId: event.taskId, subtaskId: event.subtaskId },
      'execution result is quarantined by a safety boundary',
    );
  }
  if (event.certification === 'certified') {
    return decideDispatch(event, snapshot);
  }
  const deterministicDeliveryFailure = event.violations.some(violation => [
    'completion_file_output_missing',
    'completion_artifact_invalid',
    'completion_workspace_delta_uncertain',
    'completion_file_output_limit',
  ].includes(violation.code));
  if (deterministicDeliveryFailure) {
    return decision(
      event,
      {
        type: 'block_work',
        taskId: event.taskId,
        subtaskId: event.subtaskId,
        preserveSubtaskState: true,
      },
      'result delivery failed deterministic output checks; no complete deliverable is available',
    );
  }
  if (
    event.violations.some(violation => violation.code !== 'completion_malformed'
      || violation.path === 'reportPath')
    || event.receiptCount !== 1
    || event.responseBytes > MAX_CORRECTION_INPUT_BYTES
    || !snapshot.correctionSupportedAgentClasses.includes(event.authorizedBinding.agentClassRef)
  ) {
    // Safe text is not proof of completeness. A missing/malformed completion
    // report also represents truncated responses; exhausted correction must
    // leave acceptance or retry to the user.
    return decision(
      event,
      {
        type: 'await_user_decision',
        taskId: event.taskId,
        subtaskId: event.subtaskId,
        reason: 'uncertified_result',
      },
      'safe result remains uncertified; user may accept and deliver it or retry the Attempt',
    );
  }
  return decision(event, singleDispatchBatch(
    event,
    event.taskId,
    event.subtaskId,
    event.authorizedBinding,
    'contract_correction',
    event.attemptId ?? null,
    'fresh',
    resourceGrantForSubtask(snapshot, event.subtaskId),
    {
      protocol: 'completion-correction-v2',
      completionContract: event.contract,
      violations: event.violations,
    },
  ), 'one response-only metadata correction authorized');
}

export function decideTimer(event: Extract<ControlEvent, { type: 'timer_tick' }>, snapshot: Extract<ControlSnapshot, { type: 'timer' }>): ControlDecision {
  if (event.wakeKind === 'retry') {
    const retry = event.retry;
    const wake = snapshot.retryWake;
    if (!retry) {
      return decision(event, { type: 'no_op' }, 'retry timer has no wake identity');
    }
    if (!wake) {
      return decision(event, {
        type: 'recover_retry_wake',
        taskId: event.taskId ?? '',
        wakeId: retry.wakeId,
        reason: 'retry timer references a missing durable Retry Wake',
      }, 'retry wake fact is missing');
    }
    const exactIdentity = wake.wakeId === retry.wakeId
      && wake.taskId === event.taskId
      && wake.subtaskId === event.subtaskId
      && wake.generationId === retry.generationId
      && wake.sourceDecisionId === event.sourceDecisionId
      && wake.sourceAttemptId === retry.sourceAttemptId
      && wake.configurationRevision === event.configurationRevision
      && wake.configurationRevision === retry.configurationRevision
      && wake.bindingFingerprint === retry.bindingFingerprint
      && wake.timerEventId === event.id;
    if (!exactIdentity) {
      return decision(event, {
        type: 'recover_retry_wake',
        taskId: event.taskId ?? wake.taskId,
        wakeId: wake.wakeId,
        reason: 'retry timer identity does not match the durable Retry Wake',
      }, 'retry wake identity is stale or contradictory');
    }
    if (wake.status === 'consumed' || wake.status === 'superseded') {
      return decision(event, { type: 'no_op' }, `retry wake is already ${wake.status}`);
    }
    if (wake.status === 'recovery_required') {
      return decision(event, {
        type: 'recover_retry_wake',
        taskId: wake.taskId,
        wakeId: wake.wakeId,
        reason: 'retry wake already requires recovery',
      }, 'retry wake requires explicit recovery');
    }
    if (
      Date.parse(event.occurredAt) < Date.parse(event.scheduledFor)
    ) {
      return decision(event, { type: 'no_op' }, 'retry wake arrived before its scheduled time');
    }
    if (snapshot.task && isTerminalTaskStatus(snapshot.task.status)) {
      return decision(event, {
        type: 'supersede_retry_wake',
        taskId: wake.taskId,
        wakeId: wake.wakeId,
      }, 'retry wake is obsolete because the Task is terminal');
    }
    if (
      wake.status !== 'fired'
      || !event.taskId
      || !event.subtaskId
      || !snapshot.task
      || snapshot.task.id !== event.taskId
      || !['running', 'needs_action'].includes(snapshot.task.status)
      || !snapshot.wakeAuthorized
    ) {
      return decision(event, {
        type: 'recover_retry_wake',
        taskId: event.taskId ?? wake.taskId,
        wakeId: wake.wakeId,
        reason: 'fired Retry Wake no longer has its exact Task blocker',
      }, 'retry wake lost its authorized Task blocker');
    }
    return decision(event, singleDispatchBatch(
      event,
      event.taskId,
      event.subtaskId,
      retry.authorizedBinding,
      'continuation',
      retry.sourceAttemptId,
      snapshot.nativeContinuationAgentClasses.includes(retry.authorizedBinding.agentClassRef)
        ? 'native_session'
        : 'recovery_packet',
      snapshot.defaultResourceGrant,
      null,
    ), 'durable Retry Wake continuation authorized');
  }
  if (
    !event.taskId
    || !snapshot.task
    || snapshot.task.id !== event.taskId
    || !['running', 'needs_action'].includes(snapshot.task.status)
    || !snapshot.wakeAuthorized
  ) {
    return decision(event, { type: 'no_op' }, 'timer wake is stale or no longer authorized by Task state');
  }
  if (event.wakeKind !== 'capacity') return decision(event, { type: 'no_op' }, 'availability wake has no eligible work');
  if (!event.taskId || !event.subtaskId || !snapshot.capacityBlockedAt) return decision(event, { type: 'no_op' }, 'no capacity block is eligible');
  const elapsed = Date.parse(event.occurredAt) - Date.parse(snapshot.capacityBlockedAt);
  if (!Number.isFinite(elapsed) || elapsed < snapshot.recheckAfterMs) return decision(event, { type: 'no_op' }, 'capacity recheck interval has not elapsed');
  const unavailable = unavailableAgentClasses(snapshot.executorStatuses, event.occurredAt);
  const candidate = snapshot.capacityBindings.find(binding =>
    !unavailable.has(binding.agentClassRef)
  );
  return candidate
    ? decision(event, {
        type: 'probe_capacity',
        taskId: event.taskId,
        subtaskId: event.subtaskId,
        authorizedBinding: candidate,
        bindingFingerprint: authorizedExecutorBindingFingerprint(candidate),
      }, 'capacity timer recheck authorized')
    : decision(event, { type: 'no_op' }, 'no healthy AgentClass is eligible for capacity probe');
}
