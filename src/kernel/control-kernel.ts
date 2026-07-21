import type { PlannerExecutorCatalog } from '../executor/builtin-executor-catalog.js';
import { validatePlanningAgentPlan } from '../planning/planning-agent-plan-validator.js';
import type { PlanningAgentPlan } from '../planning/planning-types.js';
import { validateWorkGraphStructure } from '../planning/work-graph-structure-rules.js';
import type { WorkGraphProposal } from '../work-graph/types.js';
import { contextRefKey } from '../work-graph/index.js';
import type { KernelExecutorStatusProjection } from './executor-status-projection.js';
import { deriveAgentAvailability } from './agent-availability.js';
import type { KernelFailure } from '../core/kernel-failure.js';

export type KernelTaskStatus = 'created' | 'ready' | 'running' | 'parked' | 'blocked' | 'done' | 'archived' | 'cancelled';
export type KernelSubtaskStatus = 'ready' | 'running' | 'awaiting_decision' | 'blocked' | 'done' | 'cancelled';
export type KernelAttemptKind = 'primary' | 'continuation' | 'fallback' | 'contract_correction';
export type KernelRecoveryMode = 'native_session' | 'recovery_packet' | 'fresh';
export type KernelRecoverySafety = 'read_only' | 'workspace_reconcilable' | 'external_non_idempotent';

export interface KernelEventEnvelope {
  schemaVersion: 2;
  id: string;
  correlationId: string;
  causationId: string | null;
  occurredAt: string;
  sessionId: string;
  taskId?: string;
  subtaskId?: string;
  attemptId?: string;
}

export interface KernelPlanProposal {
  id: string;
  schemaVersion: 5;
  action: 'direct_reply' | 'clarification' | 'task_control' | 'plan_work_graph' | 'no_action';
  confidence: number;
  reason: string;
  clarificationQuestion: string | null;
  response: { directReply: string | null };
  task: {
    binding: 'new' | 'reference' | 'none';
    taskId: string | null;
    control: 'clear_tasks' | 'status_query' | 'resume_task' | 'recover_blocked' | 'none';
    scope: string | null;
    title: string | null;
    goal: string | null;
    includeRecentConversationContext: boolean;
    priority: { level: 'normal' | 'high' | 'urgent'; reason: string } | null;
  };
  risk: { level: 'low' | 'medium' | 'high'; requiresConfirmation: boolean; reasons: string[] };
  workGraph: WorkGraphProposal | null;
  source: string;
}

export type KernelEvent =
  | (KernelEventEnvelope & {
      type: 'plan_proposed';
      proposal: KernelPlanProposal;
      requestText: string;
      generationId: string;
      proposalSource: 'initial' | 'replan';
      targetGraphRevision: number;
    })
  | (KernelEventEnvelope & { type: 'dispatch_requested'; reason: string })
  | (KernelEventEnvelope & {
      type: 'capacity_signal';
      agentClassName: string;
      available: boolean;
      cycleId: string;
      attemptKind: KernelAttemptKind;
    })
  | (KernelEventEnvelope & {
      type: 'execution_outcome';
      terminalKind: 'completed' | 'failed';
      agentClassName: string;
      attemptKind: KernelAttemptKind;
      sourceAttemptId: string | null;
      failure: KernelFailure | null;
    })
  | (KernelEventEnvelope & {
      type: 'handoff_contract_failed';
      workUnitId: string;
      agentClassName: string;
      contract: unknown;
      violations: Array<{ code: string; path: string; message: string }>;
      receiptCount: number;
      responseBytes: number;
    })
  | (KernelEventEnvelope & {
      type: 'timer_tick';
      wakeKind: 'capacity' | 'retry' | 'availability';
      sourceDecisionId: string;
      scheduledFor: string;
      retry: { agentClassName: string; sourceAttemptId: string } | null;
    })
  | (KernelEventEnvelope & {
      type: 'recovery_resolution_requested';
      recoveryItemId: string;
      resolution: 'assume_applied' | 'retry';
    });

