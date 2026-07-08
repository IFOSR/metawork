// Applies PolicyKernel decisions to the live session by recording planning
// outcomes and translating accepted plans into task control or execution work.
import type { OrchestrationEngine } from '../guidance/orchestration.js';
import type { TaskSummary } from '../core/llm-bridge.js';
import type { MemoryContextService } from '../memory/memory-context-service.js';
import type { TaskResumePlanner, ResumePlanResult } from '../task/task-resume-planner.js';
import type { TaskRuntimeService } from '../task/task-runtime-service.js';
import type { TaskSemanticService } from '../task/task-semantic-service.js';
import type { Task, TaskRecoveryTrigger } from '../core/types.js';
import { filterDurableTasks, type TaskClearScope, type TaskStatusQueryScope } from '../core/task-routing.js';
import type { ExecutorAdapter } from '../executor/adapter.js';
import type { KernelDecision } from '../kernel/policy-kernel.js';
import type { PlanningAgentPlan } from '../planning/planning-types.js';
import { buildSchedulingReason, parsePriorityHint, type QueuedExecutionRequest } from './session-helpers.js';
import type { SessionPresentationService } from './session-presentation-service.js';
import type { PlanningDecisionRepo } from '../storage/planning-decision-repo.js';

interface FocusContext {
  kind: 'conversation' | 'task';
  taskId: string | null;
}

export interface KernelDecisionApplierCallbacks {
  appendOutput(...lines: string[]): void;
  appendPlanningClarification(userInput: string, plan: PlanningAgentPlan, decision: KernelDecision): void;
  runConversationInput(userInput: string): Promise<void>;
  prepareTaskExecution(taskId: string, request: QueuedExecutionRequest): Promise<void>;
  refreshRuntimeState(): void;
  setCurrentTaskId(taskId: string | null): void;
  getCurrentTaskId(): string | null;
  setFocusContext(focus: FocusContext | null): void;
  buildRecentTaskSummaries(tasks: Task[]): TaskSummary[];
  buildRecoveryTrigger(
    task: Task,
    input: {
      kind: TaskRecoveryTrigger['kind'];
      triggerReason: string;
      sourceInput?: string;
      blockedReason?: string;
      newlyProvidedResources?: string[];
    },
  ): TaskRecoveryTrigger;
}

export interface KernelDecisionApplierDeps {
  sessionId: string;
  planningDecisionRepo: PlanningDecisionRepo;
  taskRuntimeService: TaskRuntimeService;
  taskSemanticService: TaskSemanticService;
  taskResumePlanner: TaskResumePlanner;
  memoryContextService: MemoryContextService;
  orchestration: OrchestrationEngine;
  executor: ExecutorAdapter;
  presentation: SessionPresentationService;
  callbacks: KernelDecisionApplierCallbacks;
}

/** Turns kernel runtime actions into concrete session state changes and execution requests. */
export class KernelDecisionApplier {
  constructor(private readonly deps: KernelDecisionApplierDeps) {}

  async apply(input: {
    userInput: string;
    plan: PlanningAgentPlan;
    decision: KernelDecision;
  }): Promise<boolean> {
    const { userInput, plan, decision } = input;
    this.recordPlanningDecision(userInput, plan, decision);
    this.deps.callbacks.appendOutput(...this.formatKernelProgress(decision));

    if (decision.runtimeAction === 'reject') {
      this.deps.callbacks.appendOutput(`PolicyKernel rejected request: ${decision.reason}`);
      this.deps.callbacks.refreshRuntimeState();
      return true;
    }

    if (decision.runtimeAction === 'clarification') {
      this.deps.callbacks.appendPlanningClarification(userInput, decision.plan, decision);
      return true;
    }

    if (decision.runtimeAction === 'direct_reply') {
      await this.deps.callbacks.runConversationInput(userInput);
      return true;
    }

    if (decision.runtimeAction === 'task_control') {
      return this.applyTaskControlDecision(userInput, decision.plan, decision.id);
    }

    if (decision.runtimeAction === 'plan_work_graph') {
      if (decision.plan.task.binding === 'reference' && decision.plan.task.taskId) {
        const referencedTask = this.deps.taskRuntimeService.findTask(decision.plan.task.taskId);
        if (!referencedTask) {
          this.deps.callbacks.appendOutput(`Error: task not found ${decision.plan.task.taskId}`);
          return true;
        }
        await this.handleReferencedTaskFromPlan(userInput, referencedTask, decision.plan, decision.id);
        return true;
      }

      await this.createAndPrepareTask(userInput, decision);
      return true;
    }

    this.deps.callbacks.refreshRuntimeState();
    return true;
  }

