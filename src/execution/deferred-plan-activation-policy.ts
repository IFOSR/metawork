/**
 * Deferred-plan activation policy (ADR-0055 §6).
 *
 * A replan proposal whose AgentClass was unavailable is parked as
 * `waiting_for_availability`. When the Executor recovers, the Task Runtime must
 * decide from durable facts whether the deferred proposal is now executable.
 * That decision is mechanical and belongs to the Task Runtime, not to the
 * Kernel; this module is pure and produces an activation result the Runtime
 * applies immediately (no event, ledger record or replay).
 */
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import type { WorkspaceDeliveryPolicy, WorkspaceExecutionMode } from '../core/workspace-execution.js';
import type { PlanAdmissionRequest } from './plan-admission-policy.js';
import type { ControlExecutorStatusProjection } from '../control/executor-status-projection.js';
import { unavailableAgentClasses } from '../control/plan-routing-eligibility.js';
import { resolveWorkspaceExecutionDecision } from '../control/workspace-execution-decision.js';
import { validateWorkGraph as validateWorkGraphStructure } from '../work-graph/index.js';
import { writesWorkspace } from '../work-graph/workspace-effect.js';
import type { WorkGraphProposal } from '../work-graph/types.js';
import type { TaskStatus } from '../task/task-state.js';

/** Durable replan facts; the persisted `generation_replan_requests.deferred_plan_json`. */
export interface DeferredPlanProposal {
  id: string;
  taskId: string;
  configurationRevision: string;
  requestText: string;
  generationId: string;
  targetGraphRevision: number;
  proposalSource: 'replan';
  proposal: PlanAdmissionRequest['proposal'];
  workspaceAdmission?: PlanAdmissionRequest['workspaceAdmission'];
}

/** Persist only activation facts; a Kernel event envelope is not a replan fact. */
export function deferredPlanProposal(request: PlanAdmissionRequest): DeferredPlanProposal {
  if (request.proposalSource !== 'replan' || !request.taskId
    || request.proposal.task.taskId !== request.taskId
    || !request.generationId || !Number.isSafeInteger(request.targetGraphRevision)
    || request.targetGraphRevision < 2 || !request.proposal.workGraph
    || request.proposal.workGraph.configurationRevision !== request.configurationRevision) {
    throw new Error('invalid deferred replan proposal');
  }
  return {
    id: request.id,
    taskId: request.taskId,
    configurationRevision: request.configurationRevision,
    requestText: request.requestText,
    generationId: request.generationId,
    targetGraphRevision: request.targetGraphRevision,
    proposalSource: 'replan',
    proposal: request.proposal,
    ...(request.workspaceAdmission ? { workspaceAdmission: request.workspaceAdmission } : {}),
  };
}

export interface DeferredPlanActivationSnapshot {
  task: {
    id: string;
    status: TaskStatus;
    workspaceId?: string;
    executionMode?: WorkspaceExecutionMode | 'in_place' | 'worktree';
    deliveryPolicy?: WorkspaceDeliveryPolicy;
  } | null;
  activeGenerationId: string | null;
  activeGraphRevision: number | null;
  deferredPlan: DeferredPlanProposal | null;
  deferredBindings: Readonly<Record<string, readonly AuthorizedExecutorBinding[]>>;
  executorStatuses: readonly ControlExecutorStatusProjection[];
}

export type DeferredPlanActivation =
  | { authorized: false; reason: string }
  | {
      authorized: true;
      reason: string;
      activation: {
        taskId: string;
        replanRequestId: string;
        workGraph: WorkGraphProposal;
        authorizedBindingsBySubtask: Record<string, AuthorizedExecutorBinding[]>;
        generationId: string;
        graphRevision: number;
        proposalSource: 'replan';
      };
    };

export function decideDeferredPlanActivation(input: {
  replanRequestId: string;
  observedAt: string;
  snapshot: DeferredPlanActivationSnapshot;
}): DeferredPlanActivation {
  const { snapshot } = input;
  const deferred = snapshot.deferredPlan;
  if (
    !snapshot.task
    || !['running', 'needs_action'].includes(snapshot.task.status)
    || !deferred
    || deferred.taskId !== snapshot.task.id
    || deferred.proposalSource !== 'replan'
    || deferred.targetGraphRevision !== (snapshot.activeGraphRevision ?? 0) + 1
    || deferred.generationId !== snapshot.activeGenerationId
    || !deferred.proposal.workGraph
  ) {
    return { authorized: false, reason: 'deferred availability proposal is missing, stale, or cancelled' };
  }
  const workGraph = deferred.proposal.workGraph;
  if (Object.keys(snapshot.deferredBindings).length !== workGraph.subtasks.length
    || workGraph.subtasks.some(subtask => !snapshot.deferredBindings[subtask.id]?.length)
    || Object.values(snapshot.deferredBindings).flat().some(binding => binding.configurationRevision !== deferred.configurationRevision)) {
    return { authorized: false, reason: 'deferred candidate scope or configuration is invalid' };
  }
  const unavailable = unavailableAgentClasses(snapshot.executorStatuses, input.observedAt);
  const bindingsBySubtask = Object.fromEntries(
    workGraph.subtasks.map(subtask => [
      subtask.id,
      [...(snapshot.deferredBindings[subtask.id] ?? [])]
        .filter(binding => !unavailable.has(binding.agentClassRef)),
    ]),
  );
  if (Object.values(bindingsBySubtask).some(bindings => bindings.length === 0)) {
    return { authorized: false, reason: 'recovered Executor does not make the deferred frontier executable' };
  }
  const violations = validateWorkGraphStructure(workGraph);
  if (violations.length > 0) {
    return { authorized: false, reason: 'deferred availability proposal no longer validates' };
  }
  const workspaceWrites = workGraph.subtasks.some(subtask => (
    writesWorkspace(subtask, workGraph.subtasks)
  ));
  const workspaceResolution = resolveWorkspaceExecutionDecision({
    intent: deferred.proposal.workspaceIntent ?? null,
    riskLevel: deferred.proposal.risk.level,
    writes: workspaceWrites,
    declaredOutputPaths: workGraph.subtasks.flatMap(subtask => subtask.fileOutputs ?? []),
    facts: {
      targetWorkspace: deferred.workspaceAdmission?.targetWorkspace ?? null,
      existingTaskBinding: snapshot.task.executionMode
        ? {
            workspaceId: snapshot.task.workspaceId ?? '',
            executionMode: snapshot.task.executionMode,
            deliveryPolicy: snapshot.task.deliveryPolicy ?? 'await_acceptance',
          }
        : null,
    },
  });
  if (workspaceResolution.status !== 'resolved') {
    return {
      authorized: false,
      reason: `deferred Workspace execution cannot be authorized: ${workspaceResolution.reason}`,
    };
  }
  return {
    authorized: true,
    reason: 'deferred availability proposal is executable again',
    activation: {
      taskId: snapshot.task.id,
      replanRequestId: input.replanRequestId,
      workGraph,
      authorizedBindingsBySubtask: bindingsBySubtask,
      generationId: deferred.generationId,
      graphRevision: deferred.targetGraphRevision,
      proposalSource: 'replan',
    },
  };
}
