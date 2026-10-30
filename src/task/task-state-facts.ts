/**
 * Task state facts (2026-10-22 Task state simplification §3.3, §5.3).
 *
 * `readTaskEvaluationFacts()` turns durable operational evidence into the one
 * input shape `evaluateTaskState()` accepts. It is pure: a facts port supplies
 * the raw rows, this module decides what they mean for the Task conclusion.
 *
 * Operational records keep their own state. They report facts here; they never
 * decide a Task result on their own.
 */

import type { SubtaskStatus, Task } from '../core/types.js';
import type { KernelDispatchItemStatus } from '../kernel/control-kernel.js';
import type { PendingResultIdentity } from './safe-result-identity.js';
import { isServiceReadyState } from './local-service.js';
import {
  createTaskReason,
  type TaskCleanupSummary,
  type TaskPendingAction,
  type TaskReason,
  type TaskRequiredWorkFact,
  type TaskRequiredWorkKind,
  type TaskStateDetail,
} from './task-state.js';

/** A durable completion requirement recorded with the authorized graph. */
export interface CompletionRequirementSpec {
  readonly key: string;
  readonly kind: TaskRequiredWorkKind;
  readonly label: string;
  readonly subtaskId: string | null;
  readonly serviceId: string | null;
}

export interface TaskRawSubtaskFact {
  readonly id: string;
  readonly title: string;
  readonly status: SubtaskStatus;
  readonly dependencySubtaskIds: readonly string[];
}

export interface TaskRawDispatchFact {
  readonly attemptId: string;
  readonly subtaskId: string;
  readonly status: KernelDispatchItemStatus;
  readonly generationId: string;
}

export interface TaskRawReceiptFact {
  readonly attemptId: string;
  readonly subtaskId: string;
  readonly terminalState:
    | 'completed'
    | 'uncertified_result'
    | 'executor_failed'
    | 'contract_blocked'
    | 'heartbeat_lost'
    | 'cancelled_or_stale';
  readonly failureCode: string | null;
  readonly failureKind: string | null;
  readonly completedAt: string;
  readonly accepted?: boolean;
}

export interface TaskRawPublicationFact {
  readonly id: string;
  readonly subtaskId: string;
  readonly status:
    | 'pending'
    | 'applying'
    | 'conflicted'
    | 'integrated'
    | 'parked'
    | 'cancelling'
    | 'cancelled'
    | 'uncertain';
  readonly deliveryStatus: 'pending' | 'failed' | 'succeeded' | null;
  /** Candidate change set ready inside isolation; awaiting explicit acceptance. */
  readonly awaitingAcceptance?: boolean;
}

export interface TaskRawRetryWakeFact {
  readonly wakeId: string;
  readonly status: 'armed' | 'fired' | 'consumed' | 'superseded' | 'recovery_required';
  readonly resumeAt: string;
}

export interface TaskRawReplanFact {
  readonly id: string;
  readonly status:
    | 'pending_quiescence'
    | 'planning'
    | 'submitted'
    | 'waiting_for_availability'
    | 'resolved'
    | 'cancelled'
    | 'failed';
}

export interface TaskRawServiceFact {
  readonly serviceId: string;
  readonly state: 'starting' | 'running' | 'healthy' | 'unhealthy' | 'stopped' | 'failed';
  readonly healthMessage: string | null;
}

