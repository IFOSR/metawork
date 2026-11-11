/**
 * Task control policy (ADR-0055 §6): explicit user control over a Task is a
 * Task Runtime concern. The Runtime builds the durable snapshot, this pure
 * module authorizes or rejects the requested control, and the Runtime applies
 * the resulting operation in the same transaction that writes its facts.
 *
 * This module used to live inside the Kernel's task-control decider. It is
 * deliberately Kernel-free: it has no event/decision envelope, no ledger and
 * no recovery semantics, so the Task Runtime can own cancellation, partial
 * acceptance and explicit result decisions directly.
 */
import type { PendingResultIdentity } from '../task/safe-result-identity.js';
import { isTerminalTaskStatus, type TaskStatus } from '../task/task-state.js';
import { deriveCancellationClosure } from '../work-graph/index.js';
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';

export type TaskControlSubtaskStatus =
  | 'ready'
  | 'running'
  | 'awaiting_integration'
  | 'awaiting_decision'
  | 'blocked'
  | 'done'
  | 'cancelled';

export interface TaskControlSubtaskFact {
  id: string;
  taskId: string;
  status: TaskControlSubtaskStatus;
  executorBindings: readonly AuthorizedExecutorBinding[];
  dependencySubtaskIds: string[];
}

/** Durable facts read by the Task Runtime before authorizing a control. */
export interface TaskControlSnapshot {
  task: { id: string; status: TaskStatus } | null;
  generationId: string | null;
  graphRevision: number | null;
  subtasks: TaskControlSubtaskFact[];
  completionBlockedReasons: string[];
  partialCancellation: boolean;
  uncertifiedResult?: { subtaskId: string; attemptId: string; resultId: string } | null;
  resultRetrySafe?: boolean;
  acceptedResult?: PendingResultIdentity | null;
  /** Integrated candidates whose Workspace delivery awaits the user. */
  candidateDeliveries?: Array<{ publicationId: string; subtaskId: string }>;
}

export type TaskControlRequest =
  | { kind: 'cancel_task'; taskId: string; reason: string }
  | { kind: 'cancel_subtasks'; taskId: string; targetSubtaskIds: string[]; reason: string }
  | { kind: 'accept_result'; taskId: string; expectedResult?: PendingResultIdentity }
  | { kind: 'retry_result'; taskId: string; expectedResult: PendingResultIdentity };

export type TaskControlAction =
  | { type: 'cancel_task'; taskId: string; generationId: string | null }
  | {
      type: 'cancel_subtasks';
      taskId: string;
      generationId: string;
      graphRevision: number;
      subtaskIds: string[];
      expectedStatuses: Array<{ subtaskId: string; status: TaskControlSubtaskStatus }>;
    }
  | {
      /** Explicit acceptance of isolated candidate deliveries before writeback. */
      type: 'authorize_workspace_delivery';
      taskId: string;
      generationId: string;
      graphRevision: number;
      publicationIds: string[];
    }
  | {
      type: 'accept_partial_result';
      taskId: string;
      generationId: string;
      graphRevision: number;
      completedSubtaskIds: string[];
      cancelledSubtaskIds: string[];
    }
  | {
      type: 'accept_uncertified_result';
      generationId: string;
      graphRevision: number;
      taskId: string;
      subtaskId: string;
      attemptId: string;
      resultId: string;
    }
  | {
      type: 'retry_uncertified_result';
      generationId: string;
      graphRevision: number;
      taskId: string;
      subtaskId: string;
      attemptId: string;
      resultId: string;
    };

export interface AuthorizedTaskControl {
  authorized: true;
  action: TaskControlAction;
  reason: string;
}

export interface RejectedTaskControl {
  authorized: false;
  reason: string;
}

export type TaskControlOutcome = AuthorizedTaskControl | RejectedTaskControl;

function reject(reason: string): RejectedTaskControl {
  return { authorized: false, reason };
}

function authorize(action: TaskControlAction, reason: string): AuthorizedTaskControl {
  return { authorized: true, action, reason };
}

function sameResult(left: PendingResultIdentity, right: PendingResultIdentity): boolean {
  return Object.keys(left).every(key =>
    left[key as keyof PendingResultIdentity] === right[key as keyof PendingResultIdentity]);
}

