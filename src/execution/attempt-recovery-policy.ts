/**
 * Task Runtime attempt-recovery policy (ADR-0055 D4/D5).
 *
 * Formerly `decideTaskResume`, `decideGenerationQuiescence`,
 * `decidePartitionConflict`, `decideSandboxRecovery` and `decideMergeConflict`.
 * The Runtime owns resume, generation quiescence, resource-partition waiting,
 * sandbox replacement and the merge-repair chain.
 */
import { authorizedExecutorBindingFingerprint } from '../core/authorized-executor-binding.js';
import {
  decision,
  type ControlDecision,
  type ControlEvent,
  type ControlSnapshot,
} from '../control/control-contracts.js';
import {
  isPendingOrActiveDispatch,
  resourceGrantForSubtask,
  singleDispatchBatch,
} from './attempt-dispatch-plan.js';
import { MAX_CORRECTION_INPUT_BYTES } from './failure-retry-policy.js';

export function decideTaskResume(
  event: Extract<ControlEvent, { type: 'task_resume_requested' }>,
  snapshot: Extract<ControlSnapshot, { type: 'dispatch' }>,
): ControlDecision {
  if (
    !event.taskId
    || !snapshot.task
    || snapshot.task.id !== event.taskId
    || !['needs_action', 'running'].includes(snapshot.task.status)
  ) {
    return decision(event, { type: 'no_op' }, 'resume target is not an active recoverable Task');
  }
  if ((event.expectedGenerationId !== undefined && event.expectedGenerationId !== snapshot.generationId)
    || (event.expectedGraphRevision !== undefined && event.expectedGraphRevision !== snapshot.graphRevision)) {
    return decision(event, { type: 'no_op' }, 'resume request targets a stale generation or graph revision');
  }
  if (snapshot.graphState !== 'ready') {
    return decision(
      event,
      { type: 'park_for_replan', taskId: event.taskId },
      `work graph is ${snapshot.graphState}; replanning is required`,
    );
  }
  if (snapshot.deliveryRecoveryPublicationIds?.length) {
    return decision(event, { type: 'resume_task', taskId: event.taskId, generationId: snapshot.generationId,
      graphRevision: snapshot.graphRevision, subtaskIds: [], blockerCategory: event.blockerCategory,
      deliveryPublicationIds: snapshot.deliveryRecoveryPublicationIds }, 'resume user delivery without repeating Executor work');
  }
  if (event.blockerCategory === 'dependency_publication') {
    const pending = (snapshot.dependencyReadiness ?? []).find(fact => !fact.terminal);
    if (pending) {
      return decision(
        event,
        { type: 'no_op' },
        `resume is waiting for dependency publication: ${pending.sourceSubtaskId} -> ${pending.targetSubtaskId}`,
      );
    }
  }
  const recovery = (snapshot.resumeRecoveryCandidates ?? []).find(candidate => {
    const subtask = snapshot.subtasks.find(item => item.id === candidate.subtaskId);
    const hasUncertainDispatch = snapshot.dispatchItems.some(item =>
      item.subtaskId === candidate.subtaskId && item.status === 'uncertain',
    );
    return (
      subtask?.status === 'awaiting_decision'
      || subtask?.status === 'blocked'
      || (subtask?.status === 'running' && hasUncertainDispatch)
    )
      && candidate.bindingFingerprint === authorizedExecutorBindingFingerprint(
        candidate.authorizedBinding,
      )
      && candidate.authorizedBinding.configurationRevision === event.configurationRevision
      && subtask.executorBindings.some(binding =>
        authorizedExecutorBindingFingerprint(binding) === candidate.bindingFingerprint
      )
      && !snapshot.dispatchItems.some(item =>
        item.subtaskId === candidate.subtaskId && isPendingOrActiveDispatch(item.status)
      );
  });
  const restoredUpstream = recovery?.reason === 'upstream_input_restored'
    && !['contract', 'material'].includes(event.blockerCategory)
    && snapshot.upstreamInputResume !== undefined
    && snapshot.generationQuiescent
    && snapshot.recoverySafety !== 'external_non_idempotent'
    && !snapshot.completionBlockedReasons.some(reason => !['generation_replan', 'kernel_application'].includes(reason))
    && (!snapshot.generationReplanRequest || (
      snapshot.generationReplanRequest.status === 'submitted'
      && snapshot.generationReplanRequest.id === snapshot.upstreamInputResume.rejectedReplanRequestId
    ));
  if (
    recovery
    && (recovery.reason === 'upstream_input_restored'
      ? restoredUpstream
      : !['manual', 'material', 'contract'].includes(event.blockerCategory))
  ) {
    const recoveryAttemptKind = recovery.attemptKind
      ?? (['completion_metadata_invalid', 'completion_marker_missing'].includes(recovery.reason)
        ? 'contract_correction'
        : 'continuation');
    const metadataRecovery = ['completion_metadata_invalid', 'completion_marker_missing'].includes(recovery.reason);
    if (metadataRecovery || recoveryAttemptKind === 'contract_correction') {
      const payload = recovery.attemptPayload;
      if (recoveryAttemptKind !== 'contract_correction'
        || !snapshot.correctionSupportedAgentClasses.includes(recovery.authorizedBinding.agentClassRef)
        || recovery.correctionFacts?.receiptCount !== 1
        || !Number.isFinite(recovery.correctionFacts.responseBytes)
        || recovery.correctionFacts.responseBytes < 0
        || recovery.correctionFacts.responseBytes > MAX_CORRECTION_INPUT_BYTES
        || payload?.protocol !== 'completion-correction-v2'
        || payload.violations.length === 0
        || payload.violations.some(item => item.code !== 'completion_malformed' || item.path === 'reportPath')
        || snapshot.attempts.some(attempt => attempt.sourceAttemptId === recovery.sourceAttemptId
          && attempt.attemptKind === 'contract_correction')) {
        return decision(event, { type: 'no_op' }, 'metadata correction is unavailable or exhausted');
      }
    } else if (snapshot.recoverySafety === 'external_non_idempotent') {
      return decision(event, { type: 'no_op' }, 'explicit resume cannot prove external effect safety');
    }
    return decision(event, {
      type: 'resume_task',
      taskId: event.taskId,
      generationId: snapshot.generationId,
      graphRevision: snapshot.graphRevision,
      subtaskIds: [],
      blockerCategory: event.blockerCategory,
      ...(restoredUpstream && snapshot.upstreamInputResume?.rejectedReplanRequestId
        ? { retireReplanRequestId: snapshot.upstreamInputResume.rejectedReplanRequestId } : {}),
      recovery: {
        subtaskId: recovery.subtaskId,
        sourceAttemptId: recovery.sourceAttemptId,
        authorizedBinding: recovery.authorizedBinding,
        bindingFingerprint: recovery.bindingFingerprint,
        attemptKind: recoveryAttemptKind,
        recoveryMode: recovery.recoveryMode,
        defaultResourceGrant: resourceGrantForSubtask(snapshot, recovery.subtaskId),
        ...(recovery.attemptPayload ? { attemptPayload: recovery.attemptPayload } : {}),
      },
    }, restoredUpstream ? 'Kernel authorized recovery after revalidating published upstream inputs'
      : recoveryAttemptKind === 'contract_correction'
      ? 'Kernel authorized metadata-only correction of the existing safe result'
      : 'Kernel authorized exact uncertified-result workspace recovery');
  }
  if (snapshot.task.status === 'running') {
    return decision(event, { type: 'no_op' }, 'running Task has no exact recoverable Subtask');
  }
  if (event.blockerCategory === 'retry' && snapshot.recoverySafety === 'external_non_idempotent') {
    return decision(
      event,
      { type: 'block_work', taskId: event.taskId, subtaskId: event.subtaskId ?? null },
      'explicit resume cannot prove external effect safety',
    );
  }
  if (['manual', 'material', 'contract', 'unknown'].includes(event.blockerCategory)) {
    return decision(
      event,
      { type: 'block_work', taskId: event.taskId, subtaskId: event.subtaskId ?? null },
      `resume requires resolving the ${event.blockerCategory} blocker first`,
    );
  }
  const recoverableSubtasks = snapshot.subtasks
    .filter(subtask => subtask.status === 'ready' || subtask.status === 'blocked')
    .map(subtask => subtask.id);
  if (recoverableSubtasks.length === 0) {
    return decision(event, { type: 'no_op' }, 'resume has no recoverable Subtask');
  }
  return decision(event, {
    type: 'resume_task',
    taskId: event.taskId,
    generationId: snapshot.generationId,
    graphRevision: snapshot.graphRevision,
    subtaskIds: recoverableSubtasks,
    blockerCategory: event.blockerCategory,
  }, 'Kernel authorized explicit Task resume');
}