export interface KernelTaskFact {
  id: string;
  status: KernelTaskStatus;
}

export interface KernelSubtaskFact {
  id: string;
  taskId: string;
  status: KernelSubtaskStatus;
  preferredAgentClassList: string[];
}

export interface KernelAttemptFact {
  attemptId: string;
  agentClassName: string;
  attemptKind: KernelAttemptKind;
  sourceAttemptId: string | null;
  terminalKind: 'completed' | 'failed';
  failure: KernelFailure | null;
  completedAt: string;
}

export type KernelSnapshot =
  | {
      schemaVersion: 2;
      type: 'plan_admission';
      tasks: KernelTaskFact[];
      runningTaskId: string | null;
      executorCatalog: PlannerExecutorCatalog;
      executorStatuses: KernelExecutorStatusProjection[];
      v5WorkGraphTaskIds: string[];
      eligibleContextRefKeys: string[];
    }
  | {
      schemaVersion: 2;
      type: 'dispatch';
      task: KernelTaskFact | null;
      runningTaskId: string | null;
      graphState: 'ready' | 'missing' | 'conflict';
      subtasks: KernelSubtaskFact[];
      readyFrontier: string[];
      attemptedAgentClasses: string[];
      executorStatuses: KernelExecutorStatusProjection[];
      correctionSupportedAgentClasses: string[];
      nativeContinuationAgentClasses: string[];
      attempts: KernelAttemptFact[];
      generationId: string;
      graphRevision: number;
      automaticReplansUsed: number;
      recoverySafety: KernelRecoverySafety;
      automaticRecoveryAllowed: boolean;
    }
  | {
      schemaVersion: 2;
      type: 'timer';
      task: KernelTaskFact | null;
      wakeAuthorized: boolean;
      capacityBlockedAt: string | null;
      recheckAfterMs: number;
      capacityAgentClasses: string[];
      nativeContinuationAgentClasses: string[];
      executorStatuses: KernelExecutorStatusProjection[];
    }
  | {
      schemaVersion: 2;
      type: 'recovery';
      task: KernelTaskFact | null;
      item: {
        id: string;
        kind: 'application' | 'effect';
        status: 'uncertain' | 'failed';
        retrySafe: boolean;
      } | null;
    }
  | {
      schemaVersion: 2;
      type: 'invalid';
      reason: string;
    };

export type KernelDecisionAction =
  | { type: 'reject_request' }
  | { type: 'request_clarification'; question: string }
  | { type: 'deliver_direct_reply'; response: string }
  | { type: 'no_op' }
  | {
      type: 'authorize_task_plan';
      taskId: string;
      task: KernelPlanProposal['task'];
      workGraph: WorkGraphProposal;
      generationId: string;
      graphRevision: number;
      proposalSource: 'initial' | 'replan';
    }
  | { type: 'authorize_task_control'; task: KernelPlanProposal['task'] }
  | {
      type: 'dispatch_attempt';
      taskId: string;
      subtaskId: string;
      agentClassName: string;
      attemptId: string;
      attemptKind: KernelAttemptKind;
      sourceAttemptId: string | null;
      recoveryMode: KernelRecoveryMode;
    }
  | { type: 'probe_capacity'; taskId: string; subtaskId: string; agentClassName: string }
  | { type: 'wait_for_capacity'; taskId: string; subtaskId: string }
  | {
      type: 'wait_for_retry';
      taskId: string;
      subtaskId: string;
      resumeAt: string;
      agentClassName: string;
      sourceAttemptId: string;
    }
  | { type: 'request_replan'; taskId: string; generationId: string; sourceRevision: number }
  | { type: 'resolve_recovery'; taskId: string; recoveryItemId: string; resolution: 'assume_applied' | 'retry' }
  | { type: 'block_work'; taskId: string; subtaskId: string | null }
  | { type: 'park_for_replan'; taskId: string }
  | { type: 'complete_task'; taskId: string };

