/** Pure Task Runtime plan admission. No event envelope, ledger identity or side effects. */
import type {
  ControlConfigurationView,
  PlannerConfigurationView,
} from '../configuration/index.js';
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import type {
  WorkspaceAdmission,
  WorkspaceDeliveryPolicy,
  WorkspaceExecutionDecision,
  WorkspaceExecutionMode,
  WorkspaceIntent,
} from '../core/workspace-execution.js';
import { validatePlanningAgentPlan } from '../planning/planning-agent-plan-validator.js';
import type { PlanningAgentPlan } from '../planning/planning-types.js';
import { isTerminalTaskStatus, type TaskStatus } from '../task/task-state.js';
import { contextRefKey, validateWorkGraph as validateWorkGraphStructure } from '../work-graph/index.js';
import type { WorkGraphProposal } from '../work-graph/types.js';
import { writesWorkspace } from '../work-graph/workspace-effect.js';
import type { ControlExecutorStatusProjection } from '../control/executor-status-projection.js';
import { unavailableAgentClasses } from '../control/plan-routing-eligibility.js';
import { resolveWorkspaceExecutionDecision } from '../control/workspace-execution-decision.js';
import { planSubtaskCandidateGroups } from '../routing/plan-routing-candidates.js';
import type { RoutingResolutionAudit } from '../routing/auto-model-resolver.js';
import { proposedTaskId } from './plan-proposal-store.js';
import { resolvePublicRoutingIdentity } from '../configuration/public-routing-identity.js';

export interface PlanAdmissionRequest {
  id: string;
  configurationRevision: string;
  occurredAt: string;
  sessionId: string;
  conversationId?: string;
  sourceTurnId?: string;
  queryId?: string;
  workspaceId?: string;
  taskId?: string;
  proposal: PlanningAgentPlan;
  requestText: string;
  generationId: string;
  proposalSource: 'initial' | 'replan' | 'conflict_replan';
  targetGraphRevision: number;
  attachmentIds?: string[];
  availabilityExplanation?: string | null;
  workspaceAdmission?: { targetWorkspace: { workspaceId: string; canonicalPath: string } | null };
}

export interface PlanAdmissionSnapshot {
  tasks: Array<{
    id: string;
    status: TaskStatus;
    conversationId?: string;
    workspaceId?: string;
    executionMode?: WorkspaceExecutionMode | 'in_place' | 'worktree';
    deliveryPolicy?: WorkspaceDeliveryPolicy;
  }>;
  activeTaskByConversation?: Record<string, string | null>;
  occupiedConversationIds?: string[];
  queuedTaskCountByConversation?: Record<string, number>;
  activeTaskCount?: number;
  runningTaskId: string | null;
  plannerConfiguration: PlannerConfigurationView;
  configuration: ControlConfigurationView;
  executorStatuses: ControlExecutorStatusProjection[];
  v5WorkGraphTaskIds: string[];
  eligibleContextRefKeys: string[];
  pendingAuthorizationRequest: { requestId: string; taskId: string } | null;
}

export type PlanAdmissionOutcome =
  | { status: 'rejected' }
  | { status: 'clarification'; question: string }
  | { status: 'no_action' }
  | { status: 'permission_resolution'; taskId: string; requestId: string; resolution: 'approve' | 'deny'; plannerPlanId: string }
  | { status: 'task_control'; task: PlanningAgentPlan['task'] }
  | {
      status: 'authorized';
      taskId: string;
      task: PlanningAgentPlan['task'];
      workGraph: WorkGraphProposal;
      scheduleState: 'eligible' | 'queued';
      schedulingReason?: 'conversation_slot_occupied' | 'account_task_capacity';
      owner: { conversationId: string; workspaceId: string | null; plannerSessionId: string };
      authorizedBindingsBySubtask: Record<string, AuthorizedExecutorBinding[]>;
      generationId: string;
      graphRevision: number;
      proposalSource: PlanAdmissionRequest['proposalSource'];
      routing: Record<string, RoutingResolutionAudit[]>;
      workspaceExecution: WorkspaceExecutionDecision;
      workspaceAdmission: Extract<WorkspaceAdmission, { kind: 'read' | 'write' }>;
      workspaceIntent: WorkspaceIntent | null;
      conflictResolution?: { oldTaskId: string };
    }
  | {
      status: 'deferred';
      taskId: string;
      proposal: PlanAdmissionRequest;
      authorizedBindingsBySubtask: Record<string, AuthorizedExecutorBinding[]>;
      unavailableAgentClassNames: string[];
      explanation: string;
      workspaceExecution: WorkspaceExecutionDecision;
      workspaceAdmission: Extract<WorkspaceAdmission, { kind: 'read' | 'write' }>;
    };