export function decideGenerationQuiescence(
  event: Extract<ControlEvent, { type: 'generation_quiescence_observed' }>,
  snapshot: Extract<ControlSnapshot, { type: 'dispatch' }>,
): ControlDecision {
  const request = snapshot.generationReplanRequest;
  if (
    !event.taskId
    || !request
    || request.id !== event.requestId
    || request.status !== 'pending_quiescence'
    || event.generationId !== snapshot.generationId
    || event.sourceRevision !== snapshot.graphRevision
    || !snapshot.generationQuiescent
  ) {
    return decision(event, { type: 'no_op' }, 'generation quiescence observation is stale or incomplete');
  }
  return decision(event, {
    type: 'schedule_replan',
    taskId: event.taskId,
    generationId: event.generationId,
    sourceRevision: event.sourceRevision,
    replanJobId: request.id,
  }, 'generation quiescence token accepted; durable Replan Job scheduled for the Planner Worker');
}

export function decidePartitionConflict(
  event: Extract<ControlEvent, { type: 'partition_conflict_observed' }>,
  snapshot: Extract<ControlSnapshot, { type: 'partition' }>,
): ControlDecision {
  if (!event.taskId || !event.subtaskId || !snapshot.conflictConfirmed || event.conflictingLeaseIds.length === 0) {
    return decision(event, { type: 'block_work', taskId: event.taskId ?? '', subtaskId: event.subtaskId ?? null }, 'partition conflict facts are incomplete');
  }
  return decision(event, {
    type: 'wait_for_partition',
    taskId: event.taskId,
    subtaskId: event.subtaskId,
    conflictingLeaseIds: [...new Set(event.conflictingLeaseIds)].sort(),
  }, 'conflicting resource lease requires Kernel wait');
}