  private recordPlanningDecision(userInput: string, plan: PlanningAgentPlan, decision: KernelDecision): void {
    this.deps.planningDecisionRepo.insert({
      id: decision.id,
      sessionId: this.deps.sessionId,
      requestId: plan.id,
      taskId: plan.task.taskId,
      userInput,
      plan,
      decision,
      outcome: decision.outcome,
      reason: decision.reason,
      createdAt: new Date().toISOString(),
    });
  }

  private formatKernelProgress(decision: KernelDecision): string[] {
    if (decision.runtimeAction === 'plan_work_graph') {
      const selectedExecutor = decision.plan.execution.selectedExecutor ?? decision.plan.execution.candidateExecutors[0] ?? this.deps.executor.name;
      return [
        '→ MetaClaw：已识别可执行任务',
        decision.plan.reason === '按当前对话创建跟进任务' ? `→ ${decision.plan.reason}` : '',
        `→ MetaClaw：执行策略：创建可追踪任务并派发给 ${selectedExecutor}`,
        `【Executor: ${selectedExecutor}｜派发准备】`,
        `→ Executor: ${selectedExecutor} 将处理该任务`,
        '-> PlanningAgent: proposed executable work graph',
        `-> PolicyKernel: ${decision.outcome} (${decision.reason})`,
        `-> Runtime: will dispatch executor candidate ${selectedExecutor}`,
      ].filter(Boolean);
    }

    if (decision.runtimeAction === 'task_control') {
      return [
        '-> PlanningAgent: recognized task control request',
        `-> PolicyKernel: ${decision.outcome} (${decision.reason})`,
      ];
    }

    if (decision.runtimeAction === 'direct_reply') {
      return [
        '→ MetaClaw：已识别普通对话',
        '→ MetaClaw：执行策略：直接回答，不创建任务',
        decision.plan.reason === '延续当前对话，不恢复旧任务' ? `→ ${decision.plan.reason}` : '',
        `【Executor: ${this.deps.executor.name}｜回答】`,
        `→ Executor: ${this.deps.executor.name} 处理本次回答`,
        '-> PlanningAgent: recognized conversation turn',
        `-> PolicyKernel: ${decision.outcome} (${decision.reason})`,
      ].filter(Boolean);
    }

    return [
      `-> PlanningAgent: ${decision.plan.action}`,
      `-> PolicyKernel: ${decision.outcome} (${decision.reason})`,
    ];
  }

  private async applyTaskControlDecision(userInput: string, plan: PlanningAgentPlan, kernelDecisionId: string): Promise<boolean> {
    if (plan.task.binding === 'reference' && plan.task.taskId) {
      const referencedTask = this.deps.taskRuntimeService.findTask(plan.task.taskId);
      if (!referencedTask) {
        this.deps.callbacks.appendOutput(`Error: task not found ${plan.task.taskId}`);
        return true;
      }

      await this.handleReferencedTaskFromPlan(userInput, referencedTask, plan, kernelDecisionId);
      return true;
    }
    if (plan.task.control === 'status_query') {
      const scope = this.normalizeTaskStatusScope(plan.task.scope);
      this.deps.callbacks.appendOutput(this.deps.presentation.formatTaskStatus({
        scope,
        blockedTasks: this.deps.orchestration.getBlockedTasks(),
        runningTask: this.deps.taskRuntimeService.listTasksByStatus('running')[0] ?? null,
        activeTasks: filterDurableTasks(this.deps.taskRuntimeService.listActiveTasks()),
        latestDone: filterDurableTasks(this.deps.taskRuntimeService.listTasksByStatus('done'))[0] ?? null,
        dashboard: this.deps.orchestration.getDashboard(),
      }));
      this.deps.callbacks.refreshRuntimeState();
      return true;
    }
    if (plan.task.control === 'clear_tasks') {
      const scope = this.normalizeTaskClearScope(plan.task.scope);
      const result = this.deps.taskRuntimeService.clearTasks(scope);
      if (result.runningCancelled) {
        this.deps.executor.abort();
      }
      if (result.cancelled.some(task => task.id === this.deps.callbacks.getCurrentTaskId())) {
        this.deps.callbacks.setCurrentTaskId(null);
        this.deps.callbacks.setFocusContext(null);
      }
      this.deps.callbacks.refreshRuntimeState();
      this.deps.callbacks.appendOutput(this.deps.presentation.formatTaskClearResult({
        scope,
        cancelled: result.cancelled,
        runningCancelled: result.runningCancelled,
      }));
      return true;
    }
    // resume_task / recover_blocked without an explicit taskId are already
    // forced to clarification by the kernel; reaching here without one is a
    // defensive fallback, not a guess-the-task path.
    if (plan.task.control === 'resume_task' || plan.task.control === 'recover_blocked') {
      this.deps.callbacks.appendOutput('→ 未指定要恢复的目标任务，请明确要恢复哪个任务。');
      this.deps.callbacks.refreshRuntimeState();
      return true;
    }
    this.deps.callbacks.appendOutput('No matching task control action was found.');
    return true;
  }