export interface TaskStateRawFacts {
  readonly task: Task;
  readonly workspaceDelivery?: {readonly summary: import('../workspace/workspace-git-contracts.js').WorkspaceMergeSummary|null;readonly noChanges:boolean;readonly held?:boolean};
  readonly activeGraph: { readonly generationId: string; readonly revision: number } | null;
  readonly subtasks: readonly TaskRawSubtaskFact[];
  readonly dispatches: readonly TaskRawDispatchFact[];
  readonly receipts: readonly TaskRawReceiptFact[];
  readonly publications: readonly TaskRawPublicationFact[];
  readonly retryWakes: readonly TaskRawRetryWakeFact[];
  readonly replans: readonly TaskRawReplanFact[];
  /** An uncertified result that still needs an explicit user decision. */
  readonly pendingResult: PendingResultIdentity | null;
  readonly pendingResults?: readonly PendingResultIdentity[];
  readonly pendingPermission: { readonly requestId: string } | null;
  readonly service: TaskRawServiceFact | null;
  /** The authorized graph requires the Task to start and take over a service. */
  readonly serviceRequired: boolean;
  readonly slot: 'none' | 'held';
  readonly cleanup: TaskCleanupSummary;
  readonly completionRequirements: readonly CompletionRequirementSpec[];
  /** Ready work is only waiting for capacity (slot or executor availability). */
  readonly capacityWaiting: boolean;
  /** An operation's external outcome is unknown and must be verified. */
  readonly externalOutcomeUnknown: boolean;
  /** Normalized operation results (service start, delivery, integration). */
  readonly operationResults: readonly {
    readonly operationKey: string;
    readonly operationKind: string;
    readonly outcome: 'success' | 'definite_failure' | 'unknown' | 'repair_pending';
    readonly reasonCode: string | null;
    readonly message: string;
    readonly evidenceRefs: readonly string[];
  }[];
  /** A committed cancellation decision exists for this Task. */
  readonly cancelFence: boolean;
  readonly authorizedContinuation?: boolean;
  /** Every remaining Subtask is settled by cancellation and needs acceptance. */
  readonly partialAcceptancePending: boolean;
}

/** Port the Storage adapter implements. The Task Domain never imports SQLite. */
export interface TaskStateFactsPort {
  read(taskId: string): TaskStateRawFacts | null;
}

export interface TaskEvaluationInput {
  readonly requiredWork: readonly TaskRequiredWorkFact[];
  readonly pendingActions: readonly TaskPendingAction[];
  readonly runnableWork: boolean;
  readonly activeOperation: { phase: import('./task-state.js').TaskOperationPhase; reason: TaskReason | null } | null;
  readonly boundedRecovery: { nextWakeAt: string; reason: TaskReason | null } | null;
  readonly slot: 'none' | 'held';
  readonly capacityWaiting: boolean;
  readonly cleanup: TaskCleanupSummary;
  readonly failureReason: TaskReason | null;
  readonly anomaly: TaskReason | null;
}

const ACTIVE_DISPATCH: readonly KernelDispatchItemStatus[] = [
  'pending_launch', 'launching', 'running', 'cancelling',
];

const FAILED_TERMINAL_STATES = new Set(['executor_failed', 'contract_blocked', 'heartbeat_lost']);
const UNCERTAIN_FAILURE_KINDS = new Set([
  'unknown', 'timeout', 'network', 'infrastructure', 'heartbeat_lost',
]);

