/**
 * Task Runtime dispatch and capacity policy (ADR-0055 D3).
 *
 * Formerly `decideDispatch`/`decideCapacity`. The Runtime now
 * evaluates the dispatch round itself: it reads durable facts, picks the ready
 * frontier, the authorized Executor binding and the Attempt claim, and returns
 * one owner operation. Capacity handling (probe the next authorized binding, or
 * wait) is produced here too, and the wait is a persistent Task blocker
 * dependency rather than a decision row.
 */
import { authorizedExecutorBindingFingerprint } from '../core/authorized-executor-binding.js';
import {
  decision,
  type ControlAttemptPayload,
  type ControlDecision,
  type ControlEvent,
  type ControlSnapshot,
} from '../control/control-contracts.js';
import {
  dispatchBatchItems,
  generationReplanRequestId,
  isPendingOrActiveDispatch,
  nextUsableBinding,
  resourceGrantForSubtask,
  selectDispatchableSubtasks,
  singleDispatchBatch,
} from './attempt-dispatch-plan.js';

/**
 * Replan states in which an automatic replan is already converging. While one of
 * them holds, the dispatch round continues independent work instead of
 * re-queuing the same structural repair.
 */
const STRUCTURAL_REPLAN_STATUSES: ReadonlySet<string> = new Set([
  'pending_quiescence',
  'planning',
  'submitted',
  'waiting_for_availability',
]);

/**
 * Owner-owned service repair budget (2026-10-27 realignment §4.3). Three
 * authorized rounds are enough for a real diagnosis-and-fix loop; after that the
 * Task reports the real error and the attempted repairs instead of retrying.
 */
const MAX_SERVICE_REPAIR_ATTEMPTS = 3;
/** Bounded log tail accepted inside one service repair payload. */
const MAX_SERVICE_REPAIR_LOG_BYTES = 8 * 1024;

