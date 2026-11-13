/**
 * Task Runtime recovery-item policy (ADR-0055 D5).
 *
 * Formerly the retired recovery deciders. A recovery
 * item is an owner fact: retry is only authorized when idempotency is already
 * proven, and an observed recovery requirement blocks the Task instead of
 * leaving it `running`. The item itself is written by the Runtime, never by this
 * pure policy.
 */
import type { ControlDecision, ControlEvent, ControlSnapshot } from '../control/control-contracts.js';
import { decision } from '../control/control-contracts.js';
import { isTerminalTaskStatus } from '../task/task-state.js';

export function decideRecovery(
  event: Extract<ControlEvent, { type: 'recovery_resolution_requested' }>,
  snapshot: Extract<ControlSnapshot, { type: 'recovery' }>,
): ControlDecision {
  if (!event.taskId || !snapshot.task || snapshot.task.id !== event.taskId || !snapshot.item) {
    return decision(event, { type: 'block_work', taskId: event.taskId ?? '', subtaskId: null }, 'recovery item is missing or stale');
  }
  if (snapshot.item.id !== event.recoveryItemId) {
    return decision(event, { type: 'block_work', taskId: event.taskId, subtaskId: null }, 'recovery item identity mismatch');
  }
  if (event.resolution === 'retry' && !snapshot.item.retrySafe) {
    return decision(event, { type: 'block_work', taskId: event.taskId, subtaskId: null }, 'recovery retry cannot prove idempotency');
  }
  return decision(event, {
    type: 'resolve_recovery',
    taskId: event.taskId,
    recoveryItemId: event.recoveryItemId,
    resolution: event.resolution,
  }, `manual recovery ${event.resolution} authorized`);
}

export function decideRecoveryRequired(
  event: Extract<ControlEvent, { type: 'recovery_required_observed' }>,
  snapshot: Extract<ControlSnapshot, { type: 'recovery_required' }>,
): ControlDecision {
  if (!snapshot.task || snapshot.task.id !== event.taskId) {
    return decision(event, { type: 'no_op' }, 'recovery_required observation has no matching Task');
  }
  if (snapshot.task.status === 'needs_action') {
    return decision(event, { type: 'no_op' }, 'recovery_required blocker is already recorded');
  }
  if (isTerminalTaskStatus(snapshot.task.status)) {
    return decision(event, { type: 'no_op' }, 'recovery_required observation arrived after the Task terminal state');
  }
  return decision(event, {
    type: 'block_work',
    taskId: event.taskId,
    subtaskId: null,
  }, `recovery_required: ${event.reason}`);
}