  private async createAndPrepareTask(userInput: string, decision: KernelDecision): Promise<void> {
    const plan = decision.plan;
    const inlineResourceContext = this.deps.memoryContextService.normalizeInlineResourcesFromInput(userInput);
    const task = this.deps.taskRuntimeService.createTask({
      title: (plan.task.title ?? inlineResourceContext.normalizedGoal).slice(0, 50),
      goal: plan.task.goal ?? inlineResourceContext.normalizedGoal,
      resources: inlineResourceContext.resources,
    });
    await this.applySemanticPriority(task.id, userInput);
    this.deps.callbacks.setCurrentTaskId(task.id);
    this.deps.callbacks.setFocusContext({ kind: 'task', taskId: task.id });
    this.deps.callbacks.appendOutput(`任务 #${task.id} 已创建：${task.title}`);
    if (inlineResourceContext.resources.length > 0) {
      this.deps.callbacks.appendOutput(`→ 已自动关联 ${inlineResourceContext.resources.length} 份材料`);
    }

    await this.deps.callbacks.prepareTaskExecution(task.id, {
      userPrompt: userInput,
      contextTaskId: task.id,
      executionMode: 'fresh',
      schedulingReason: buildSchedulingReason(userInput),
      includeRecentConversationContext: plan.task.includeRecentConversationContext,
      planningPlan: {
        ...plan,
        task: {
          ...plan.task,
          taskId: task.id,
          binding: 'reference',
        },
      },
      kernelDecisionId: decision.id,
    });
  }

  private async handleReferencedTaskFromPlan(
    userInput: string,
    referencedTask: Task,
    plan: PlanningAgentPlan,
    kernelDecisionId: string,
  ): Promise<void> {
    await this.applyResumePlanResult(userInput, this.deps.taskResumePlanner.planReferencedTask({
      userInput,
      referencedTask,
      plan,
    }), plan, kernelDecisionId);
  }