export function decideDispatch(event: ControlEvent, snapshot: Extract<ControlSnapshot, { type: 'dispatch' }>): ControlDecision {
  if (!event.taskId || !snapshot.task || snapshot.task.id !== event.taskId) return decision(event, { type: 'block_work', taskId: event.taskId ?? '', subtaskId: event.subtaskId ?? null }, 'dispatch task is missing or stale');
  if (snapshot.graphState !== 'ready') {
    return decision(event, { type: 'park_for_replan', taskId: event.taskId }, `work graph is ${snapshot.graphState}; replanning is required`);
  }
  const conversationId = snapshot.task.conversationId
    ?? event.conversationId
    ?? event.sessionId;
  const activeTaskId = snapshot.activeTaskByConversation?.[conversationId]
    ?? (snapshot.activeTaskByConversation ? null : snapshot.runningTaskId);
  if (activeTaskId && activeTaskId !== event.taskId) {
    return decision(event, { type: 'block_work', taskId: event.taskId, subtaskId: event.subtaskId ?? null }, `Conversation execution slot is occupied by ${activeTaskId}`);
  }
  if (event.type === 'dispatch_requested' && event.recovery) {
    const subtask = event.subtaskId
      ? snapshot.subtasks.find(item => item.id === event.subtaskId)
      : null;
    const serviceRepairPayload = event.recovery.attemptPayload?.protocol === 'metawork:service-repair:v1'
      ? event.recovery.attemptPayload
      : null;
    const isServiceRepair = serviceRepairPayload !== null;
    const expectedStatus = event.recovery.attemptKind === 'primary'
      ? 'ready'
      : 'awaiting_decision';
    // A service-repair event is durable before its completed Subtask is
    // reopened. Accepting `done` here lets Kernel application perform the
    // reopen and dispatch as one recoverable workflow application. Other
    // recovery protocols must still start from awaiting_decision.
    const statusAuthorized = subtask?.status === expectedStatus
      || (isServiceRepair && event.recovery.attemptKind === 'continuation' && subtask?.status === 'done');
    if (
      !subtask
      || !statusAuthorized
      || event.recovery.bindingFingerprint !== authorizedExecutorBindingFingerprint(
        event.recovery.authorizedBinding,
      )
      || event.recovery.authorizedBinding.configurationRevision !== event.configurationRevision
      // The binding must still be one the Subtask is authorized to use. A
      // rotated, revoked or expired binding cannot be reused just because its
      // fingerprint is self-consistent.
      || !subtask.executorBindings.some(binding =>
        authorizedExecutorBindingFingerprint(binding) === event.recovery!.bindingFingerprint)
    ) {
      return decision(event, {
        type: 'block_work',
        taskId: event.taskId,
        subtaskId: event.subtaskId ?? null,
      }, 'workspace recovery dispatch identity is incomplete or stale');
    }
    if (serviceRepairPayload) {
      // A service repair is a bounded, ordered continuation. The Kernel owns
      // the budget and the ordinal: a replay of an already-used round, or a
      // round past the budget, is refused instead of re-running the executor.
      const payload = serviceRepairPayload;
      const used = snapshot.serviceRepairAttemptsBySubtask?.[subtask.id] ?? 0;
      if (
        event.recovery.attemptKind !== 'continuation'
        || !event.recovery.sourceAttemptId
        || payload.repairOrdinal !== used
        || used >= MAX_SERVICE_REPAIR_ATTEMPTS
        || typeof payload.serviceId !== 'string'
        || !payload.serviceId
        || typeof payload.specificationRevision !== 'string'
        || !payload.specificationRevision
        || typeof payload.service?.command !== 'string'
        || !Array.isArray(payload.service?.args)
        || (payload.service.logTail?.length ?? 0) > MAX_SERVICE_REPAIR_LOG_BYTES
      ) {
        return decision(event, {
          type: 'block_work',
          taskId: event.taskId,
          subtaskId: subtask.id,
        }, used >= MAX_SERVICE_REPAIR_ATTEMPTS
          ? `service repair budget exhausted after ${used} rounds: ${payload.failure?.summary ?? 'service did not become healthy'}`
          : 'service repair continuation identity is incomplete, stale or out of order');
      }
    }
    return decision(event, singleDispatchBatch(
      event,
      event.taskId,
      subtask.id,
      event.recovery.authorizedBinding,
      event.recovery.attemptKind,
      event.recovery.sourceAttemptId,
      event.recovery.recoveryMode,
      event.recovery.defaultResourceGrant,
      event.recovery.attemptPayload ?? null,
    ), 'exact workspace recovery attempt authorized');
  }
  const subtasks = selectDispatchableSubtasks(snapshot);
  if (subtasks.length === 0) {
    const dependencyReadiness = snapshot.dependencyReadiness ?? [];
    const pendingDependencies = dependencyReadiness.filter(fact => !fact.terminal);
    if (pendingDependencies.length > 0 && (
      snapshot.dispatchItems.some(item => isPendingOrActiveDispatch(item.status))
      || snapshot.subtasks.some(item => item.status === 'awaiting_integration')
      || (snapshot.pendingRetrySubtaskIds?.length ?? 0) > 0
    )) {
      const first = pendingDependencies[0]!;
      return decision(
        event,
        { type: 'no_op' },
        `dependency publication pending: ${first.sourceSubtaskId} -> ${first.targetSubtaskId}; ${first.detail}`,
      );
    }
    const terminalDependencyFailure = dependencyReadiness.find(fact => fact.terminal && fact.code !== 'ready'
      && !snapshot.subtasks.some(item => item.id === fact.targetSubtaskId && ['blocked', 'done', 'cancelled'].includes(item.status)));
    // A dependency that can never be materialized is a structural defect, not a
    // user-input request: spend the one automatic replan first, then block with
    // an explicit system blocker so no surface asks the user for information.
    const structuralReplanActive = snapshot.generationReplanRequest !== undefined
      && snapshot.generationReplanRequest !== null
      && STRUCTURAL_REPLAN_STATUSES.has(snapshot.generationReplanRequest.status);
    if (terminalDependencyFailure && structuralReplanActive) {
      // The repair is already converging: never re-block the Task on the same
      // edge while the Planner still owns the graph.
      return decision(event, { type: 'no_op' }, 'dependency repair replan is in progress');
    }
    if (terminalDependencyFailure) {
      const detail = `dependency materialization failed: ${terminalDependencyFailure.sourceSubtaskId} -> ${terminalDependencyFailure.targetSubtaskId}; ${terminalDependencyFailure.detail}`;
      if ((snapshot.automaticReplansUsed ?? 0) < 1) {
        return decision(event, {
          type: 'queue_generation_replan',
          taskId: event.taskId,
          generationId: snapshot.generationId,
          sourceRevision: snapshot.graphRevision,
          requestId: generationReplanRequestId(
            event.taskId,
            snapshot.generationId,
            snapshot.graphRevision,
          ),
        }, detail);
      }
      return decision(
        event,
        {
          type: 'block_work',
          taskId: event.taskId,
          subtaskId: terminalDependencyFailure.targetSubtaskId,
          blockerKind: 'system',
        },
        `上游结果未能交接给下游节点（系统问题，自动重新规划已用尽）：${terminalDependencyFailure.sourceSubtaskId} -> ${terminalDependencyFailure.targetSubtaskId}；${terminalDependencyFailure.detail}`,
      );
    }
    if (snapshot.generationReplanRequest?.status === 'failed') {
      // Bounded Planner retry budget exhausted. The Task converges to an
      // explicit block instead of remaining `running` with an occupied slot.
      return snapshot.task?.status === 'needs_action'
        ? decision(event, { type: 'no_op' }, 'planner_unavailable blocker is already recorded')
        : decision(event, {
            type: 'block_work',
            taskId: event.taskId,
            subtaskId: null,
          }, 'planner_unavailable: the authorized Replan Job exhausted its retry budget');
    }
    if (snapshot.generationReplanRequest?.status === 'pending_quiescence') {
      return snapshot.generationQuiescent
        ? decision(event, {
            type: 'schedule_replan',
            taskId: event.taskId,
            generationId: snapshot.generationId,
            sourceRevision: snapshot.graphRevision,
            replanJobId: snapshot.generationReplanRequest.id,
          }, 'generation is quiescent; the coalesced automatic replan job may be scheduled')
        : decision(event, { type: 'no_op' }, 'generation replan is waiting for quiescence');
    }
    if (snapshot.subtasks.length > 0 && snapshot.subtasks.every(item => item.status === 'done')) {
      return snapshot.completionBlockedReasons.length === 0
        ? decision(event, { type: 'complete_task', taskId: event.taskId }, 'all Subtasks completed and runtime residue is clear')
        : decision(event, { type: 'no_op' }, `Task completion is waiting for: ${snapshot.completionBlockedReasons.join(', ')}`);
    }
    if (snapshot.dispatchItems.some(item => isPendingOrActiveDispatch(item.status))
      || snapshot.subtasks.some(item => item.status === 'running' || item.status === 'awaiting_integration')) {
      return decision(event, { type: 'no_op' }, 'work is already executing or awaiting publication');
    }
    if (snapshot.pendingRetrySubtaskIds?.length) {
      return decision(event, { type: 'no_op' }, 'unfinished work has a durable retry wake');
    }
    if (snapshot.subtasks.some(item => item.status === 'awaiting_decision')) {
      return decision(event, { type: 'no_op' }, 'safe result awaits an explicit user decision');
    }
    return decision(event, { type: 'block_work', taskId: event.taskId, subtaskId: null }, 'no runnable Subtask while work remains');
  }
  const items = dispatchBatchItems(event, snapshot, subtasks);
  if (items.length === 0) {
    return decision(event, {
      type: 'block_work', taskId: event.taskId, subtaskId: subtasks[0]!.id,
    }, 'no healthy authorized Executor is available for this Subtask');
  }
  return decision(event, { type: 'dispatch_batch', taskId: event.taskId, items }, 'dispatch batch authorized');
}