export interface KernelDecision {
  schemaVersion: 2;
  id: string;
  eventId: string;
  action: KernelDecisionAction;
  reason: string;
}

const STATE_CHANGE_ACTIONS = new Set<KernelPlanProposal['action']>(['task_control', 'plan_work_graph']);
const MAX_CORRECTION_INPUT_BYTES = 128 * 1024;

/** Pure strategic interpreter for every Phase 3 control-plane event. */
export class ControlKernel {
  decide(event: KernelEvent, snapshot: KernelSnapshot): KernelDecision {
    if (!snapshotMatches(event, snapshot)) {
      return decision(event, { type: 'block_work', taskId: event.taskId ?? '', subtaskId: event.subtaskId ?? null }, 'event and snapshot do not match');
    }
    switch (event.type) {
      case 'plan_proposed':
        return this.decidePlan(event, snapshot as Extract<KernelSnapshot, { type: 'plan_admission' }>);
      case 'dispatch_requested':
        return this.decideDispatch(event, snapshot as Extract<KernelSnapshot, { type: 'dispatch' }>);
      case 'capacity_signal':
        return this.decideCapacity(event, snapshot as Extract<KernelSnapshot, { type: 'dispatch' }>);
      case 'execution_outcome':
        return this.decideOutcome(event, snapshot as Extract<KernelSnapshot, { type: 'dispatch' }>);
      case 'handoff_contract_failed':
        return this.decideContractFailure(event, snapshot as Extract<KernelSnapshot, { type: 'dispatch' }>);
      case 'timer_tick':
        return this.decideTimer(event, snapshot as Extract<KernelSnapshot, { type: 'timer' }>);
      case 'recovery_resolution_requested':
        return this.decideRecovery(event, snapshot as Extract<KernelSnapshot, { type: 'recovery' }>);
    }
  }

