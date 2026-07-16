import type { AgentClass, Task } from '../core/types.js';
import type { KernelExecutorStatusProjection } from './executor-status-projection.js';
import type { PlannerExecutorCatalog } from '../executor/builtin-executor-catalog.js';
import { validatePlanningAgentPlan } from '../planning/planning-agent-plan-validator.js';
import type { PlanningAgentPlan, PlanningAction, SubtaskProposal } from '../planning/planning-types.js';
import { generateInteractionId } from '../utils/id.js';

export type KernelOutcome = 'accept' | 'rewrite' | 'reject' | 'clarify';

export type KernelRuntimeAction =
  | 'direct_reply'
  | 'clarification'
  | 'task_control'
  | 'plan_work_graph'
  | 'no_action'
  | 'reject';

export interface RuntimeSnapshot {
  tasks: Task[];
  runningTask: Task | null;
  agentClasses: AgentClass[];
  executorCatalog?: PlannerExecutorCatalog;
  executorStatuses?: KernelExecutorStatusProjection[];
  currentFocus: {
    kind: 'conversation' | 'task';
    taskId: string | null;
  } | null;
}

export interface KernelDecision {
  id: string;
  outcome: KernelOutcome;
  runtimeAction: KernelRuntimeAction;
  reason: string;
  plan: PlanningAgentPlan;
  rejected: boolean;
}

const STATE_CHANGE_ACTIONS: PlanningAction[] = ['task_control', 'plan_work_graph'];

export class PolicyKernel {
  decide(plan: PlanningAgentPlan, snapshot: RuntimeSnapshot): KernelDecision {
    const validation = validatePlanningAgentPlan(plan);
    if (!validation.valid) {
      return this.reject(plan, `invalid PlanningAgentPlan: ${validation.errors.join('; ')}`);
    }

    if (isStateChangingPlan(plan) && plan.risk.requiresConfirmation) {
      return this.clarify(
        plan,
        `risk confirmation required: ${plan.risk.reasons.join('; ') || plan.risk.level}`,
        '该操作存在较高风险，请明确确认是否继续执行。',
      );
    }

    if (STATE_CHANGE_ACTIONS.includes(plan.action) && plan.confidence < 0.45) {
      return {
        id: `kd_${generateInteractionId()}`,
        outcome: 'clarify',
        runtimeAction: 'clarification',
        reason: `low confidence state-changing plan (${plan.confidence.toFixed(2)})`,
        plan: toClarificationPlan(
          plan,
          plan.clarificationQuestion
            ?? 'Please clarify whether you want to continue an existing task or start a new executable task.',
        ),
        rejected: false,
      };
    }

    if (plan.action === 'direct_reply') return this.authorizeDirectReply(plan);
    if (plan.action === 'clarification') {
      return {
        id: `kd_${generateInteractionId()}`,
        outcome: 'clarify',
        runtimeAction: 'clarification',
        reason: plan.reason,
        plan,
        rejected: false,
      };
    }
    if (plan.action === 'no_action') return this.accept(plan, 'no runtime action required');
    if (plan.action === 'task_control') return this.decideTaskControl(plan, snapshot);
    if (plan.action === 'plan_work_graph') return this.decideWorkGraph(plan, snapshot);

    return this.reject(plan, `unsupported PlanningAgent action: ${plan.action}`);
  }

  /**
   * Authorizes a direct_reply plan without a runtime-state round-trip. A
   * direct_reply is a read-only conversational answer the planner already
   * produced and validated; the kernel applies no state-changing authorization
   * to it (no single-active-task check, no executor rewrite, no risk/confidence
   * gate). Exposed so the session can short-circuit the full `decide` path for
   * reply turns while keeping KernelDecision construction owned by the kernel.
   * Callers MUST pass a planner-validated plan with `action === 'direct_reply'`.
   */
  authorizeDirectReply(plan: PlanningAgentPlan): KernelDecision {
    return this.accept(plan, 'direct reply authorized');
  }

  private decideTaskControl(plan: PlanningAgentPlan, snapshot: RuntimeSnapshot): KernelDecision {
    const targetTask = plan.task.taskId ? snapshot.tasks.find(task => task.id === plan.task.taskId) ?? null : null;
    if (plan.task.taskId && !targetTask) {
      return this.reject(plan, `task not found: ${plan.task.taskId}`);
    }

    // resume_task / recover_blocked require an explicit target the planner selected.
    // The runtime must not fall back to guessing which task to resume — if the
    // planner did not pin a taskId, force a clarification instead.
    if (
      (plan.task.control === 'resume_task' || plan.task.control === 'recover_blocked')
      && (plan.task.binding !== 'reference' || !plan.task.taskId)
    ) {
      return this.clarify(
        plan,
        'resume/recover_blocked requires an explicit taskId; planner did not select a target',
      );
    }

    if (
      snapshot.runningTask
      && !targetTask
      && plan.task.control !== 'status_query'
      && plan.task.control !== 'clear_tasks'
    ) {
      return this.reject(plan, `单活跃任务限制: 当前活跃顶层任务 #${snapshot.runningTask.id}`);
    }

    if (
      snapshot.runningTask
      && targetTask
      && targetTask.id !== snapshot.runningTask.id
      && plan.task.control !== 'status_query'
      && plan.task.control !== 'clear_tasks'
    ) {
      return this.reject(plan, `单活跃任务限制: 当前活跃顶层任务 #${snapshot.runningTask.id}`);
    }

    return this.accept(plan, 'task control authorized');
  }