export function decideCapacity(event: Extract<ControlEvent, { type: 'capacity_signal' }>, snapshot: Extract<ControlSnapshot, { type: 'dispatch' }>): ControlDecision {
  const subtask = snapshot.subtasks.find(item => item.id === event.subtaskId) ?? selectDispatchableSubtasks(snapshot)[0];
  if (!event.taskId || !subtask) return decision(event, { type: 'block_work', taskId: event.taskId ?? '', subtaskId: event.subtaskId ?? null }, 'capacity signal has no ready work');
  if (event.failure) {
    return decision(event, { type: 'block_work', taskId: event.taskId, subtaskId: subtask.id },
      `Executor environment unavailable: ${event.failure.summary}`);
  }
  if (event.attemptKind === 'contract_correction') {
    return event.available
      ? decision(event, singleDispatchBatch(
          event, event.taskId, subtask.id, event.authorizedBinding, 'contract_correction',
          event.attemptId ?? null, 'fresh', resourceGrantForSubtask(snapshot, subtask.id),
          event.attemptPayload,
        ), 'response-only correction capacity confirmed')
      : decision(event, { type: 'block_work', taskId: event.taskId, subtaskId: subtask.id }, 'response-only correction capacity unavailable');
  }
  if (event.available) {
    return decision(event, singleDispatchBatch(
      event, event.taskId, subtask.id, event.authorizedBinding, 'primary',
      null, 'fresh', resourceGrantForSubtask(snapshot, subtask.id),
      null,
    ), 'capacity confirmed');
  }
  const attempted = new Set([
    ...(snapshot.capacityProbeBindingFingerprints[subtask.id] ?? []),
    event.bindingFingerprint,
  ]);
  const binding = nextUsableBinding(subtask, snapshot, event.occurredAt, attempted);
  return binding
    ? decision(event, {
        type: 'probe_capacity',
        taskId: event.taskId,
        subtaskId: subtask.id,
        authorizedBinding: binding,
        bindingFingerprint: authorizedExecutorBindingFingerprint(binding),
      }, 'try next authorized binding')
    : decision(event, { type: 'wait_for_capacity', taskId: event.taskId, subtaskId: subtask.id }, 'authorized AgentClass capacity exhausted');
}