export type PlanAdmissionResult = PlanAdmissionOutcome & { reason: string };

const STATE_CHANGE_ACTIONS = new Set<PlanningAgentPlan['action']>(['task_control', 'plan_work_graph']);

function admission<T extends PlanAdmissionOutcome>(outcome: T, reason: string): T & { reason: string } {
  return { ...outcome, reason };
}

export function authorizePlanAdmission(
  request: PlanAdmissionRequest,
  snapshot: PlanAdmissionSnapshot,
): PlanAdmissionResult {
  const proposal = request.proposal;
  const validation = validatePlanningAgentPlan(
    proposal,
    snapshot.plannerConfiguration,
    snapshot.pendingAuthorizationRequest,
  );
  if (!validation.valid) return admission({ status: 'rejected' }, `invalid PlanningAgentPlan: ${validation.errors.join('; ')}`);
  if (isStateChanging(proposal) && proposal.risk.requiresConfirmation) {
    return admission({ status: 'clarification', question: proposal.clarificationQuestion ?? '该操作存在较高风险，请明确确认是否继续执行。' }, 'risk confirmation required');
  }
  if (STATE_CHANGE_ACTIONS.has(proposal.action) && proposal.confidence < 0.45) {
    return admission({ status: 'clarification', question: proposal.clarificationQuestion ?? 'Please clarify the requested task change.' }, 'low confidence state-changing plan');
  }
  if (proposal.action === 'clarification') {
    return admission({ status: 'clarification', question: proposal.clarificationQuestion ?? 'Please clarify your request.' }, proposal.reason);
  }
  if (proposal.action === 'no_action') return admission({ status: 'no_action' }, 'no runtime action required');
  if (proposal.action === 'authorization_resolution') {
    const resolution = proposal.authorizationResolution;
    if (!resolution || !snapshot.pendingAuthorizationRequest || resolution.requestId !== snapshot.pendingAuthorizationRequest.requestId) {
      return admission({ status: 'rejected' }, 'authorization resolution does not match the pending request');
    }
    return admission({
      status: 'permission_resolution',
      taskId: snapshot.pendingAuthorizationRequest.taskId,
      requestId: resolution.requestId,
      resolution: resolution.resolution,
      plannerPlanId: proposal.id,
    }, 'Planner interpretation of exact authorization response accepted');
  }
  if (proposal.task.taskId !== null && !snapshot.tasks.some(task => task.id === proposal.task.taskId)) {
    return admission({ status: 'rejected' }, `task not found: ${proposal.task.taskId}`);
  }
  if (proposal.action === 'task_control') {
    if (
      (proposal.task.control === 'resume_task'
        || proposal.task.control === 'recover_blocked'
        || proposal.task.control === 'abandon_task')
      && !proposal.task.taskId
    ) {
      return admission({ status: 'clarification', question: proposal.clarificationQuestion ?? 'Which task should be resumed?' }, 'resume requires an explicit task');
    }
    if (!['status_query', 'clear_tasks'].includes(proposal.task.control)) {
      const targetTask = proposal.task.taskId
        ? snapshot.tasks.find(task => task.id === proposal.task.taskId)
        : null;
      const conversationId = request.conversationId ?? request.sessionId;
      if (targetTask?.conversationId && targetTask.conversationId !== conversationId) {
        return admission({ status: 'rejected' }, 'task is owned by another Conversation');
      }
      // abandon_task resolves the same-topic conflict explicitly: it may
      // target any Task in this Conversation (the slot owner or a queued
      // Task), never a Task of another Conversation. Topic similarity alone
      // still authorizes nothing (§4.2 fail-closed rule).
      if (proposal.task.control !== 'abandon_task' && !proposal.task.control.startsWith('service_')) {
        const scopedActiveTaskId = snapshot.activeTaskByConversation?.[conversationId]
          ?? (snapshot.activeTaskByConversation ? null : snapshot.runningTaskId);
        if (scopedActiveTaskId && proposal.task.taskId !== scopedActiveTaskId) {
          return admission({ status: 'rejected' }, `Conversation execution slot is occupied by ${scopedActiveTaskId}`);
        }
      }
    }
    return admission({ status: 'task_control', task: proposal.task }, 'task control authorized');
  }
  if (!proposal.workGraph) return admission({ status: 'rejected' }, 'work graph is required');
  if (!request.generationId || !Number.isSafeInteger(request.targetGraphRevision) || request.targetGraphRevision < 1) {
    return admission({ status: 'rejected' }, 'invalid graph generation or revision');
  }
  if (request.proposalSource === 'initial' && request.targetGraphRevision !== 1) {
    return admission({ status: 'rejected' }, 'initial plan must authorize graph revision 1');
  }
  if (request.proposalSource !== 'initial' && (!proposal.task.taskId || request.targetGraphRevision < 2)) {
    return admission({ status: 'rejected' }, 'replan must target an existing Task and a later revision');
  }
  const conversationId = request.conversationId ?? request.sessionId;
  const activeTaskId = snapshot.activeTaskByConversation?.[conversationId]
    ?? (snapshot.activeTaskByConversation ? null : snapshot.runningTaskId);
  const accountCapacityReached = !activeTaskId
    && request.proposalSource === 'initial'
    && proposal.task.taskId === null
    && (snapshot.activeTaskCount ?? snapshot.occupiedConversationIds?.length ?? 0)
      >= (snapshot.configuration.runtimePolicy.maxConcurrentTasks ?? 2);
  const schedulingReason = activeTaskId
    ? 'conversation_slot_occupied' as const
    : accountCapacityReached
      ? 'account_task_capacity' as const
      : undefined;
  if ((activeTaskId || accountCapacityReached) && proposal.task.taskId !== activeTaskId) {
    // A new Task from the same Conversation is admitted durably but waits for
    // the slot. Other Conversations are not blocked by this fact.
    if (request.proposalSource === 'initial' && proposal.task.taskId === null) {
      const queueCount = snapshot.queuedTaskCountByConversation?.[conversationId] ?? 0;
      const limit = snapshot.configuration.runtimePolicy.sameConversationQueueLimit ?? 8;
      if (queueCount >= limit) {
        return admission({ status: 'rejected' }, `same-Conversation queue limit reached: ${limit}`);
      }
    } else if (request.proposalSource !== 'initial' || proposal.task.taskId !== null) {
      return admission({ status: 'rejected' }, `task ${proposal.task.taskId ?? ''} is not owned by the active Conversation slot`);
    }
  }
  if (request.proposalSource === 'initial' && proposal.task.taskId && snapshot.v5WorkGraphTaskIds.includes(proposal.task.taskId)) {
    return admission({ status: 'rejected' }, `task ${proposal.task.taskId} already has an active v5 work graph`);
  }
  const eligible = new Set(snapshot.eligibleContextRefKeys);
  const invalidRefs = proposal.workGraph.subtasks.flatMap(subtask => subtask.contextRefs
    .map(contextRefKey)
    .filter(key => !eligible.has(key)));
  if (invalidRefs.length > 0) {
    return admission({ status: 'rejected' }, `unqualified context refs: ${invalidRefs.join(', ')}`);
  }
  const resolved = resolvePlanAdmission(request, snapshot, proposal.workGraph);
  if (resolved.status !== 'resolved') return resolved;
  const { availableBindings, workspaceResolution } = resolved;
  const violations = validateWorkGraphStructure(proposal.workGraph);
  if (violations.length > 0) {
    return admission({ status: 'rejected' }, violations.map(item => `${item.code}: ${item.message}`).join('; '));
  }
  // §5.4: abandon-and-create names the exact old Task. Existence is
  // checked here; Conversation ownership is enforced by the Runtime
  // (snapshot task projections do not carry conversationId). Topic
  // similarity alone still authorizes nothing — the Planner must emit an
  // explicit conflictResolution with an exact oldTaskId.
  if (proposal.conflictResolution) {
    const oldTask = snapshot.tasks.find(task => task.id === proposal.conflictResolution!.oldTaskId);
    if (!oldTask) {
      return admission({ status: 'rejected' }, `conflictResolution targets an unknown Task: ${proposal.conflictResolution.oldTaskId}`);
    }
    if (isTerminalTaskStatus(oldTask.status)) {
      return admission({ status: 'rejected' }, `conflictResolution targets an already-terminal Task: ${oldTask.status}`);
    }
  }
  return admission({
    status: 'authorized',
    taskId: proposedTaskId(request),
    task: proposal.task,
    workGraph: proposal.workGraph,
    scheduleState: schedulingReason
      ? 'queued'
      : 'eligible',
    ...(schedulingReason ? { schedulingReason } : {}),
    owner: {
      conversationId,
      workspaceId: request.workspaceId ?? null,
      plannerSessionId: request.sessionId,
    },
    authorizedBindingsBySubtask: availableBindings,
    generationId: request.generationId,
    graphRevision: request.targetGraphRevision,
    proposalSource: request.proposalSource,
    routing: resolved.routing,
    workspaceExecution: workspaceResolution.decision,
    workspaceAdmission: workspaceResolution.admission,
    workspaceIntent: workspaceResolution.intent,
    ...(proposal.conflictResolution
      ? { conflictResolution: { oldTaskId: proposal.conflictResolution.oldTaskId } }
      : {}),
  }, 'work graph authorized');
}