  private async applyResumePlanResult(
    userInput: string,
    result: ResumePlanResult,
    plan?: PlanningAgentPlan,
    kernelDecisionId?: string,
  ): Promise<boolean> {
    if (result.action === 'not_handled') {
      return false;
    }
    if (result.action === 'message') {
      this.deps.callbacks.appendOutput(...result.lines);
      this.deps.callbacks.refreshRuntimeState();
      return true;
    }
    if (result.action === 'fork_follow_up') {
      const followUpTask = this.deps.taskRuntimeService.createTask(result.plan.newTaskInput);
      await this.applySemanticPriority(followUpTask.id, userInput);
      this.deps.callbacks.setCurrentTaskId(followUpTask.id);
      this.deps.callbacks.setFocusContext({ kind: 'task', taskId: followUpTask.id });
      this.deps.callbacks.appendOutput(...result.lines, `-> Created follow-up task #${followUpTask.id}`);
      await this.deps.callbacks.prepareTaskExecution(followUpTask.id, {
        userPrompt: userInput,
        contextTaskId: result.plan.contextTaskId,
        executionMode: 'follow-up',
        schedulingReason: result.schedulingReason,
        planningPlan: plan ? bindPlanToTask(plan, followUpTask.id) : null,
        kernelDecisionId,
      });
      return true;
    }
    if (result.action === 'unblock_and_execute') {
      for (const resourcePath of result.newlyProvidedResources ?? []) {
        this.deps.taskRuntimeService.attachResource(result.task.id, resourcePath);
      }
      this.deps.taskRuntimeService.unblockTask(result.task.id);
      this.deps.callbacks.setCurrentTaskId(result.task.id);
      this.deps.callbacks.setFocusContext({ kind: 'task', taskId: result.task.id });
      if (result.observeResumeIntent) {
        await this.deps.taskSemanticService.observeResumeIntent(
          userInput,
          this.deps.callbacks.buildRecentTaskSummaries([result.task]),
        );
      }
      this.deps.callbacks.appendOutput(...result.lines);
      await this.deps.callbacks.prepareTaskExecution(result.task.id, {
        userPrompt: userInput,
        contextTaskId: result.task.id,
        executionMode: 'resume-blocked',
        schedulingReason: result.schedulingReason,
        newlyProvidedResources: result.newlyProvidedResources,
        planningPlan: plan ? bindPlanToTask(plan, result.task.id) : null,
        kernelDecisionId,
        recoveryTrigger: this.deps.callbacks.buildRecoveryTrigger(result.task, {
          kind: result.triggerKind ?? 'natural-language-resume',
          blockedReason: result.blockedReason ?? undefined,
          triggerReason: result.triggerReason,
          sourceInput: userInput,
          newlyProvidedResources: result.newlyProvidedResources,
        }),
      });
      return true;
    }

    this.deps.callbacks.setCurrentTaskId(result.plan.executionTaskId);
    this.deps.callbacks.setFocusContext({ kind: 'task', taskId: result.plan.executionTaskId });
    if (result.observeResumeIntent) {
      await this.deps.taskSemanticService.observeResumeIntent(
        userInput,
        this.deps.callbacks.buildRecentTaskSummaries([result.task]),
      );
      this.resumeParkedTaskIfStillParked(result.task.id);
    }
    this.deps.callbacks.appendOutput(...result.lines);
    await this.applySemanticPriority(result.plan.executionTaskId, userInput);
    await this.deps.callbacks.prepareTaskExecution(result.plan.executionTaskId, {
      userPrompt: userInput,
      contextTaskId: result.plan.contextTaskId,
      executionMode: result.executionMode,
      schedulingReason: result.schedulingReason,
      planningPlan: plan ? bindPlanToTask(plan, result.plan.executionTaskId) : null,
      kernelDecisionId,
    });
    return true;
  }

  private async applySemanticPriority(taskId: string, userInput: string): Promise<void> {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    if (!task) {
      return;
    }

    const priority = await this.deps.taskSemanticService.classifyPriority(
      userInput,
      { priority: parsePriorityHint(userInput), reason: 'semantic priority from PlanningAgent input' },
    );

    this.deps.taskRuntimeService.updateTask(taskId, {
      prioritySignals: {
        ...task.prioritySignals,
        semanticPriority: priority.priority,
        semanticPriorityReason: priority.reason,
      },
    });
  }

  private resumeParkedTaskIfStillParked(taskId: string): void {
    const latestTask = this.deps.taskRuntimeService.findTask(taskId);
    if (latestTask?.status === 'parked') {
      this.deps.taskRuntimeService.resumeParkedTask(taskId);
    }
  }

  private normalizeTaskStatusScope(scope: string | null): TaskStatusQueryScope {
    return scope === 'blocked' || scope === 'running' || scope === 'dashboard'
      ? scope
      : 'dashboard';
  }

  private normalizeTaskClearScope(scope: string | null): TaskClearScope {
    return scope === 'parked' || scope === 'blocked' || scope === 'all'
      ? scope
      : 'all';
  }
}

// TODO(adr-0014-compat) HIGH: forcing action to 'plan_work_graph' on resume/fork
// makes the persisted decision.action disagree with the plan's real origin
// (often task_control), and relies on the runtime fallback work graph to fill in
// executable subtasks. resume/fork should produce a real workGraph via the
// planner/kernel instead of relabeling here.
// See docs/tech-debt/legacy-compat-layers.md (#4).
function bindPlanToTask(plan: PlanningAgentPlan, taskId: string): PlanningAgentPlan {
  return {
    ...plan,
    action: 'plan_work_graph',
    task: {
      ...plan.task,
      taskId,
      binding: 'reference',
    },
  };
}
