import type { PlanningAgentPlan } from '../planning/planning-types.js';
import type { TaskRuntimeService } from './task-runtime-service.js';
import type { Task } from '../core/types.js';
import { evaluateBlockedTask } from './blocked-task-reconciler.js';
import { isResumeReferenceInstruction } from '../session/session-helpers.js';
import type { TaskExecutionPlan } from './task-execution-planner.js';

export type ResumePlanResult =
  | { action: 'not_handled' }
  | { action: 'message'; lines: string[] }
  | {
      action: 'execute_existing';
      task: Task;
      plan: Extract<TaskExecutionPlan, { mode: 'reuse-existing' }>;
      lines: string[];
      observeResumeIntent?: boolean;
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
      observeResumeIntent?: boolean;
    }
  | {
      action: 'fork_follow_up';
      sourceTask: Task;
      plan: Extract<TaskExecutionPlan, { mode: 'fork-follow-up' }>;
      lines: string[];
      schedulingReason: string;
    };

/**
 * Resumes/references a task the PlanningAgent already pinned by taskId.
 *
 * Boundary: this planner does NOT decide WHICH task to resume — that is the
 * PlanningAgent's job. It only executes the deterministic recovery for a known
 * referencedTask based on its status (blocked -> unblock, parked -> resume,
 * running -> no-op, done -> fork follow-up). No natural-language target
 * selection, no session-state pointer guessing, no candidate-list matching.
 */
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
    const { userInput, referencedTask, plan: agentPlan } = input;
    const explicitlyRequestedResume = agentPlan.task.binding === 'reference'
      && agentPlan.task.taskId === referencedTask.id
      && (agentPlan.task.control === 'resume_task' || agentPlan.task.control === 'recover_blocked');

    const executionPlan = this.deps.taskRuntimeService.buildExecutionPlan(referencedTask, userInput);
    if (executionPlan.mode === 'blocked') {
      return this.planBlockedRecovery(referencedTask, userInput, executionPlan, explicitlyRequestedResume);
    }

    if (executionPlan.mode === 'fork-follow-up') {
      return {
        action: 'fork_follow_up',
        sourceTask: referencedTask,
        plan: executionPlan,
        lines: [
          `→ 关联到任务 #${referencedTask.id}`,
          '→ 已完成任务不可直接重跑',
        ],
        schedulingReason: '跟进任务恢复',
      };
    }

    if (referencedTask.status === 'running' && isResumeReferenceInstruction(userInput)) {
      return {
        action: 'message',
        lines: [`→ 任务 #${executionPlan.executionTaskId} 已在执行中，无需再次排队`],
      };
    }

    return {
      action: 'execute_existing',
      task: referencedTask,
      plan: executionPlan,
      lines: [referencedTask.status === 'parked'
        ? `→ 命中已有挂起任务 #${executionPlan.executionTaskId}`
        : `→ 关联到任务 #${executionPlan.executionTaskId}`],
      observeResumeIntent: referencedTask.status === 'parked',
      schedulingReason: referencedTask.status === 'parked' ? '恢复已挂起任务' : '用户提交',
      executionMode: referencedTask.status === 'parked' ? 'resume-parked' : 'fresh',
    };
  }

  /**
   * Recover a known blocked task the planner explicitly asked to resume.
   * Extracts any inline materials the user provided (evaluateBlockedTask) but
   * never picks a different task. If the block can't be resolved from input,
   * surface the block reason as a message instead of silently unblocking.
   */
  private planBlockedRecovery(
    referencedTask: Task,
    userInput: string,
    executionPlan: Extract<TaskExecutionPlan, { mode: 'blocked' }>,
    explicitlyRequestedResume: boolean,
  ): ResumePlanResult {
    const blockedReason = this.getWaitingBlockReason(referencedTask);
    if (!explicitlyRequestedResume) {
      return { action: 'message', lines: [`错误：${executionPlan.error}`] };
    }

    if (!blockedReason) {
      // The task is 'blocked' but carries no waiting dependency to clear, so
      // there is nothing a resume can resolve (e.g. it was blocked for a
      // non-dependency reason, or its deps were already marked resolved).
      // Surface the block error instead of silently force-unblocking it.
      return { action: 'message', lines: [`错误：${executionPlan.error}`] };
    }

    const recovery = evaluateBlockedTask(referencedTask, userInput, this.deps.cwd ?? process.cwd());
    if (!recovery) {
      // No recoverable signal in input: unblock directly per the planner's
      // explicit request (e.g. "网络恢复了，继续这个任务").
      return {
        action: 'unblock_and_execute',
        task: referencedTask,
        blockedReason,
        lines: [
          `→ 关联到任务 #${referencedTask.id}`,
          `→ 任务 #${referencedTask.id} 已解除阻塞，继续执行`,
        ],
        schedulingReason: '用户显式请求恢复阻塞任务',
        triggerReason: '用户显式引用旧阻塞任务并说明可继续',
        triggerKind: 'explicit-task-command',
        observeResumeIntent: true,
      };
    }

    return {
      action: 'unblock_and_execute',
      task: referencedTask,
      blockedReason,
      newlyProvidedResources: recovery.newlyProvidedResources,
      lines: [
        `→ 关联到任务 #${referencedTask.id}`,
        `→ 原因：${recovery.reason}`,
        recovery.newlyProvidedResources.length > 0
          ? `→ 已自动关联 ${recovery.newlyProvidedResources.length} 份补充材料`
          : `→ 任务 #${referencedTask.id} 已解除阻塞，继续执行`,
      ],
      schedulingReason: `阻塞条件已满足：${recovery.reason}`,
      triggerReason: recovery.reason,
      triggerKind: 'user-query-unblocked',
      observeResumeIntent: true,
    };
  }

  private getWaitingBlockReason(task: Task): string | null {
    return task.dependencies.find(dependency => dependency.status === 'waiting')?.description ?? null;
  }
}