  private decidePlan(
    event: Extract<KernelEvent, { type: 'plan_proposed' }>,
    snapshot: Extract<KernelSnapshot, { type: 'plan_admission' }>,
  ): KernelDecision {
    const proposal = event.proposal;
    const validation = validatePlanningAgentPlan(proposal as PlanningAgentPlan, snapshot.executorCatalog);
    if (!validation.valid) return decision(event, { type: 'reject_request' }, `invalid PlanningAgentPlan: ${validation.errors.join('; ')}`);
    if (isStateChanging(proposal) && proposal.risk.requiresConfirmation) {
      return decision(event, { type: 'request_clarification', question: proposal.clarificationQuestion ?? '该操作存在较高风险，请明确确认是否继续执行。' }, 'risk confirmation required');
    }
    if (STATE_CHANGE_ACTIONS.has(proposal.action) && proposal.confidence < 0.45) {
      return decision(event, { type: 'request_clarification', question: proposal.clarificationQuestion ?? 'Please clarify the requested task change.' }, 'low confidence state-changing plan');
    }
    if (proposal.action === 'direct_reply') {
      return decision(event, { type: 'deliver_direct_reply', response: proposal.response.directReply ?? '' }, 'direct reply authorized');
    }
    if (proposal.action === 'clarification') {
      return decision(event, { type: 'request_clarification', question: proposal.clarificationQuestion ?? 'Please clarify your request.' }, proposal.reason);
    }
    if (proposal.action === 'no_action') return decision(event, { type: 'no_op' }, 'no runtime action required');
    if (proposal.task.taskId && !snapshot.tasks.some(task => task.id === proposal.task.taskId)) {
      return decision(event, { type: 'reject_request' }, `task not found: ${proposal.task.taskId}`);
    }
    if (proposal.action === 'task_control') {
      if ((proposal.task.control === 'resume_task' || proposal.task.control === 'recover_blocked') && !proposal.task.taskId) {
        return decision(event, { type: 'request_clarification', question: proposal.clarificationQuestion ?? 'Which task should be resumed?' }, 'resume requires an explicit task');
      }
      if (snapshot.runningTaskId && proposal.task.taskId !== snapshot.runningTaskId && !['status_query', 'clear_tasks'].includes(proposal.task.control)) {
        return decision(event, { type: 'reject_request' }, `single-active Task constraint: ${snapshot.runningTaskId}`);
      }
      return decision(event, { type: 'authorize_task_control', task: proposal.task }, 'task control authorized');
    }
    if (!proposal.workGraph) return decision(event, { type: 'reject_request' }, 'work graph is required');
    if (!event.generationId || !Number.isSafeInteger(event.targetGraphRevision) || event.targetGraphRevision < 1) {
      return decision(event, { type: 'reject_request' }, 'invalid graph generation or revision');
    }
    if (event.proposalSource === 'initial' && event.targetGraphRevision !== 1) {
      return decision(event, { type: 'reject_request' }, 'initial plan must authorize graph revision 1');
    }
    if (event.proposalSource === 'replan' && (!proposal.task.taskId || event.targetGraphRevision < 2)) {
      return decision(event, { type: 'reject_request' }, 'replan must target an existing Task and a later revision');
    }
    if (snapshot.runningTaskId && proposal.task.taskId !== snapshot.runningTaskId) {
      return decision(event, { type: 'reject_request' }, `single-active Task constraint: ${snapshot.runningTaskId}`);
    }
    if (event.proposalSource === 'initial' && proposal.task.taskId && snapshot.v5WorkGraphTaskIds.includes(proposal.task.taskId)) {
      return decision(event, { type: 'reject_request' }, `task ${proposal.task.taskId} already has an active v5 work graph`);
    }
    const eligible = new Set(snapshot.eligibleContextRefKeys);
    const invalidRefs = proposal.workGraph.subtasks.flatMap(subtask => subtask.contextRefs
      .map(contextRefKey)
      .filter(key => !eligible.has(key)));
    if (invalidRefs.length > 0) {
      return decision(event, { type: 'request_clarification', question: 'The proposed context references are not available for this task.' }, `unqualified context refs: ${invalidRefs.join(', ')}`);
    }
    const unavailable = unavailableAgentClasses(snapshot.executorStatuses, event.occurredAt);
    const workGraph = {
      ...proposal.workGraph,
      subtasks: proposal.workGraph.subtasks.map(subtask => ({
        ...subtask,
        preferredAgentClassList: subtask.preferredAgentClassList.filter(name => !unavailable.has(name)),
      })),
    } satisfies WorkGraphProposal;
    if (workGraph.subtasks.some(subtask => subtask.preferredAgentClassList.length === 0)) {
      return decision(event, { type: 'reject_request' }, 'no healthy canonical AgentClass remains');
    }
    const violations = validateWorkGraphStructure(workGraph);
    if (violations.length > 0) {
      return decision(event, { type: 'reject_request' }, violations.map(item => `${item.code}: ${item.message}`).join('; '));
    }
    return decision(event, {
      type: 'authorize_task_plan',
      taskId: proposal.task.taskId ?? deterministicTaskId(event.id),
      task: proposal.task,
      workGraph,
      generationId: event.generationId,
      graphRevision: event.targetGraphRevision,
      proposalSource: event.proposalSource,
    }, 'work graph authorized');
  }