export function readTaskEvaluationInput(raw: TaskStateRawFacts): TaskEvaluationInput {
  const receiptsBySubtask = new Map<string, TaskRawReceiptFact[]>();
  for (const receipt of raw.receipts) {
    const list = receiptsBySubtask.get(receipt.subtaskId) ?? [];
    list.push(receipt);
    receiptsBySubtask.set(receipt.subtaskId, list);
  }
  // A dispatch whose Attempt already produced a receipt is settled evidence,
  // even if the dispatch row's status write is still in flight. It cannot be a
  // live operation.
  const settledAttempts = new Set(raw.receipts.map(receipt => receipt.attemptId));
  const activeDispatchBySubtask = new Map<string, TaskRawDispatchFact>();
  for (const dispatch of raw.dispatches) {
    if (!ACTIVE_DISPATCH.includes(dispatch.status)) continue;
    if (settledAttempts.has(dispatch.attemptId)) continue;
    activeDispatchBySubtask.set(dispatch.subtaskId, dispatch);
  }
  const publicationBySubtask = new Map<string, TaskRawPublicationFact>();
  for (const publication of raw.publications) {
    publicationBySubtask.set(publication.subtaskId, publication);
  }
  const armedRetry = raw.retryWakes.find(wake => wake.status === 'armed' || wake.status === 'fired') ?? null;
  const retryRecoveryRequired = raw.retryWakes.some(wake => wake.status === 'recovery_required');
  const activeReplan = raw.replans.find(replan => [
    'pending_quiescence', 'planning', 'submitted',
  ].includes(replan.status)) ?? null;
  const waitingForAvailability = raw.replans.some(replan => replan.status === 'waiting_for_availability');

  const pendingActions: TaskPendingAction[] = [];
  for (const pendingResult of raw.pendingResults ?? (raw.pendingResult ? [raw.pendingResult] : [])) {
    pendingActions.push({
      actionId: `accept:${pendingResult.subtaskId}:${pendingResult.attemptId}:${pendingResult.resultId}`,
      kind: 'accept_result',
      label: '接受结果并继续交付',
      reason: createTaskReason(
        'result_acceptance_required',
        '结果已安全保存，但完成验收还缺少执行说明。',
        [`receipt:${pendingResult.attemptId}`, `result:${pendingResult.resultId}`],
      ),
      result: pendingResult,
    });
  }
  if (raw.partialAcceptancePending) {
    pendingActions.push({
      actionId: `accept_partial:${raw.task.id}`,
      kind: 'accept_result',
      label: '接受已完成的部分结果',
      reason: createTaskReason(
        'result_acceptance_required',
        '其余工作已取消或完成，需要确认接受部分结果。',
        [`task:${raw.task.id}`],
      ),
      result: null,
    });
  }
  // Only an unknown outcome requires verification on this Task. A definite
  // delivery failure is terminal; explicit retry belongs to a new Task.
  for (const publication of raw.publications) {
    if (publication.awaitingAcceptance && !pendingActions.some(
      action => action.actionId === `accept_delivery:${publication.id}`,
    )) {
      pendingActions.push({
        actionId: `accept_delivery:${publication.id}`,
        kind: 'accept_result',
        label: '接受候选变更并发布到工作区',
        reason: createTaskReason(
          'input_required',
          '候选变更已在隔离环境完成，等待你接受后才会写入目标工作区。',
          [`publication:${publication.id}`],
        ),
        result: null,
        publicationId: publication.id,
      });
    }
    if (publication.status !== 'uncertain') continue;
    if (pendingActions.some(action => action.actionId === `delivery:${publication.id}`)) continue;
    pendingActions.push({
      actionId: `delivery:${publication.id}`,
      kind: 'resolve_recovery',
      label: '重试文件交付',
      reason: publication.deliveryStatus === 'failed'
        ? createTaskReason('delivery_failed', '文件交付失败。', [`publication:${publication.id}`])
        : createTaskReason('external_outcome_unknown', '交付结果未知，需要核实。',
          [`publication:${publication.id}`]),
      result: null,
    });
  }

  if (raw.externalOutcomeUnknown && pendingActions.length === 0) {
    const unknown = latestOperation(raw, 'execution');
    pendingActions.push({
      actionId: `recovery:${raw.task.id}`,
      kind: 'resolve_recovery',
      label: '核实上次执行结果',
      reason: unknown
        ? createTaskReason(
            operationReasonCode(unknown.reasonCode, 'external_outcome_unknown'),
            unknown.message || '外部操作结果未知，需要核实。',
            [...unknown.evidenceRefs],
          )
        : createTaskReason(
            'external_outcome_unknown',
            '存在结果不明的外部操作，需要核实。',
            [`task:${raw.task.id}`],
          ),
      result: null,
    });
  }
  if (raw.pendingPermission) {
    pendingActions.push({
      actionId: `permission:${raw.pendingPermission.requestId}`,
      kind: 'provide_input',
      label: '确认所需权限',
      reason: createTaskReason(
        'input_required',
        '需要用户确认权限后才能继续。',
        [`permission:${raw.pendingPermission.requestId}`],
      ),
      result: null,
    });
  }

  const merge = raw.workspaceDelivery?.summary;
  if(merge && ['conflicted','recovering'].includes(merge.state))pendingActions.push({
    actionId:`workspace_merge:${merge.jobId}:${merge.conflictVersion}`,kind:'resolve_recovery',label:merge.state==='conflicted'?'解决 Workspace 合并冲突':'重试 Workspace 写回',
    reason:createTaskReason(merge.state==='conflicted'?'workspace_merge_conflict':'delivery_failed',merge.error??'Workspace 交付需要处理。',[`workspace_merge:${merge.jobId}`]),result:null,
    workspaceMerge:{jobId:merge.jobId,conflictVersion:merge.conflictVersion,rowVersion:merge.rowVersion},
  });
  const requiredWork: TaskRequiredWorkFact[] = [];
  const failureReasons: TaskReason[] = [];
  for (const requirement of raw.completionRequirements) {
    const work = resolveRequiredWork({
      requirement,
      raw,
      receipts: requirement.subtaskId ? receiptsBySubtask.get(requirement.subtaskId) ?? [] : [],
      activeDispatch: requirement.subtaskId ? activeDispatchBySubtask.get(requirement.subtaskId) ?? null : null,
      publication: requirement.subtaskId ? publicationBySubtask.get(requirement.subtaskId) ?? null : null,
      armedRetry,
      externalOutcomeUnknown: raw.externalOutcomeUnknown,
    });
    requiredWork.push(work.fact);
    if (work.failureReason) failureReasons.push(work.failureReason);
  }

  const activeDispatch = [...activeDispatchBySubtask.values()]
    .find(dispatch => dispatch.status === 'running' || dispatch.status === 'launching') ?? null;
  const startingService = raw.serviceRequired && raw.service?.state === 'starting';
  const publishing = raw.publications.some(publication => (
    publication.status === 'pending' || publication.status === 'applying'
  ));
  const delivering = raw.publications.some(
    publication => publication.deliveryStatus === 'pending' && !publication.awaitingAcceptance,
  );
  // An unverified external outcome is not a live operation: the driver must be
  // reconciled before the Task can claim it is doing work.
  // A required operation whose failure the authorized Executor can still repair
  // keeps the Task running: the repair continuation is work in progress, not a
  // user decision (2026-10-27 realignment §4.3/§5.2).
  const serviceRepairPending = latestServiceOperation(raw)?.outcome === 'repair_pending';
  const activeOperation = raw.externalOutcomeUnknown ? null : activeDispatch
    ? { phase: 'executing' as const, reason: null }
    : merge && ['queued','preparing','merging','writing'].includes(merge.state)
      ? {phase: merge.state==='writing' ? 'delivering' as const : 'publishing' as const,reason:null}
    : publishing
      ? { phase: 'publishing' as const, reason: null }
      : delivering
        ? { phase: 'delivering' as const, reason: null }
        : startingService
          ? { phase: 'starting_service' as const, reason: null }
          : serviceRepairPending
            ? {
                phase: 'retrying' as const,
                reason: createTaskReason(
                  'service_start_failed',
                  latestServiceOperation(raw)?.message || '服务未能就绪，正在自动修复。',
                  [...(latestServiceOperation(raw)?.evidenceRefs ?? [])],
                ),
              }
            : activeReplan
              ? { phase: 'verifying' as const, reason: null }
              : null;

  const boundedRecovery = armedRetry
    ? { nextWakeAt: armedRetry.resumeAt, reason: createTaskReason('none', '自动重试已排期。') }
    : null;

  const blockers = raw.task.dependencies.filter(dependency => dependency.status === 'waiting');
  // A `kernel_anomaly` blocker is a structural failure the Kernel already tried
  // to repair: it keeps the Task in `needs_action`, but it is never a request for
  // user input and must not produce a `provide_input` pending action.
  const systemBlockers = blockers.filter(dependency => dependency.type === 'kernel_anomaly');
  const userBlockers = blockers.filter(dependency => (
    dependency.type !== 'kernel_retry' && dependency.type !== 'kernel_capacity'
    && dependency.type !== 'kernel_anomaly'
  ));
  const allRequiredWorkComplete = requiredWork.length > 0
    && requiredWork.every(work => work.state === 'completed');
  for (const dependency of userBlockers) {
    // A blocker that only existed to unblock work is moot once every required
    // item is complete. Keeping it would ask the user for input after the Task
    // already delivered, which is exactly the dead end a stale authorization
    // gate produced (2026-10-28 execution-fact contract).
    if (allRequiredWorkComplete) continue;
    pendingActions.push({ actionId: `dependency:${dependency.type}:${dependency.createdAt}:${dependency.description}`,
      kind: 'provide_input', label: dependency.description,
      reason: createTaskReason(
        /unknown requires explicit recovery|外部副作用|uncertain external/iu.test(dependency.description)
          ? 'external_outcome_unknown' : 'input_required',
        dependency.description, [`task:${raw.task.id}`]), result: null });
  }
  const capacityBlockers = blockers.some(dependency => dependency.type === 'kernel_capacity');
  const runnableWork = userBlockers.length === 0 && deriveRunnableWork({
    raw,
    requiredWork,
    activeDispatchBySubtask,
    waitingForAvailability,
  });

  const failureReason = failureReasons[0] ?? null;
  // A blocker that names an unverifiable external effect keeps that meaning, so
  // an explicit resume cannot pretend the unknown outcome is resolved.
  const unknownBlocker = userBlockers.some(dependency => (
    /unknown requires explicit recovery|外部副作用|uncertain external/iu.test(dependency.description)
  ));
  const anomaly = userBlockers.length > 0
    ? createTaskReason(
        unknownBlocker ? 'external_outcome_unknown' : 'input_required',
        userBlockers[0]!.description,
        userBlockers.map(dependency => `dependency:${dependency.type}`),
      )
    : systemBlockers.length > 0
      ? createTaskReason(
          'system_anomaly',
          systemBlockers[0]!.description,
          systemBlockers.map(dependency => `dependency:${dependency.type}`),
        )
      : deriveAnomaly({
        raw,
        requiredWork,
        activeReplan: activeReplan !== null,
        retryRecoveryRequired,
      });

  return {
    requiredWork,
    pendingActions,
    runnableWork,
    activeOperation,
    boundedRecovery,
    slot: raw.slot,
    capacityWaiting: raw.capacityWaiting || capacityBlockers || waitingForAvailability,
    cleanup: raw.cleanup,
    failureReason,
    anomaly,
  };
}