/** Candidate qualification and Workspace resolution after proposal/context validation. */
function resolvePlanAdmission(
  request: PlanAdmissionRequest,
  snapshot: PlanAdmissionSnapshot,
  workGraph: WorkGraphProposal,
) {
  const proposal = request.proposal;
  const unavailable = unavailableAgentClasses(snapshot.executorStatuses, request.occurredAt);
  // One owner rule decides write access; admission and the Attempt launch must
  // never disagree about it (convergence review B-01).
  const workspaceWrites = workGraph.subtasks.some(subtask => (
    writesWorkspace(subtask, workGraph.subtasks)
  ));
  const workspaceResolution = resolveWorkspaceExecutionDecision({
    intent: proposal.workspaceIntent ?? null,
    riskLevel: proposal.risk.level,
    writes: workspaceWrites,
    declaredOutputPaths: workGraph.subtasks.flatMap(subtask => subtask.fileOutputs ?? []),
    facts: {
      targetWorkspace: request.workspaceAdmission?.targetWorkspace ?? null,
      existingTaskBinding: (() => {
        if (!proposal.task.taskId) return null;
        const existingTask = snapshot.tasks.find(task => task.id === proposal.task.taskId);
        if (!existingTask?.executionMode) return null;
        return {
          workspaceId: existingTask.workspaceId ?? '',
          executionMode: existingTask.executionMode,
          deliveryPolicy: existingTask.deliveryPolicy ?? 'await_acceptance',
        };
      })(),
    },
  });
  if (workspaceResolution.status === 'clarification') {
    // A clarification creates no Task, Attempt, Worktree or write lease.
    return admission({
      status: 'clarification',
      question: proposal.clarificationQuestion ?? workspaceResolution.question,
    }, workspaceResolution.reason);
  }
  if (workspaceResolution.status === 'rejected') {
    return admission({ status: 'rejected' }, workspaceResolution.reason);
  }
  const resolved = resolveAuthorizedBindings(workGraph, snapshot.configuration);
  if (!resolved.ok) {
    return admission({ status: 'rejected' }, resolved.errors.join('; '));
  }
  const availableBindings = Object.fromEntries(
    Object.entries(resolved.bindingsBySubtask).map(([subtaskId, bindings]) => [
      subtaskId,
      bindings.filter(binding => !unavailable.has(binding.agentClassRef)),
    ]),
  );
  if (Object.values(availableBindings).some(bindings => bindings.length === 0)) {
    if (request.proposalSource === 'replan' && proposal.task.taskId) {
      const unavailableAgentClassNames = [...new Set(
        Object.values(resolved.bindingsBySubtask)
          .flat()
          .filter(binding => unavailable.has(binding.agentClassRef))
          .map(binding => binding.agentClassRef),
      )];
      return admission({
        status: 'deferred',
        taskId: proposal.task.taskId,
        proposal: request,
        authorizedBindingsBySubtask: resolved.bindingsBySubtask,
        unavailableAgentClassNames,
        explanation: request.availabilityExplanation
          ?? 'The revised plan is waiting because every eligible Executor for at least one Subtask is unavailable.',
        workspaceExecution: workspaceResolution.decision,
        workspaceAdmission: workspaceResolution.admission,
      }, 'latest replan proposal deferred until Executor availability recovers');
    }
    return admission({ status: 'rejected' }, 'no healthy canonical AgentClass remains');
  }
  return { status: 'resolved' as const, availableBindings, routing: resolved.routing, workspaceResolution };
}