  private decideDispatch(event: KernelEvent, snapshot: Extract<KernelSnapshot, { type: 'dispatch' }>): KernelDecision {
    if (!event.taskId || !snapshot.task || snapshot.task.id !== event.taskId) return decision(event, { type: 'block_work', taskId: event.taskId ?? '', subtaskId: event.subtaskId ?? null }, 'dispatch task is missing or stale');
    if (snapshot.graphState !== 'ready') {
      return decision(event, { type: 'park_for_replan', taskId: event.taskId }, `work graph is ${snapshot.graphState}; replanning is required`);
    }
    if (snapshot.runningTaskId && snapshot.runningTaskId !== event.taskId) {
      return decision(event, { type: 'block_work', taskId: event.taskId, subtaskId: event.subtaskId ?? null }, `single-active Task constraint: ${snapshot.runningTaskId}`);
    }
    const subtask = selectReadySubtask(snapshot);
    if (!subtask) {
      if (snapshot.subtasks.length > 0 && snapshot.subtasks.every(item => item.status === 'done')) {
        return decision(event, { type: 'complete_task', taskId: event.taskId }, 'all Subtasks completed');
      }
      return decision(event, { type: 'block_work', taskId: event.taskId, subtaskId: null }, 'no ready Subtask while work remains');
    }
    const agentClassName = nextUsableAgentClass(subtask, snapshot, event.occurredAt);
    if (!agentClassName) return decision(event, { type: 'wait_for_capacity', taskId: event.taskId, subtaskId: subtask.id }, 'all authorized AgentClasses are unavailable');
    return decision(event, {
      type: 'dispatch_attempt', taskId: event.taskId, subtaskId: subtask.id, agentClassName,
      attemptId: deterministicAttemptId(event.id, subtask.id, agentClassName, 'primary'), attemptKind: 'primary',
      sourceAttemptId: null, recoveryMode: 'fresh',
    }, 'dispatch authorized');
  }

  private decideCapacity(event: Extract<KernelEvent, { type: 'capacity_signal' }>, snapshot: Extract<KernelSnapshot, { type: 'dispatch' }>): KernelDecision {
    const subtask = snapshot.subtasks.find(item => item.id === event.subtaskId) ?? selectReadySubtask(snapshot);
    if (!event.taskId || !subtask) return decision(event, { type: 'block_work', taskId: event.taskId ?? '', subtaskId: event.subtaskId ?? null }, 'capacity signal has no ready work');
    if (event.attemptKind === 'contract_correction') {
      return event.available
        ? decision(event, {
            type: 'dispatch_attempt', taskId: event.taskId, subtaskId: subtask.id, agentClassName: event.agentClassName,
            attemptId: deterministicAttemptId(event.id, subtask.id, event.agentClassName, 'contract_correction'), attemptKind: 'contract_correction',
            sourceAttemptId: event.attemptId ?? null, recoveryMode: 'fresh',
          }, 'response-only correction capacity confirmed')
        : decision(event, { type: 'block_work', taskId: event.taskId, subtaskId: subtask.id }, 'response-only correction capacity unavailable');
    }
    if (event.available) {
      return decision(event, {
        type: 'dispatch_attempt', taskId: event.taskId, subtaskId: subtask.id, agentClassName: event.agentClassName,
        attemptId: deterministicAttemptId(event.id, subtask.id, event.agentClassName, 'primary'), attemptKind: 'primary',
        sourceAttemptId: null, recoveryMode: 'fresh',
      }, 'capacity confirmed');
    }
    const agentClassName = nextUsableAgentClass(subtask, {
      ...snapshot,
      attemptedAgentClasses: [...snapshot.attemptedAgentClasses, event.agentClassName],
    }, event.occurredAt);
    return agentClassName
      ? decision(event, { type: 'probe_capacity', taskId: event.taskId, subtaskId: subtask.id, agentClassName }, 'try next authorized AgentClass')
      : decision(event, { type: 'wait_for_capacity', taskId: event.taskId, subtaskId: subtask.id }, 'authorized AgentClass capacity exhausted');
  }