function resolveRequiredWork(input: {
  requirement: CompletionRequirementSpec;
  raw: TaskStateRawFacts;
  receipts: readonly TaskRawReceiptFact[];
  activeDispatch: TaskRawDispatchFact | null;
  publication: TaskRawPublicationFact | null;
  armedRetry: TaskRawRetryWakeFact | null;
  externalOutcomeUnknown: boolean;
}): { fact: TaskRequiredWorkFact; failureReason: TaskReason | null } {
  const { requirement } = input;
  const base = { key: requirement.key, kind: requirement.kind, label: requirement.label };
  if(requirement.kind==='workspace_delivery') {
    const delivery=input.raw.workspaceDelivery;
    if(delivery?.summary?.state==='cancelled') return {fact:{...base,state:'failed',reason:createTaskReason('delivery_failed','Workspace 交付已取消，成果保留。')},failureReason:createTaskReason('delivery_failed','Workspace 交付已取消，成果保留。')};
    const state=(delivery?.noChanges||delivery?.held)||delivery?.summary?.state==='delivered'?'completed'
      :delivery?.summary && ['conflicted','recovering'].includes(delivery.summary.state)?'waiting_for_user'
      :delivery?.summary && ['preparing','merging','writing'].includes(delivery.summary.state)?'running':'pending';
    return {fact:{...base,state,reason:null},failureReason:null};
  }
  if (requirement.kind === 'service') {
    const service = input.raw.service;
    // Service operations are keyed per source Attempt, revision and repair
    // round (2026-10-27 realignment §4.3), so the requirement reads the latest
    // service operation fact instead of one fixed key.
    const operation = latestServiceOperation(input.raw);
    if (operation?.outcome === 'success' || (isServiceReadyState(service?.state)
      && operation?.outcome !== 'definite_failure' && operation?.outcome !== 'repair_pending')) {
      return { fact: { ...base, state: 'completed', reason: null }, failureReason: null };
    }
    if (operation?.outcome === 'repair_pending') {
      // The failure is real, but the authorized repair round has not run yet.
      // This is not a conclusion: the Task stays running and the reason keeps
      // the real diagnosis visible.
      const reason = createTaskReason(
        operationReasonCode(operation.reasonCode, 'service_start_failed'),
        operation.message || '服务未能就绪，正在自动修复。',
        [...operation.evidenceRefs],
      );
      return { fact: { ...base, state: 'running', reason }, failureReason: null };
    }
    if (operation?.outcome === 'definite_failure') {
      const reason = createTaskReason(
        operationReasonCode(operation.reasonCode, 'service_start_failed'),
        operation.message || '服务未能启动。',
        [...operation.evidenceRefs],
      );
      return { fact: { ...base, state: 'failed', reason }, failureReason: reason };
    }
    if (operation?.outcome === 'unknown') {
      const reason = createTaskReason(
        'external_outcome_unknown',
        operation.message || '服务启动结果未知，需要核实。',
        [...operation.evidenceRefs],
      );
      return { fact: { ...base, state: 'waiting_for_user', reason }, failureReason: null };
    }
    if (service?.state === 'failed' || service?.state === 'unhealthy') {
      const reason = createTaskReason(
        'service_start_failed',
        service.healthMessage ?? '服务未能启动。',
        [`service:${service.serviceId}`],
      );
      return { fact: { ...base, state: 'failed', reason }, failureReason: reason };
    }
    return {
      fact: {
        ...base,
        state: service?.state === 'starting' ? 'running' : 'pending',
        reason: null,
      },
      failureReason: null,
    };
  }
  const normalized = requirement.kind === 'delivery'
    ? latestOperation(input.raw, 'delivery', input.publication ? `delivery:${input.publication.id}` : requirement.key)
    : null;
  if (normalized?.outcome === 'definite_failure') {
    const reason = createTaskReason(
      operationReasonCode(normalized.reasonCode, 'delivery_failed'),
      normalized.message || '交付失败。',
      [...normalized.evidenceRefs],
    );
    return { fact: { ...base, state: 'failed', reason }, failureReason: reason };
  }
  if (normalized?.outcome === 'unknown') {
    return {
      fact: {
        ...base,
        state: 'waiting_for_user',
        reason: createTaskReason(
          'external_outcome_unknown',
          normalized.message || '外部操作结果未知，需要核实。',
          [...normalized.evidenceRefs],
        ),
      },
      failureReason: null,
    };
  }
  if (normalized?.outcome === 'success') {
    return { fact: { ...base, state: 'completed', reason: null }, failureReason: null };
  }
  const subtask = requirement.subtaskId
    ? input.raw.subtasks.find(item => item.id === requirement.subtaskId) ?? null
    : null;
  if (!subtask) {
    return { fact: { ...base, state: 'pending', reason: null }, failureReason: null };
  }
  const latestReceipt = [...input.receipts]
    .sort((left, right) => left.completedAt.localeCompare(right.completedAt)).at(-1) ?? null;
  // Completion evidence belongs to the attempt that produced the result, not to
  // the newest attempt. A failed metadata correction is newer but proves
  // nothing, so an accepted/certified result still closes the node
  // (2026-10-28 execution-fact contract).
  const hasCompletionEvidence = input.receipts.some(receipt =>
    receipt.terminalState === 'completed' || receipt.accepted === true);
  if (requirement.kind === 'safety_report') {
    // A safety report is delivered inline with the result object, so the
    // Subtask's own completion is its durable delivery evidence. File delivery
    // (`delivery`) additionally requires the publication checkpoint below.
    return subtask.status === 'done' && hasCompletionEvidence
      ? { fact: { ...base, state: 'completed', reason: null }, failureReason: null }
      : { fact: { ...base, state: 'pending', reason: null }, failureReason: null };
  }
  if (requirement.kind === 'delivery') {
    // In-place attempts write the Conversation Workspace directly and never
    // create a publication row. A completed receipt plus a done Subtask is
    // the durable delivery fact for declared file outputs.
    if (input.raw.task.executionMode === 'in_place'
      && subtask.status === 'done'
      && hasCompletionEvidence) {
      return { fact: { ...base, state: 'completed', reason: null }, failureReason: null };
    }
    // The normalized operation result is the latest word on delivery, so a
    // successful retry settles the requirement even while the publication row
    // still carries the earlier failure.
    const operation = normalized;
    if (operation?.outcome === 'success') {
      return { fact: { ...base, state: 'completed', reason: null }, failureReason: null };
    }
    const publication = input.publication;
    if (publication?.status === 'integrated' && publication.deliveryStatus === 'succeeded') {
      return { fact: { ...base, state: 'completed', reason: null }, failureReason: null };
    }
    if (publication?.deliveryStatus === 'failed') {
      // Preserve the integrated artifact while recording the definite failure.
      const reason = createTaskReason(
        'delivery_failed',
        '文件交付失败。',
        [`publication:${publication.id}`],
      );
      return { fact: { ...base, state: 'failed', reason }, failureReason: reason };
    }
    if (publication?.status === 'uncertain') {
      const reason = createTaskReason(
        'external_outcome_unknown',
        '交付结果未知，需要核实。',
        [`publication:${publication.id}`],
      );
      return { fact: { ...base, state: 'waiting_for_user', reason }, failureReason: null };
    }
    return {
      fact: {
        ...base,
        state: publication?.status === 'pending' || publication?.status === 'applying'
          ? 'running'
          : 'pending',
        reason: null,
      },
      failureReason: null,
    };
  }
  if (subtask.status === 'done' && hasCompletionEvidence) {
    // `done` is only evidence when the result was certified or explicitly
    // accepted; otherwise the pending acceptance action carries the fact.
    return { fact: { ...base, state: 'completed', reason: null }, failureReason: null };
  }
  if (subtask.status === 'awaiting_integration' && input.publication?.status === 'integrated') {
    // The attempt settled and its candidate was integrated and delivered. That
    // is the durable completion evidence for this node (design §3.4: 执行产出及
    // 验收 / 文件交付), so the required work is settled even before the Subtask
    // row itself is closed by Task completion.
    return { fact: { ...base, state: 'completed', reason: null }, failureReason: null };
  }
  if (subtask.status === 'cancelled') {
    // Cancelling a Subtask is an explicit user-scope decision, so that required
    // work item is settled. The audit keeps why; the conclusion does not block.
    return { fact: { ...base, state: 'completed', reason: null }, failureReason: null };
  }
  // An interrupted or unverifiable failure is not a definite business failure:
  // the design requires bounded verification and then `needs_action`, never a
  // fabricated `failed` or a blind retry.
  const uncertainFailure = latestReceipt?.failureKind !== null
    && latestReceipt?.failureKind !== undefined
    && UNCERTAIN_FAILURE_KINDS.has(latestReceipt.failureKind);
  const definiteFailure = latestReceipt
    && FAILED_TERMINAL_STATES.has(latestReceipt.terminalState)
    && latestReceipt.failureCode !== null
    && latestReceipt.failureCode !== 'unknown'
    && !uncertainFailure;
  if (subtask.status === 'blocked' && definiteFailure && !input.armedRetry) {
    const reason = failureReasonFor(latestReceipt!);
    return { fact: { ...base, state: 'failed', reason }, failureReason: reason };
  }
  if (subtask.status === 'blocked' && latestReceipt && uncertainFailure) {
    const reason = createTaskReason(
      'external_outcome_unknown',
      latestReceipt?.failureCode ?? '外部操作结果未知，需要核实。',
      [`receipt:${latestReceipt!.attemptId}`],
    );
    return { fact: { ...base, state: 'waiting_for_user', reason }, failureReason: null };
  }
  if (subtask.status === 'blocked' && input.externalOutcomeUnknown) {
    const reason = createTaskReason(
      'external_outcome_unknown',
      '存在结果不明的外部操作，需要核实。',
      [`subtask:${subtask.id}`],
    );
    return { fact: { ...base, state: 'waiting_for_user', reason }, failureReason: null };
  }
  if (input.activeDispatch || subtask.status === 'running') {
    return { fact: { ...base, state: 'running', reason: null }, failureReason: null };
  }
  if (subtask.status === 'blocked') {
    return { fact: { ...base, state: 'waiting_for_user', reason: null }, failureReason: null };
  }
  // `awaiting_decision` only blocks while an actionable result is still pending.
  // After a committed acceptance the work continues (publish/deliver) instead of
  // keeping the Task in `needs_action`.
  if (subtask.status === 'awaiting_decision'
    && (input.raw.pendingResults ?? (input.raw.pendingResult ? [input.raw.pendingResult] : []))
      .some(result => result.subtaskId === subtask.id)) {
    return { fact: { ...base, state: 'waiting_for_user', reason: null }, failureReason: null };
  }
  return { fact: { ...base, state: 'pending', reason: null }, failureReason: null };
}