function isStateChanging(proposal: PlanningAgentPlan): boolean {
  return proposal.action === 'plan_work_graph' || (proposal.action === 'task_control' && proposal.task.control !== 'status_query');
}

/** Hard eligibility only. The Router owns the joint Agent/Provider/Model choice. */
function resolveAuthorizedBindings(
  workGraph: WorkGraphProposal,
  configuration: ControlConfigurationView,
): {
  ok: true;
  bindingsBySubtask: Record<string, AuthorizedExecutorBinding[]>;
  routing: Record<string, RoutingResolutionAudit[]>;
} | { ok: false; errors: string[] } {
  if (workGraph.configurationRevision !== configuration.revisionId) {
    return { ok: false, errors: ['work graph configurationRevision does not match pinned configuration'] };
  }
  const errors: string[] = [];
  const bindingsBySubtask: Record<string, AuthorizedExecutorBinding[]> = {};
  const routing: Record<string, RoutingResolutionAudit[]> = {};
  for (const subtask of workGraph.subtasks) {
    const bindings: AuthorizedExecutorBinding[] = [];
    const audits: RoutingResolutionAudit[] = [];
    for (const group of planSubtaskCandidateGroups({ configuration, subtask })) {
      for (const candidate of group.eligible) {
        const identity = {
          agentClassRef: group.agentClassRef,
          harnessRef: group.harnessRef,
          permissionProfileRef: group.permissionProfileRef,
          providerRef: candidate.providerRef,
          modelRef: candidate.modelRef,
          configurationRevision: configuration.revisionId,
        };
        const names = resolvePublicRoutingIdentity(configuration, identity);
        const binding: AuthorizedExecutorBinding = {
          ...identity,
          executorDisplayName: names.executorDisplayName,
          harnessDisplayName: names.harnessDisplayName,
          providerDisplayName: names.providerDisplayName,
          modelDisplayName: names.modelDisplayName,
        };
        bindings.push(binding);
        audits.push({
          agentClassRef: group.agentClassRef, binding,
          rejectedCandidates: [...group.rejected], scoreBreakdown: null,
          policyVersion: 'router-hard-eligibility-v1',
        });
      }
    }
    if (bindings.length === 0) errors.push(`subtask ${subtask.id} has no authorized executor binding`);
    bindingsBySubtask[subtask.id] = bindings;
    routing[subtask.id] = audits;
  }
  return errors.length ? { ok: false, errors } : { ok: true, bindingsBySubtask, routing };
}
