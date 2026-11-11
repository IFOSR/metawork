/**
 * Task Runtime attempt-dispatch plan (ADR-0055 D3).
 *
 * The Runtime owns the dispatch round: which ready Subtask may be claimed, which
 * authorized Executor binding it may use, and the deterministic Attempt identity
 * of the claim. These helpers build the owner claim plan; they never write
 * durable state and never launch an Attempt.
 */
import { createHash } from 'node:crypto';
import {
  authorizedExecutorBindingFingerprint,
  type AuthorizedExecutorBinding,
} from '../core/authorized-executor-binding.js';
import type {
  ControlAttemptKind,
  ControlAttemptPayload,
  ControlDecisionAction,
  ControlDispatchItemStatus,
  ControlEvent,
  ControlRecoveryMode,
  ControlSnapshot,
  ControlSubtaskFact,
} from '../control/control-contracts.js';
import { unavailableAgentClasses } from '../control/plan-routing-eligibility.js';
import type { ResourceClaim } from '../resource/index.js';

export function selectDispatchableSubtasks(
  snapshot: Extract<ControlSnapshot, { type: 'dispatch' }>,
): ControlSubtaskFact[] {
  const activeSubtaskIds = new Set(snapshot.dispatchItems
    .filter(item => isPendingOrActiveDispatch(item.status))
    .map(item => item.subtaskId));
  const conflictingSubtaskIds = new Set(snapshot.resourceConflictSubtaskIds);
  const slotCount = Math.min(4, snapshot.maxConcurrentAttempts);
  return snapshot.frontier
    .map(id => snapshot.subtasks.find(item => item.id === id && item.status === 'ready'))
    .filter((subtask): subtask is ControlSubtaskFact => Boolean(
      subtask
      && !activeSubtaskIds.has(subtask.id)
      && !conflictingSubtaskIds.has(subtask.id),
    ))
    .slice(0, slotCount);
}

export function nextUsableBinding(
  subtask: ControlSubtaskFact,
  snapshot: Extract<ControlSnapshot, { type: 'dispatch' }>,
  occurredAt: string,
  attemptedBindingFingerprints: ReadonlySet<string> = new Set(),
): AuthorizedExecutorBinding | null {
  const unavailable = unavailableAgentClasses(snapshot.executorStatuses, occurredAt);
  return subtask.executorBindings.find(binding =>
    !attemptedBindingFingerprints.has(authorizedExecutorBindingFingerprint(binding))
    && !unavailable.has(binding.agentClassRef)
  ) ?? null;
}

export function resourceGrantForSubtask(
  snapshot: Extract<ControlSnapshot, { type: 'dispatch' }>,
  subtaskId: string,
): ResourceClaim[] {
  return snapshot.resourceGrantsBySubtask[subtaskId] ?? [];
}

export function dispatchBatchItems(
  event: ControlEvent,
  snapshot: Extract<ControlSnapshot, { type: 'dispatch' }>,
  subtasks: readonly ControlSubtaskFact[],
): Extract<ControlDecisionAction, { type: 'dispatch_batch' }>['items'] {
  const firstOrder = snapshot.dispatchItems.reduce((maximum, item) => Math.max(maximum, item.order), -1) + 1;
  return subtasks.flatMap((subtask, index) => {
    const binding = nextUsableBinding(subtask, snapshot, event.occurredAt);
    if (!binding) return [];
    const bindingFingerprint = authorizedExecutorBindingFingerprint(binding);
    return [{
      subtaskId: subtask.id,
      authorizedBinding: binding,
      bindingFingerprint,
      attemptId: deterministicAttemptId(event.id, subtask.id, bindingFingerprint, 'primary'),
      attemptKind: 'primary' as const,
      sourceAttemptId: null,
      recoveryMode: 'fresh' as const,
      defaultResourceGrant: resourceGrantForSubtask(snapshot, subtask.id),
      order: firstOrder + index,
      attemptPayload: null,
    }];
  });
}

export function singleDispatchBatch(
  event: ControlEvent,
  taskId: string,
  subtaskId: string,
  authorizedBinding: AuthorizedExecutorBinding,
  attemptKind: ControlAttemptKind,
  sourceAttemptId: string | null,
  recoveryMode: ControlRecoveryMode,
  defaultResourceGrant: ResourceClaim[],
  attemptPayload: ControlAttemptPayload,
): Extract<ControlDecisionAction, { type: 'dispatch_batch' }> {
  const bindingFingerprint = authorizedExecutorBindingFingerprint(authorizedBinding);
  return {
    type: 'dispatch_batch',
    taskId,
    items: [{
      subtaskId,
      authorizedBinding,
      bindingFingerprint,
      attemptId: deterministicAttemptId(event.id, subtaskId, bindingFingerprint, attemptKind),
      attemptKind,
      sourceAttemptId,
      recoveryMode,
      defaultResourceGrant,
      order: 0,
      attemptPayload,
    }],
  };
}

export function isPendingOrActiveDispatch(status: ControlDispatchItemStatus): boolean {
  return status === 'pending_launch'
    || status === 'launching'
    || status === 'running'
    || status === 'cancelling';
}

export function deterministicAttemptId(
  eventId: string,
  subtaskId: string,
  bindingFingerprint: string,
  kind: string,
): string {
  return `attempt_${[
    boundedIdSegment(eventId, 'event'),
    boundedIdSegment(subtaskId, 'subtask'),
    bindingFingerprint,
    kind,
  ].join('_')}`;
}

export function boundedIdSegment(value: string, label: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (sanitized.length <= 72) return sanitized;
  const digest = createHash('sha256').update(`${label}:${value}`).digest('hex').slice(0, 16);
  return `${sanitized.slice(0, 55)}_${digest}`;
}

export function generationReplanRequestId(
  taskId: string,
  generationId: string,
  sourceRevision: number,
): string {
  return `generation_replan_${[taskId, generationId, String(sourceRevision)]
    .map(value => value.replace(/[^a-zA-Z0-9_-]/g, '_'))
    .join('_')}`;
}

export function addMilliseconds(value: string, milliseconds: number): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp + milliseconds).toISOString()
    : value;
}