function latestServiceOperation(
  raw: TaskStateRawFacts,
): TaskStateRawFacts['operationResults'][number] | null {
  return latestOperation(raw, 'service');
}

function latestOperation(
  raw: TaskStateRawFacts,
  kind: string,
  operationKey?: string,
): TaskStateRawFacts['operationResults'][number] | null {
  return [...raw.operationResults]
    .filter(result => result.operationKind === kind
      && (operationKey === undefined || result.operationKey === operationKey))
    .at(-1) ?? null;
}

function operationReasonCode(
  code: string | null,
  fallback: import('./task-state.js').TaskReasonCode,
): import('./task-state.js').TaskReasonCode {
  const candidate = (code ?? '').toLowerCase();
  if (candidate.includes('eaddrinuse') || candidate.includes('port_in_use')) return 'port_in_use';
  if (candidate.includes('enoent') || candidate.includes('command_not_found')) return 'command_not_found';
  if (candidate.includes('health')) return 'service_health_timeout';
  if (candidate.includes('service') && candidate.includes('timeout')) return 'service_health_timeout';
  if (candidate.includes('delivery')) return 'delivery_failed';
  if (candidate.includes('retry')) return 'retry_exhausted';
  if (candidate.includes('unknown')) return 'external_outcome_unknown';
  return fallback;
}