  private decideOutcome(event: Extract<KernelEvent, { type: 'execution_outcome' }>, snapshot: Extract<KernelSnapshot, { type: 'dispatch' }>): KernelDecision {
    if (!event.taskId) return decision(event, { type: 'block_work', taskId: '', subtaskId: event.subtaskId ?? null }, 'outcome has no Task');
    if (event.terminalKind === 'failed') {
      return this.decideFailure(event, snapshot);
    }
    const next = selectReadySubtask(snapshot);
    if (!next) {
      return snapshot.subtasks.every(item => item.status === 'done')
        ? decision(event, { type: 'complete_task', taskId: event.taskId }, 'all Subtasks completed')
        : decision(event, { type: 'block_work', taskId: event.taskId, subtaskId: null }, 'unfinished graph has no ready frontier');
    }
    const agentClassName = nextUsableAgentClass(next, snapshot, event.occurredAt);
    if (!agentClassName) return decision(event, { type: 'wait_for_capacity', taskId: event.taskId, subtaskId: next.id }, 'next Subtask has no available authorized AgentClass');
    return decision(event, {
      type: 'dispatch_attempt', taskId: event.taskId, subtaskId: next.id, agentClassName,
      attemptId: deterministicAttemptId(event.id, next.id, agentClassName, 'primary'), attemptKind: 'primary',
      sourceAttemptId: null, recoveryMode: 'fresh',
    }, 'continue ready frontier');
  }

  private decideFailure(
    event: Extract<KernelEvent, { type: 'execution_outcome' }>,
    snapshot: Extract<KernelSnapshot, { type: 'dispatch' }>,
  ): KernelDecision {
    const taskId = event.taskId!;
    const subtask = snapshot.subtasks.find(item => item.id === event.subtaskId);
    const failure = event.failure;
    if (!subtask || !event.attemptId || !failure) {
      return decision(event, { type: 'block_work', taskId, subtaskId: event.subtaskId ?? null }, 'failure facts are incomplete');
    }
    if (event.attemptKind === 'contract_correction') {
      return decision(event, { type: 'block_work', taskId, subtaskId: subtask.id }, 'response-only correction failed and cannot enter ordinary recovery');
    }
    if (failure.code === 'startup_orphaned_work') {
      return decision(event, { type: 'block_work', taskId, subtaskId: subtask.id }, 'startup orphaned work requires explicit recovery');
    }
    if (failure.kind === 'cancelled' && snapshot.task?.status === 'cancelled') {
      return decision(event, { type: 'no_op' }, 'cancelled Task requires no recovery');
    }
    if (!snapshot.automaticRecoveryAllowed || snapshot.recoverySafety === 'external_non_idempotent') {
      return decision(event, { type: 'block_work', taskId, subtaskId: subtask.id }, 'automatic recovery cannot prove external effect safety');
    }
    if (failure.kind === 'permission' || failure.kind === 'unknown' || failure.kind === 'stale' || failure.kind === 'cancelled') {
      return decision(event, { type: 'block_work', taskId, subtaskId: subtask.id }, `${failure.kind} requires explicit recovery`);
    }
    const retryable = ['network', 'timeout', 'infrastructure', 'heartbeat_lost'].includes(failure.kind);
    const isPreferred = subtask.preferredAgentClassList[0] === event.agentClassName;
    const classAttempts = snapshot.attempts.filter(attempt =>
      attempt.agentClassName === event.agentClassName && attempt.attemptKind !== 'contract_correction'
    ).length;
    if (retryable && isPreferred && classAttempts <= 1) {
      const delayMs = failure.kind === 'network' ? 5_000 : 30_000;
      return decision(event, {
        type: 'wait_for_retry',
        taskId,
        subtaskId: subtask.id,
        resumeAt: addMilliseconds(event.occurredAt, delayMs),
        agentClassName: event.agentClassName,
        sourceAttemptId: event.attemptId,
      }, `preferred AgentClass continuation delayed after ${failure.kind}`);
    }
    if (!retryable && ![
      'authentication', 'configuration', 'adapter', 'capability_mismatch', 'task_failed', 'quality_failed',
    ].includes(failure.kind)) {
      return decision(event, { type: 'block_work', taskId, subtaskId: subtask.id }, `${failure.kind} has no safe recovery policy`);
    }
    return this.fallbackOrReplan(event, snapshot, subtask);
  }