  private decideWorkGraph(plan: PlanningAgentPlan, snapshot: RuntimeSnapshot): KernelDecision {
    const targetTask = plan.task.taskId ? snapshot.tasks.find(task => task.id === plan.task.taskId) ?? null : null;
    if (plan.task.taskId && !targetTask) {
      return this.reject(plan, `task not found: ${plan.task.taskId}`);
    }

    if (targetTask && ['done', 'archived', 'cancelled'].includes(targetTask.status)) {
      return this.reject(plan, `completed task ${targetTask.id} cannot be resumed without a follow-up plan`);
    }

    if (snapshot.runningTask && (!targetTask || targetTask.id !== snapshot.runningTask.id)) {
      return this.reject(plan, `单活跃任务限制: 当前活跃顶层任务 #${snapshot.runningTask.id}`);
    }

    const rewrite = this.rewriteUnknownExecutors(
      plan,
      snapshot.agentClasses,
      snapshot.executorStatuses ?? [],
    );
    if (!rewrite.plan.workGraph?.subtasks.every(subtask => subtask.candidateAgentClasses.length > 0)) {
      return this.reject(rewrite.plan, 'no available executor agent class can satisfy the work graph');
    }

    if (rewrite.rewritten) {
      return {
        id: `kd_${generateInteractionId()}`,
        outcome: 'rewrite',
        runtimeAction: 'plan_work_graph',
        reason: rewrite.reason,
        plan: rewrite.plan,
        rejected: false,
      };
    }

    return this.accept(plan, 'work graph authorized');
  }

  private rewriteUnknownExecutors(
    plan: PlanningAgentPlan,
    agentClasses: AgentClass[],
    statuses: KernelExecutorStatusProjection[],
  ): {
    plan: PlanningAgentPlan;
    rewritten: boolean;
    reason: string;
  } {
    const availableExecutorNames = new Set(agentClasses
      .filter(agentClass => agentClass.kind === 'executor')
      .map(agentClass => agentClass.name));
    const unavailableExecutorNames = new Set(statuses
      .filter(status => status.classHealth === 'disabled' || status.classHealth === 'error')
      .map(status => status.agentClassName));
    let rewritten = false;
    const subtasks = (plan.workGraph?.subtasks ?? []).map(subtask => {
      const filteredCandidates = subtask.candidateAgentClasses.filter(name =>
        availableExecutorNames.has(name)
        && !unavailableExecutorNames.has(name));
      const agentClassHint = subtask.agentClassHint && availableExecutorNames.has(subtask.agentClassHint)
        ? subtask.agentClassHint
        : filteredCandidates[0] ?? null;
      if (
        filteredCandidates.length !== subtask.candidateAgentClasses.length
        || agentClassHint !== subtask.agentClassHint
      ) {
        rewritten = true;
      }
      return {
        ...subtask,
        agentClassHint,
        candidateAgentClasses: filteredCandidates,
      } satisfies SubtaskProposal;
    });

    return {
      plan: {
        ...plan,
        execution: {
          ...plan.execution,
          selectedExecutor: plan.execution.selectedExecutor && availableExecutorNames.has(plan.execution.selectedExecutor)
            ? plan.execution.selectedExecutor
            : subtasks[0]?.candidateAgentClasses[0] ?? null,
          candidateExecutors: plan.execution.candidateExecutors.filter(name => availableExecutorNames.has(name)),
        },
        workGraph: plan.workGraph
          ? { ...plan.workGraph, subtasks }
          : null,
      },
      rewritten,
      reason: 'rewrote unknown executor candidates',
    };
  }

  private accept(plan: PlanningAgentPlan, reason: string): KernelDecision {
    return {
      id: `kd_${generateInteractionId()}`,
      outcome: 'accept',
      runtimeAction: actionToRuntimeAction(plan.action),
      reason,
      plan,
      rejected: false,
    };
  }

  private reject(plan: PlanningAgentPlan, reason: string): KernelDecision {
    return {
      id: `kd_${generateInteractionId()}`,
      outcome: 'reject',
      runtimeAction: 'reject',
      reason,
      plan,
      rejected: true,
    };
  }

  private clarify(plan: PlanningAgentPlan, reason: string, fallbackQuestion?: string): KernelDecision {
    return {
      id: `kd_${generateInteractionId()}`,
      outcome: 'clarify',
      runtimeAction: 'clarification',
      reason,
      plan: toClarificationPlan(
        plan,
        plan.clarificationQuestion
          ?? fallbackQuestion
          ?? 'Please clarify which existing task you want to resume or unblock.',
      ),
      rejected: false,
    };
  }
}

function actionToRuntimeAction(action: PlanningAction): KernelRuntimeAction {
  if (action === 'plan_work_graph') return 'plan_work_graph';
  return action;
}

function isStateChangingPlan(plan: PlanningAgentPlan): boolean {
  if (plan.action === 'plan_work_graph') return true;
  return plan.action === 'task_control' && plan.task.control !== 'status_query';
}

/**
 * Reshape a plan into a clarification: strip the work graph and neutralize
 * execution routing so the persisted decision cannot be mistaken for an
 * executable plan (only the clarification-relevant fields remain meaningful).
 */
function toClarificationPlan(plan: PlanningAgentPlan, clarificationQuestion: string): PlanningAgentPlan {
  return {
    ...plan,
    action: 'clarification',
    clarificationQuestion,
    task: {
      ...plan.task,
      priority: null,
    },
    workGraph: null,
    execution: {
      ...plan.execution,
      mode: 'none',
      selectedExecutor: null,
      candidateExecutors: [],
      requiresVerification: false,
      canModifyFiles: false,
      requiresExternalGateway: false,
      matchedBoundary: [],
    },
  };
}