function failureReasonFor(receipt: TaskRawReceiptFact): TaskReason {
  const code = receipt.failureCode === 'port_in_use'
    ? 'port_in_use' as const
    : receipt.failureCode === 'command_not_found'
      ? 'command_not_found' as const
      : receipt.failureCode === 'service_health_timeout'
        ? 'service_health_timeout' as const
        : receipt.failureCode === 'retry_exhausted'
          ? 'retry_exhausted' as const
          : 'execution_failed' as const;
  return createTaskReason(code, failureMessageFor(code), [`receipt:${receipt.attemptId}`]);
}

function failureMessageFor(code: ReturnType<typeof failureReasonFor>['code']): string {
  switch (code) {
    case 'port_in_use':
      return '端口已被占用。';
    case 'command_not_found':
      return '所需的命令不存在。';
    case 'service_health_timeout':
      return '服务在启动期限内未通过健康检查。';
    case 'retry_exhausted':
      return '自动重试次数或时间预算已耗尽。';
    default:
      return '必需工作确定失败。';
  }
}

function deriveRunnableWork(input: {
  raw: TaskStateRawFacts;
  requiredWork: readonly TaskRequiredWorkFact[];
  activeDispatchBySubtask: ReadonlyMap<string, TaskRawDispatchFact>;
  waitingForAvailability: boolean;
}): boolean {
  if (input.raw.authorizedContinuation) return true;
  const byId = new Map(input.raw.subtasks.map(subtask => [subtask.id, subtask]));
  for (const subtask of input.raw.subtasks) {
    if (subtask.status !== 'ready') continue;
    // A branch blocked by a failed dependency is not runnable.
    const dependenciesReady = subtask.dependencySubtaskIds
      .every(dependencyId => byId.get(dependencyId)?.status === 'done');
    if (dependenciesReady) return true;
  }
  // Only required work that the runtime can actually drive counts as runnable.
  // A delivery/service retry needs an explicit user resume, and a conflicted
  // publication waits for the Kernel's conflict path.
  const autoDriven = input.requiredWork.some(work => (
    work.kind === 'service' && work.state === 'pending'
    && input.requiredWork.filter(item => item.kind !== 'service')
      .every(item => item.state === 'completed')
    && input.raw.pendingResult === null
  ));
  return autoDriven && !input.waitingForAvailability;
}

function deriveAnomaly(input: {
  raw: TaskStateRawFacts;
  requiredWork: readonly TaskRequiredWorkFact[];
  activeReplan: boolean;
  retryRecoveryRequired: boolean;
}): TaskReason | null {
  if (input.retryRecoveryRequired) {
    return createTaskReason(
      'no_authorized_driver',
      '已保存的自动唤醒无法继续驱动任务，需要恢复。',
    );
  }
  if (input.requiredWork.length > 0) return null;
  if (input.activeReplan) return null;
  if (input.raw.task.status === 'queued' || input.raw.task.status === 'running') return null;
  return createTaskReason(
    'no_authorized_driver',
    '没有已授权的必需工作，也没有明确的用户事项。',
  );
}

/** Bounded detail for a Task whose conclusion was just evaluated. */
export function describeTaskState(
  status: import('./task-state.js').TaskStatus,
  detail: TaskStateDetail,
): string {
  return `${status}:${detail.reason.code}`;
}
