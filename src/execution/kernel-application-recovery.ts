import type { KernelEvent } from '../kernel/control-kernel.js';
import type { KernelDecisionApplicationRecord } from '../kernel/kernel-workflow.js';
import type { KernelAttemptPayload, KernelAttemptKind, KernelDispatchItemStatus } from '../kernel/control-kernel.js';
import type { GenerationReplanRequestRecord } from '../storage/generation-replan-request-repo.js';
import type { WorkGraphRevisionRecord } from '../storage/work-graph-revision-repo.js';

export const LEGACY_SYSTEM_BINDING_CALLBACK_ERROR =
  'Conversation execution callback is unavailable: onDecisionApplying';
export const MERGE_REPLAN_SYSTEM_BINDING_CALLBACK_ERROR =
  'startup recovery requires the originating Conversation Planner for merge replan';

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