  private fallbackOrReplan(
    event: Extract<KernelEvent, { type: 'execution_outcome' }>,
    snapshot: Extract<KernelSnapshot, { type: 'dispatch' }>,
    subtask: KernelSubtaskFact,
  ): KernelDecision {
    const attempted = new Set(snapshot.attempts
      .filter(attempt => attempt.attemptKind !== 'contract_correction')
      .map(attempt => attempt.agentClassName));
    const agentClassName = nextUsableAgentClass(subtask, {
      ...snapshot,
      attemptedAgentClasses: [...new Set([...snapshot.attemptedAgentClasses, ...attempted])],
    }, event.occurredAt);
    if (agentClassName) {
      return decision(event, {
        type: 'dispatch_attempt',
        taskId: event.taskId!,
        subtaskId: subtask.id,
        agentClassName,
        attemptId: deterministicAttemptId(event.id, subtask.id, agentClassName, 'fallback'),
        attemptKind: 'fallback',
        sourceAttemptId: event.attemptId!,
        recoveryMode: 'recovery_packet',
      }, 'next authorized fallback AgentClass selected');
    }
    return snapshot.automaticReplansUsed < 1
      ? decision(event, {
          type: 'request_replan',
          taskId: event.taskId!,
          generationId: snapshot.generationId,
          sourceRevision: snapshot.graphRevision,
        }, 'authorized candidates exhausted; one automatic replan is allowed')
      : decision(event, { type: 'park_for_replan', taskId: event.taskId! }, 'automatic replan budget exhausted');
  }

  private decideContractFailure(event: Extract<KernelEvent, { type: 'handoff_contract_failed' }>, snapshot: Extract<KernelSnapshot, { type: 'dispatch' }>): KernelDecision {
    if (!event.taskId || !event.subtaskId) return decision(event, { type: 'block_work', taskId: event.taskId ?? '', subtaskId: event.subtaskId ?? null }, 'contract failure identity is incomplete');
    if (event.receiptCount !== 1 || event.responseBytes > MAX_CORRECTION_INPUT_BYTES || !snapshot.correctionSupportedAgentClasses.includes(event.agentClassName)) {
      return decision(event, { type: 'block_work', taskId: event.taskId, subtaskId: event.subtaskId }, 'response-only correction is unavailable or already exhausted');
    }
    return decision(event, {
      type: 'dispatch_attempt', taskId: event.taskId, subtaskId: event.subtaskId, agentClassName: event.agentClassName,
      attemptId: deterministicAttemptId(event.id, event.subtaskId, event.agentClassName, 'contract_correction'),
      attemptKind: 'contract_correction',
      sourceAttemptId: event.attemptId ?? null,
      recoveryMode: 'fresh',
    }, 'one response-only contract correction authorized');
  }