export function decideSandboxRecovery(
  event: Extract<ControlEvent, { type: 'sandbox_lost' }>,
  snapshot: Extract<ControlSnapshot, { type: 'sandbox_recovery' }>,
): ControlDecision {
  if (!event.taskId || !event.subtaskId || !snapshot.workspaceExists || snapshot.workspaceId !== event.workspaceId) {
    return decision(event, { type: 'block_work', taskId: event.taskId ?? '', subtaskId: event.subtaskId ?? null }, 'sandbox loss has no recoverable workspace');
  }
  return decision(event, {
    type: 'recover_workspace_attempt',
    taskId: event.taskId,
    subtaskId: event.subtaskId,
    workspaceId: event.workspaceId,
    checkpointId: snapshot.checkpointId,
    requestId: null,
    authorization: null,
    lostAttemptId: event.attemptId,
    authorizedBinding: event.authorizedBinding,
    bindingFingerprint: event.bindingFingerprint,
    attemptKind: event.attemptKind,
    sourceAttemptId: event.sourceAttemptId,
    recoveryMode: event.recoveryMode,
    defaultResourceGrant: snapshot.defaultResourceGrant,
  }, 'lost sandbox will be replaced by a fresh attempt using the persistent workspace');
}

export function decideMergeConflict(
  event: Extract<ControlEvent, { type: 'merge_conflict_observed' }>,
  snapshot: Extract<ControlSnapshot, { type: 'dispatch' }>,
): ControlDecision {
  if (!event.taskId || !event.subtaskId || event.conflictingPaths.length === 0) {
    return decision(event, {
      type: 'block_work', taskId: event.taskId ?? '', subtaskId: event.subtaskId ?? null,
    }, 'merge conflict facts are incomplete');
  }
  if (event.repairAttemptsUsed < 3) {
    if (snapshot.availableSlots <= 0) {
      return decision(event, {
        type: 'wait_for_capacity', taskId: event.taskId, subtaskId: event.subtaskId,
      }, 'merge repair is waiting for an attempt slot');
    }
    return decision(event, singleDispatchBatch(
      event,
      event.taskId,
      event.subtaskId,
      event.authorizedBinding,
      'merge_repair',
      event.sourceAttemptId,
      snapshot.nativeContinuationAgentClasses.includes(event.authorizedBinding.agentClassRef)
        ? 'native_session'
        : 'recovery_packet',
      resourceGrantForSubtask(snapshot, event.subtaskId),
      {
        protocol: 'metaclaw:merge-repair:v1',
        publicationId: event.publicationId,
        conflictChainId: event.conflictChainId,
        conflictingPaths: [...event.conflictingPaths].sort(),
      },
    ), `merge repair ${event.repairAttemptsUsed + 1} of 3 authorized`);
  }
  if (event.conflictReplansUsed < 1) {
    return decision(event, {
      type: 'request_merge_replan',
      taskId: event.taskId,
      subtaskId: event.subtaskId,
      publicationId: event.publicationId,
      conflictChainId: event.conflictChainId,
    }, 'three merge repairs failed; one conflict replan is authorized');
  }
  return decision(event, {
    type: 'park_for_replan', taskId: event.taskId,
  }, 'merge repair and conflict replan budgets are exhausted');
}