export function decideTaskControl(
  snapshot: TaskControlSnapshot,
  request: TaskControlRequest,
): TaskControlOutcome {
  if (!snapshot.task || snapshot.task.id !== request.taskId) {
    return reject('Task control target is missing or stale');
  }
  if (request.kind === 'cancel_task') {
    if (isTerminalTaskStatus(snapshot.task.status)) {
      return reject(`Task is already ${snapshot.task.status}`);
    }
    return authorize({
      type: 'cancel_task',
      taskId: request.taskId,
      generationId: snapshot.generationId,
    }, 'durable Task cancellation fence authorized');
  }
  if (!snapshot.generationId || snapshot.graphRevision === null) {
    return reject('active Work Graph generation is missing');
  }
  if (request.kind === 'accept_result'
    && !snapshot.uncertifiedResult
    && (snapshot.candidateDeliveries?.length ?? 0) > 0
    && !isTerminalTaskStatus(snapshot.task.status)) {
    return authorize({
      type: 'authorize_workspace_delivery',
      taskId: request.taskId,
      generationId: snapshot.generationId,
      graphRevision: snapshot.graphRevision,
      publicationIds: snapshot.candidateDeliveries!.map(candidate => candidate.publicationId),
    }, 'explicit acceptance of isolated candidate changes authorized');
  }
  if (request.kind === 'accept_result' || request.kind === 'retry_result') {
    const expected = request.expectedResult;
    const accepted = snapshot.acceptedResult;
    if (request.kind === 'accept_result' && expected && accepted
      && !isTerminalTaskStatus(snapshot.task.status)
      && sameResult(expected, accepted)) {
      return authorize({ type: 'accept_uncertified_result', ...accepted },
        'previously authorized result acceptance replay');
    }
    const pending = snapshot.uncertifiedResult;
    if (isTerminalTaskStatus(snapshot.task.status)
      || (expected && (!pending || expected.taskId !== request.taskId
        || expected.generationId !== snapshot.generationId || expected.graphRevision !== snapshot.graphRevision
        || expected.subtaskId !== pending.subtaskId || expected.attemptId !== pending.attemptId
        || expected.resultId !== pending.resultId))) {
      return reject('该结果操作已过期，请刷新任务后重试。');
    }
    if (request.kind === 'retry_result') {
      if (!pending || !snapshot.resultRetrySafe) {
        return reject('无法安全重新执行：请先确认不确定的外部副作用。');
      }
      return authorize({
        type: 'retry_uncertified_result',
        taskId: request.taskId,
        generationId: snapshot.generationId,
        graphRevision: snapshot.graphRevision,
        ...pending,
      }, 'explicit safe result retry authorized');
    }
  }
  if (request.kind === 'accept_result' && snapshot.uncertifiedResult && !snapshot.partialCancellation) {
    return authorize({
      type: 'accept_uncertified_result',
      generationId: snapshot.generationId,
      graphRevision: snapshot.graphRevision,
      taskId: request.taskId,
      subtaskId: snapshot.uncertifiedResult.subtaskId,
      attemptId: snapshot.uncertifiedResult.attemptId,
      resultId: snapshot.uncertifiedResult.resultId,
    }, 'explicit acceptance of the safe uncertified result authorized');
  }
  if (request.kind === 'cancel_subtasks') {
    const closure = deriveCancellationClosure(
      {
        subtasks: snapshot.subtasks.map(subtask => ({
          id: subtask.id,
          dependencies: subtask.dependencySubtaskIds.map(fromSubtaskId => ({ fromSubtaskId })),
        })),
      },
      snapshot.subtasks.map(subtask => ({ subtaskId: subtask.id, status: subtask.status })),
      request.targetSubtaskIds,
    );
    if (!closure.ok) {
      return reject(
        `Subtask cancellation rejected (${closure.reason}): ${closure.subtaskIds.join(', ')}`,
      );
    }
    const selected = new Set(closure.subtaskIds);
    return authorize({
      type: 'cancel_subtasks',
      taskId: request.taskId,
      generationId: snapshot.generationId,
      graphRevision: snapshot.graphRevision,
      subtaskIds: closure.subtaskIds,
      expectedStatuses: snapshot.subtasks
        .filter(subtask => selected.has(subtask.id))
        .map(subtask => ({ subtaskId: subtask.id, status: subtask.status }))
        .sort((left, right) => left.subtaskId.localeCompare(right.subtaskId)),
    }, 'atomic downstream Subtask cancellation closure authorized');
  }
  const completedSubtaskIds = snapshot.subtasks
    .filter(subtask => subtask.status === 'done')
    .map(subtask => subtask.id)
    .sort();
  const cancelledSubtaskIds = snapshot.subtasks
    .filter(subtask => subtask.status === 'cancelled')
    .map(subtask => subtask.id)
    .sort();
  if (
    request.kind !== 'accept_result'
    || snapshot.task.status !== 'needs_action'
    || !snapshot.partialCancellation
    || completedSubtaskIds.length === 0
    || snapshot.subtasks.some(subtask => !['done', 'cancelled'].includes(subtask.status))
    || snapshot.completionBlockedReasons.length > 0
  ) {
    return reject('partial result is not ready for explicit acceptance');
  }
  return authorize({
    type: 'accept_partial_result',
    taskId: request.taskId,
    generationId: snapshot.generationId,
    graphRevision: snapshot.graphRevision,
    completedSubtaskIds,
    cancelledSubtaskIds,
  }, 'explicit partial result acceptance authorized');
}