  private decideTimer(event: Extract<KernelEvent, { type: 'timer_tick' }>, snapshot: Extract<KernelSnapshot, { type: 'timer' }>): KernelDecision {
    if (
      !event.taskId
      || !snapshot.task
      || snapshot.task.id !== event.taskId
      || snapshot.task.status !== 'blocked'
      || !snapshot.wakeAuthorized
    ) {
      return decision(event, { type: 'no_op' }, 'timer wake is stale or no longer authorized by Task state');
    }
    if (event.wakeKind === 'retry') {
      if (!event.taskId || !event.subtaskId || !event.retry || Date.parse(event.occurredAt) < Date.parse(event.scheduledFor)) {
        return decision(event, { type: 'no_op' }, 'retry wake is incomplete or early');
      }
      return decision(event, {
        type: 'dispatch_attempt',
        taskId: event.taskId,
        subtaskId: event.subtaskId,
        agentClassName: event.retry.agentClassName,
        attemptId: deterministicAttemptId(event.id, event.subtaskId, event.retry.agentClassName, 'continuation'),
        attemptKind: 'continuation',
        sourceAttemptId: event.retry.sourceAttemptId,
        recoveryMode: snapshot.nativeContinuationAgentClasses.includes(event.retry.agentClassName)
          ? 'native_session'
          : 'recovery_packet',
      }, 'preferred AgentClass continuation wake authorized');
    }
    if (event.wakeKind !== 'capacity') return decision(event, { type: 'no_op' }, 'availability wake has no eligible work');
    if (!event.taskId || !event.subtaskId || !snapshot.capacityBlockedAt) return decision(event, { type: 'no_op' }, 'no capacity block is eligible');
    const elapsed = Date.parse(event.occurredAt) - Date.parse(snapshot.capacityBlockedAt);
    if (!Number.isFinite(elapsed) || elapsed < snapshot.recheckAfterMs) return decision(event, { type: 'no_op' }, 'capacity recheck interval has not elapsed');
    const unavailable = unavailableAgentClasses(snapshot.executorStatuses, event.occurredAt);
    const candidate = snapshot.capacityAgentClasses.find(name => !unavailable.has(name));
    return candidate
      ? decision(event, { type: 'probe_capacity', taskId: event.taskId, subtaskId: event.subtaskId, agentClassName: candidate }, 'capacity timer recheck authorized')
      : decision(event, { type: 'no_op' }, 'no healthy AgentClass is eligible for capacity probe');
  }

  private decideRecovery(
    event: Extract<KernelEvent, { type: 'recovery_resolution_requested' }>,
    snapshot: Extract<KernelSnapshot, { type: 'recovery' }>,
  ): KernelDecision {
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
}

function decision(event: KernelEvent, action: KernelDecisionAction, reason: string): KernelDecision {
  return { schemaVersion: 2, id: `decision_${event.id}`, eventId: event.id, action, reason };
}

function snapshotMatches(event: KernelEvent, snapshot: KernelSnapshot): boolean {
  if (event.type === 'plan_proposed') return snapshot.type === 'plan_admission';
  if (event.type === 'timer_tick') return snapshot.type === 'timer';
  if (event.type === 'recovery_resolution_requested') return snapshot.type === 'recovery';
  return snapshot.type === 'dispatch';
}

function isStateChanging(proposal: KernelPlanProposal): boolean {
  return proposal.action === 'plan_work_graph' || (proposal.action === 'task_control' && proposal.task.control !== 'status_query');
}

function unavailableAgentClasses(statuses: KernelExecutorStatusProjection[], occurredAt: string): Set<string> {
  return new Set(statuses
    .filter(status => ['permanently_unavailable', 'temporarily_unavailable'].includes(
      deriveAgentAvailability(status, occurredAt),
    ))
    .map(status => status.agentClassName));
}

function selectReadySubtask(snapshot: Extract<KernelSnapshot, { type: 'dispatch' }>): KernelSubtaskFact | null {
  for (const id of snapshot.readyFrontier) {
    const subtask = snapshot.subtasks.find(item => item.id === id && item.status === 'ready');
    if (subtask) return subtask;
  }
  return null;
}

function nextUsableAgentClass(
  subtask: KernelSubtaskFact,
  snapshot: Extract<KernelSnapshot, { type: 'dispatch' }>,
  occurredAt: string,
): string | null {
  const attempted = new Set(snapshot.attemptedAgentClasses);
  const unavailable = unavailableAgentClasses(snapshot.executorStatuses, occurredAt);
  return subtask.preferredAgentClassList.find(name => !attempted.has(name) && !unavailable.has(name)) ?? null;
}

function deterministicAttemptId(eventId: string, subtaskId: string, agentClassName: string, kind: string): string {
  return `attempt_${[eventId, subtaskId, agentClassName, kind].map(value => value.replace(/[^a-zA-Z0-9_-]/g, '_')).join('_')}`;
}

function deterministicTaskId(eventId: string): string {
  return `task_${eventId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function addMilliseconds(value: string, milliseconds: number): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp + milliseconds).toISOString()
    : value;
}
