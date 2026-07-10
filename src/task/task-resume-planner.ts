import type { PlanningAgentPlan } from '../planning/planning-types.js';
import type { Task } from '../core/types.js';
import { extractInlineResourceMatches } from '../session/session-helpers.js';
import type { TaskRuntimeService } from './task-runtime-service.js';
import type { TaskExecutionPlan } from './task-execution-planner.js';

export type ResumePlanResult =
  | { action: 'not_handled' }
  | { action: 'message'; lines: string[] }
  | {
      action: 'execute_existing';
      task: Task;
      plan: Extract<TaskExecutionPlan, { mode: 'reuse-existing' }>;
      lines: string[];
      schedulingReason: string;
      executionMode: 'fresh' | 'resume-parked';
    }
  | {
      action: 'unblock_and_execute';
      task: Task;
      blockedReason: string | null;
      lines: string[];
      schedulingReason: string;
      triggerReason: string;
      newlyProvidedResources?: string[];
      triggerKind?: 'explicit-task-command' | 'natural-language-resume' | 'user-query-unblocked';
    }
  | {
      action: 'fork_follow_up';
      sourceTask: Task;
      plan: Extract<TaskExecutionPlan, { mode: 'fork-follow-up' }>;
      lines: string[];
      schedulingReason: string;
    };

/** Applies a PlanningAgent decision to one already-selected task without doing semantic matching. */
export class TaskResumePlanner {
  constructor(
    private readonly deps: {
      taskRuntimeService: TaskRuntimeService;
      cwd?: string;
    },
  ) {}

  planReferencedTask(input: {
    userInput: string;
    referencedTask: Task;
    plan: PlanningAgentPlan;
  }): ResumePlanResult {
    const { userInput, referencedTask, plan } = input;
    const requestedResume = plan.task.binding === 'reference'
      && plan.task.taskId === referencedTask.id
      && (plan.task.control === 'resume_task' || plan.task.control === 'recover_blocked');
    const executionPlan = this.deps.taskRuntimeService.buildExecutionPlan(referencedTask, userInput);

    if (executionPlan.mode === 'blocked') {
      return this.planBlockedRecovery(referencedTask, userInput, executionPlan, plan, requestedResume);
    }
    if (executionPlan.mode === 'fork-follow-up') {
      return {
        action: 'fork_follow_up',
        sourceTask: referencedTask,
        plan: executionPlan,
        lines: [`→ Referenced completed task #${referencedTask.id}`, '→ Creating a follow-up task'],
        schedulingReason: plan.task.priority?.reason ?? 'PlanningAgent created follow-up task',
      };
    }
    if (referencedTask.status === 'running' && requestedResume) {
      return { action: 'message', lines: [`→ 任务 #${executionPlan.executionTaskId} 已在执行中，无需再次排队`] };
    }
    return {
      action: 'execute_existing',
      task: referencedTask,
      plan: executionPlan,
      lines: [referencedTask.status === 'parked'
        ? `→ Resuming parked task #${executionPlan.executionTaskId}`
        : `→ Referenced task #${executionPlan.executionTaskId}`],
      schedulingReason: plan.task.priority?.reason ?? 'PlanningAgent selected task',
      executionMode: referencedTask.status === 'parked' ? 'resume-parked' : 'fresh',
    };
  }

  private planBlockedRecovery(
    task: Task,
    userInput: string,
    executionPlan: Extract<TaskExecutionPlan, { mode: 'blocked' }>,
    plan: PlanningAgentPlan,
    requestedResume: boolean,
  ): ResumePlanResult {
    const blockedReason = task.dependencies.find(dependency => dependency.status === 'waiting')?.description ?? null;
    if (!requestedResume || !blockedReason) {
      return { action: 'message', lines: [`错误：${executionPlan.error}`] };
    }
    const resources = extractInlineResourceMatches(userInput, this.deps.cwd ?? process.cwd())
      .map(match => match.resolvedPath);
    return {
      action: 'unblock_and_execute',
      task,
      blockedReason,
      newlyProvidedResources: resources,
      lines: [
        `→ 任务 #${task.id} 已解除阻塞`,
        resources.length > 0
          ? `→ Attached ${resources.length} explicit resource(s)`
          : `→ Planner authorized recovery of task #${task.id}`,
      ],
      schedulingReason: plan.task.priority?.reason ?? 'PlanningAgent recovered blocked task',
      triggerReason: plan.reason,
      triggerKind: 'natural-language-resume',
    };
  }
}
