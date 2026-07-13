// Session facade that wires MetaClaw's task OS modules and exposes the user-facing session snapshot.
import type Database from 'better-sqlite3';
import type {
  Config,
  GuidanceActionType,
  GuidanceProposal,
  RuntimeState,
  AgentClass,
  Task,
  TaskRecoveryTrigger,
} from '../core/types.js';
import type { TaskEngine } from '../task/task-engine.js';
import type { MemoryEngine } from '../memory/memory-engine.js';
import type { OrchestrationEngine } from '../guidance/orchestration.js';
import type { ExecutorAdapter } from '../executor/adapter.js';
import { NoopNotificationService, type NotificationService } from '../notifications/types.js';
import type { ContextRecaller } from '../memory/context-recaller.js';
import type { LlmBridge } from '../core/llm-bridge.js';
import { SchedulerEngine } from '../task/scheduler.js';
import type { DispatchContext } from '../task/scheduler.js';
import { ResumeContextBuilder } from '../memory/resume-context-builder.js';
import { MemoryContextService } from '../memory/memory-context-service.js';
import { RecallReviewApplicationService, createDefaultRecallReviewApplicationService } from '../memory/recall-review-application-service.js';
import { SessionPersistenceService } from './session-persistence-service.js';
import { MemoryCaptureService } from '../memory/memory-capture-service.js';
import { ConversationRuntimeService } from '../execution/conversation-runtime-service.js';
import { TaskResumePlanner } from '../task/task-resume-planner.js';
import { createDefaultCommandCatalog } from '../commands/command-tree.js';
import type { CommandCatalog, CommandCompletion, CommandContext } from '../commands/catalog.js';
import { isPermissionFailure, isRecoverableExecutorFailure } from '../executor/error-utils.js';
import { SessionStateRepo } from '../storage/session-state-repo.js';
import { TaskRuntimeService } from '../task/task-runtime-service.js';
import { ExecutionRuntime, ExecutorRegistry } from '../execution/execution-runtime.js';
import { VerificationAndDeliveryService } from '../delivery/verification-and-delivery-service.js';
import { AgentClassService } from '../executor/agent-class-service.js';
import { ExecutorAdminService } from '../executor/executor-admin-service.js';
import { ExecutionProgressService } from '../execution/execution-progress-service.js';
import { WorkUnitClaimService } from '../execution/work-unit-claim-service.js';
import { WorkspaceTargetService } from '../execution/workspace-target-service.js';
import { InputController } from './input-controller.js';
import { SessionPresentationService, type GuidanceState } from './session-presentation-service.js';
import { SessionExecutionCoordinator } from './session-execution-coordinator.js';
import { SessionTaskExecutionApplicationService } from './session-task-execution-application-service.js';
import { type QueuedExecutionRequest } from './session-helpers.js';
import { SubtaskRepo } from '../storage/subtask-repo.js';
import { TaskEventRepo } from '../storage/task-event-repo.js';
import { WorkUnitRepo } from '../storage/work-unit-repo.js';
import { WorkGraphRuntimeService } from '../execution/work-graph-runtime-service.js';
import type { PlanningAgent } from '../planning/planning-agent.js';
import { PlanningContextBuilder } from '../planning/planning-context-builder.js';
import { createDefaultPlanningAgent } from '../planning/codex-planning-agent.js';
import type { PlanningAgentPlan } from '../planning/planning-types.js';
import { PolicyKernel, type KernelDecision } from '../kernel/policy-kernel.js';
import { KernelDecisionApplier } from './kernel-decision-applier.js';
import { PlanningDecisionRepo } from '../storage/planning-decision-repo.js';
import { PlannerRunRepo } from '../storage/planner-run-repo.js';

export interface MetaclawSessionDeps {
  taskEngine: TaskEngine;
  memoryEngine: MemoryEngine;
  orchestration: OrchestrationEngine;
  executor: ExecutorAdapter;
  db: Database.Database;
  config: Config;
  sessionId: string;
  contextRecaller: ContextRecaller;
  llmBridge: LlmBridge;
  planningAgent?: PlanningAgent;
  notifier?: NotificationService;
  executorFactory?: (name: string) => ExecutorAdapter | null;
  availableExecutorCommands?: Set<string>;
}

export interface SessionSnapshot {
  output: string[];
  currentTaskId: string | null;
  currentTask: {
    id: string;
    title: string;
    status: Task['status'];
  } | null;
  runtimeState: RuntimeState;
  latestGuidance: GuidanceState | null;
}

interface FocusContext {
  kind: 'conversation' | 'task';
  taskId: string | null;
}

const DEFAULT_PLANNER_TIMEOUT_MS = 60_000;

/** Wires the session-facing services and exposes the imperative API used by TUI, CLI, gateway, and scripted runs. */
export class MetaclawSession {
  private output: string[] = [];
  private runtimeState: RuntimeState = {
    runningTaskId: null,
    runningExecutorName: null,
    readyTaskIds: [],
    blockedTaskIds: [],
    parkedTaskIds: [],
    lastEvent: null,
  };
  private latestGuidance: GuidanceState | null = null;
  private initialized = false;
  private listeners = new Set<(snapshot: SessionSnapshot) => void>();
  private runningExecutorNameByTask = new Map<string, string>();
  private lastReminderAt: number | null = null;
  private lastReminderFingerprint: string | null = null;
  private lastTaskPoolWatchdogReminderAt: number | null = null;
  private lastTaskPoolWatchdogFingerprint: string | null = null;
  private lastBlockedRecheckAt: number | null = null;
  private blockedRecheckInFlight = false;
  private backgroundWork = new Set<Promise<void>>();
  private readonly memoryContextService: MemoryContextService;
  private readonly commandCatalog: CommandCatalog;
  private readonly scheduler: SchedulerEngine<QueuedExecutionRequest>;
  private readonly sessionStateRepo: SessionStateRepo;
  private readonly notifier: NotificationService;
  private readonly inputController: InputController;
  private readonly taskRuntimeService: TaskRuntimeService;
  private readonly executionRuntime: ExecutionRuntime;
  private readonly verificationAndDeliveryService: VerificationAndDeliveryService;
  private readonly persistenceService: SessionPersistenceService;
  private readonly conversationRuntimeService: ConversationRuntimeService;
  private readonly memoryCaptureService: MemoryCaptureService;
  private readonly recallReviewApplicationService: RecallReviewApplicationService;
  private readonly taskResumePlanner: TaskResumePlanner;
  private readonly presentation: SessionPresentationService;
  private readonly agentClassService: AgentClassService;
  private readonly executorAdminService: ExecutorAdminService;
  private readonly executionProgressService: ExecutionProgressService;
  private readonly planningContextBuilder: PlanningContextBuilder;
  private readonly planningAgent: PlanningAgent;
  private readonly policyKernel: PolicyKernel;
  private readonly planningDecisionRepo: PlanningDecisionRepo;
  private readonly workGraphRuntimeService: WorkGraphRuntimeService;
  private readonly subtaskRepo: SubtaskRepo;
  private readonly taskEventRepo: TaskEventRepo;
  private readonly workUnitClaimService: WorkUnitClaimService;
  private readonly workspaceTargetService: WorkspaceTargetService;
  private readonly sessionExecutionCoordinator: SessionExecutionCoordinator;
  private readonly taskExecutionApplicationService: SessionTaskExecutionApplicationService;
  private readonly kernelDecisionApplier: KernelDecisionApplier;

  constructor(private deps: MetaclawSessionDeps) {
    this.notifier = deps.notifier ?? new NoopNotificationService();
    this.sessionStateRepo = new SessionStateRepo(deps.db);
    this.taskRuntimeService = new TaskRuntimeService({
      taskEngine: deps.taskEngine,
      taskRepo: deps.taskEngine.getTaskRepo(),
      orchestration: deps.orchestration,
    });
    this.agentClassService = new AgentClassService({
      db: deps.db,
      defaultExecutorName: deps.executor.name,
      availableCommands: deps.availableExecutorCommands,
    });
    const executorRegistry = new ExecutorRegistry({
      db: deps.db,
      config: deps.config,
      defaultExecutor: deps.executor,
      executorFactory: deps.executorFactory,
    });
    this.executionRuntime = new ExecutionRuntime(executorRegistry, deps.executor);
    this.verificationAndDeliveryService = new VerificationAndDeliveryService();
    this.persistenceService = new SessionPersistenceService(deps.db);
    this.presentation = new SessionPresentationService();
    this.executorAdminService = new ExecutorAdminService({
      agentClassService: this.agentClassService,
      presentation: this.presentation,
    });
    this.executionProgressService = new ExecutionProgressService(deps.db);
    this.subtaskRepo = new SubtaskRepo(deps.db);
    this.taskEventRepo = new TaskEventRepo(deps.db);
    this.workGraphRuntimeService = new WorkGraphRuntimeService(
      this.subtaskRepo,
      this.taskEventRepo,
      deps.executor.name,
    );
    this.workUnitClaimService = new WorkUnitClaimService(
      new WorkUnitRepo(deps.db),
      60_000,
      name => this.executionRuntime.isExecutorAvailable(name),
    );
    this.workspaceTargetService = new WorkspaceTargetService();
    this.memoryContextService = new MemoryContextService({
      memoryEngine: deps.memoryEngine,
      contextRecaller: deps.contextRecaller,
      resumeContextBuilder: new ResumeContextBuilder(
        deps.taskEngine,
        deps.memoryEngine,
        deps.contextRecaller,
      ),
    });
    this.conversationRuntimeService = new ConversationRuntimeService({
      executor: deps.executor,
      memoryContextService: this.memoryContextService,
      persistenceService: this.persistenceService,
      appendOutput: (...lines) => this.appendOutput(...lines),
    });
    this.memoryCaptureService = new MemoryCaptureService({
      db: deps.db,
      memoryEngine: deps.memoryEngine,
      notifier: this.notifier,
      deliveryService: this.verificationAndDeliveryService,
    });
    this.recallReviewApplicationService = createDefaultRecallReviewApplicationService({
      db: deps.db,
      memoryContextService: this.memoryContextService,
      memoryCaptureService: this.memoryCaptureService,
      formatters: this.presentation,
    });
    this.taskResumePlanner = new TaskResumePlanner({
      taskRuntimeService: this.taskRuntimeService,
    });
    this.planningContextBuilder = new PlanningContextBuilder({
      sessionId: deps.sessionId,
      requestSource: 'session',
      getTimeoutMs: () => this.getPlannerTimeoutMs(),
    });
    this.planningAgent = deps.planningAgent ?? createDefaultPlanningAgent({
      audit: new PlannerRunRepo(deps.db),
    });
    this.policyKernel = new PolicyKernel();
    this.planningDecisionRepo = new PlanningDecisionRepo(deps.db);
    this.commandCatalog = createDefaultCommandCatalog();
    this.scheduler = new SchedulerEngine<QueuedExecutionRequest>(
      deps.taskEngine,
      deps.orchestration,
      deps.executor,
      async (taskId: string, context?: DispatchContext<QueuedExecutionRequest>) => this.dispatchTask(taskId, context),
      undefined,
      this.taskRuntimeService,
      this.executionRuntime,
    );
    this.inputController = new InputController({
      appendUserInput: (input: string) => this.appendUserInput(input),
      hasPendingExecutorRegisterWizard: () => this.executorAdminService.hasPendingWizard(),
      handlePendingExecutorRegisterWizard: (input: string) => this.handlePendingExecutorRegisterWizardInput(input),
      handleCommand: (input: string) => this.handleCommand(input),
      handleNaturalLanguageInput: (input: string) => this.handleNaturalLanguageInput(input),
      waitForAsyncWork: () => this.waitForAsyncWork(),
      handleSubmitError: (error: unknown) => this.appendOutput(`错误: ${(error as Error).message}`),
    });
    this.sessionExecutionCoordinator = new SessionExecutionCoordinator({
      sessionId: deps.sessionId,
      memoryEngine: deps.memoryEngine,
      orchestration: deps.orchestration,
      notifier: this.notifier,
      taskRuntimeService: this.taskRuntimeService,
      memoryContextService: this.memoryContextService,
      agentClassService: this.agentClassService,
      workGraphRuntimeService: this.workGraphRuntimeService,
      subtaskRepo: this.subtaskRepo,
      taskEventRepo: this.taskEventRepo,
      workUnitClaimService: this.workUnitClaimService,
      executionRuntime: this.executionRuntime,
      scheduler: this.scheduler,
      executionProgressService: this.executionProgressService,
      workspaceTargetService: this.workspaceTargetService,
      verificationAndDeliveryService: this.verificationAndDeliveryService,
      persistenceService: this.persistenceService,
      memoryCaptureService: this.memoryCaptureService,
      presentation: this.presentation,
      callbacks: {
        appendOutput: (...lines: string[]) => this.appendOutput(...lines),
        refreshRuntimeState: () => this.refreshRuntimeState(),
        appendTaskQueueSnapshot: trigger => this.appendTaskQueueSnapshot(trigger),
        setFocusContext: focus => this.setFocusContext(focus),
        setRunningExecutorName: (taskId, name) => this.runningExecutorNameByTask.set(taskId, name),
        clearRunningExecutorName: taskId => this.runningExecutorNameByTask.delete(taskId),
        persistSessionState: changes => this.persistSessionState(changes),
        setLatestGuidance: (scene, suggestion) => this.setLatestGuidance(scene, suggestion),
        queueProposal: (scene, proposal) => this.queueProposal(scene, proposal),
      },
    });
    this.taskExecutionApplicationService = new SessionTaskExecutionApplicationService({
      defaultExecutorName: deps.executor.name,
      taskRuntimeService: this.taskRuntimeService,
      scheduler: this.scheduler,
      recallReviewApplicationService: this.recallReviewApplicationService,
      sessionExecutionCoordinator: this.sessionExecutionCoordinator,
      presentation: this.presentation,
      callbacks: {
        appendOutput: (...lines: string[]) => this.appendOutput(...lines),
        appendGuidance: (scene, suggestion) => this.appendGuidance(scene, suggestion),
        appendTaskQueueSnapshot: trigger => this.appendTaskQueueSnapshot(trigger),
        refreshRuntimeState: () => this.refreshRuntimeState(),
        notify: () => this.notify(),
      },
    });
    this.kernelDecisionApplier = new KernelDecisionApplier({
      sessionId: deps.sessionId,
      planningDecisionRepo: this.planningDecisionRepo,
      taskRuntimeService: this.taskRuntimeService,
      taskResumePlanner: this.taskResumePlanner,
      memoryContextService: this.memoryContextService,
      orchestration: deps.orchestration,
      executor: deps.executor,
      activeExecutions: this.executionRuntime,
      presentation: this.presentation,
      callbacks: {
        appendOutput: (...lines: string[]) => this.appendOutput(...lines),
        appendPlanningClarification: (userInput, plan, decision) => this.appendPlanningClarification(userInput, plan, decision),
        runConversationInput: userInput => this.runConversationInput(userInput),
        prepareTaskExecution: (taskId, request) => this.prepareTaskExecution(taskId, request),
        refreshRuntimeState: () => this.refreshRuntimeState(),
        setCurrentTaskId: taskId => this.setCurrentTaskId(taskId),
        getCurrentTaskId: () => this.getCurrentTaskId(),
        setFocusContext: focus => this.setFocusContext(focus),
        buildRecoveryTrigger: (task, input) => this.buildRecoveryTrigger(task, input),
      },
    });

    // AgentClass records are startup catalog data. Constructing a session must
    // make the catalog readable even for non-UI hosts that do not call the
    // optional dashboard-oriented initialize() lifecycle hook.
    this.seedAgentRuntime();
  }

  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): SessionSnapshot {
    this.reconcileLatestGuidance();
    const currentTaskId = this.getCurrentTaskId();
    const currentTask = currentTaskId ? this.taskRuntimeService.findTask(currentTaskId) : null;
    return {
      output: [...this.output],
      currentTaskId,
      currentTask: currentTask
        ? {
            id: currentTask.id,
            title: currentTask.title,
            status: currentTask.status,
          }
        : null,
      runtimeState: this.runtimeState,
      latestGuidance: this.latestGuidance
        ? {
            ...this.latestGuidance,
            reasons: [...this.latestGuidance.reasons],
          }
        : null,
    };
  }

  completeCommand(text: string, cursor = text.length): CommandCompletion {
    return this.commandCatalog.complete({ text, cursor, context: this.getCommandContext() });
  }

  private reconcileLatestGuidance(): void {
    if (!this.latestGuidance) {
      return;
    }

    const task = this.taskRuntimeService.findTask(this.latestGuidance.taskId);
    if (!task || !['created', 'ready', 'running', 'parked', 'blocked'].includes(task.status)) {
      this.latestGuidance = null;
      return;
    }

    if (this.latestGuidance.taskTitle !== task.title) {
      this.latestGuidance = {
        ...this.latestGuidance,
        taskTitle: task.title,
      };
    }
  }

  initialize(options: { resumeStartupTasks?: boolean; showDashboard?: boolean } = {}): void {
    if (this.initialized) return;

    this.seedAgentRuntime();

    const resumeStartupTasks = options.resumeStartupTasks ?? true;
    const showDashboard = options.showDashboard ?? true;
    const recoveredRunningTasks = resumeStartupTasks ? this.recoverOrphanedRunningTasks() : [];

    if (showDashboard && this.deps.config.ui.dashboard_on_start) {
      const dashboard = this.deps.orchestration.getDashboard();
      this.output = [
        '┌─ Metaclaw v1.0 ─────────────────────────────────┐',
        `│ 你有 ${dashboard.summary.active} 个活跃任务，${dashboard.summary.blocked} 个 Blocked。`,
      ];

      if (dashboard.priorityTask) {
        this.output.push(`│ 建议优先：#${dashboard.priorityTask.id} ${dashboard.priorityTask.title}`);
        dashboard.priorityTask.reasons.forEach(reason => this.output.push(`│   → ${reason}`));
      }

      this.output.push('└──────────────────────────────────────────────────┘');

      if (dashboard.priorityTask) {
        this.appendGuidance('启动建议', {
          taskId: dashboard.priorityTask.id,
          recommendedAction: `优先处理任务 #${dashboard.priorityTask.id}: ${dashboard.priorityTask.title}`,
          reasons: dashboard.priorityTask.reasons,
        });
      }
    }

    if (recoveredRunningTasks.length > 0) {
      for (const task of recoveredRunningTasks) {
        this.output.push(
          `→ 检测到上次异常退出，任务 #${task.id} 已转为挂起`,
          `→ 可执行 /task resume ${task.id} 继续，或直接说“继续刚才那个任务”`,
        );
      }
    }

    const startupProposal = resumeStartupTasks ? this.deps.orchestration.generateProposals('startup')[0] : null;
    if (startupProposal) {
      this.queueProposal('启动建议', startupProposal);
    }

    this.initialized = true;
    this.refreshRuntimeState();
    this.notify();
    if (resumeStartupTasks) {
      this.resumeUnfinishedTasksOnStartup(recoveredRunningTasks);
    }
  }

  async submit(
    rawInput: string,
    options: { awaitAsyncWork?: boolean } = {},
  ): Promise<{ exitRequested: boolean }> {
    return this.inputController.submit(rawInput, options);
  }

  async waitForAsyncWork(): Promise<void> {
    while (this.backgroundWork.size > 0) {
      await Promise.allSettled(Array.from(this.backgroundWork));
    }
    await this.scheduler.waitForIdle();
  }

  appendSystemMessage(...lines: string[]): void {
    this.appendOutput(...lines);
  }

  private appendUserInput(userInput: string): void {
    this.appendOutput('', `> ${userInput}`);
  }

  maybeEmitIdleGuidance(nowMs = Date.now()): boolean {
    if (!this.deps.config.orchestration.reminder_enabled) {
      return false;
    }

    const suggestions = this.deps.orchestration.generateSuggestions();
    if (suggestions.length === 0) {
      return false;
    }

    const suggestion = suggestions[0];
    const fingerprint = `${suggestion.type}:${suggestion.taskId}:${suggestion.reasons.join('|')}`;
    const throttleMs = this.deps.config.orchestration.reminder_throttle * 1000;

    if (
      this.lastReminderFingerprint === fingerprint
      && this.lastReminderAt !== null
      && nowMs - this.lastReminderAt < throttleMs
    ) {
      return false;
    }

    this.lastReminderAt = nowMs;
    this.lastReminderFingerprint = fingerprint;
    this.setLatestGuidance('空闲提醒', suggestion);
    this.appendOutput(
      '',
      `💡 提醒：${suggestion.recommendedAction}`,
      `   → 目标任务：#${suggestion.taskId}${this.buildSuggestionTaskTitleSuffix(suggestion.taskId)}`,
      ...suggestion.reasons.map(reason => `   → ${reason}`),
    );
    return true;
  }

  async maybeReconcileBlockedTasksOnTimer(nowMs = Date.now()): Promise<boolean> {
    if (this.blockedRecheckInFlight) {
      return false;
    }

    const orchestrationConfig = this.deps.config.orchestration;
    if (orchestrationConfig.blocked_recheck_enabled === false) {
      return false;
    }

    const intervalMs = Math.max(orchestrationConfig.blocked_recheck_interval ?? 60, 5) * 1000;
    if (
      this.lastBlockedRecheckAt !== null
      && nowMs - this.lastBlockedRecheckAt < intervalMs
    ) {
      return false;
    }

    const candidates = this.findTimerRecheckableBlockedTasks();
    if (candidates.length === 0) {
      this.lastBlockedRecheckAt = nowMs;
      return false;
    }

    this.lastBlockedRecheckAt = nowMs;
    this.blockedRecheckInFlight = true;
    try {
      const executorAvailable = await this.deps.executor.isAvailable();
      if (!executorAvailable) {
        return false;
      }

      const target = candidates[0];
      const blockedReason = this.getWaitingBlockReason(target) || '未知原因';
      this.taskRuntimeService.unblockTask(target.id);
      this.setCurrentTaskId(target.id);
      this.setFocusContext({ kind: 'task', taskId: target.id });
      this.appendOutput(
        `→ 定时检查：任务 #${target.id} 的阻塞条件可能已恢复`,
        `→ 原阻塞原因：${blockedReason}`,
        '→ 已解除阻塞并重新进入调度',
      );
      await this.prepareTaskExecution(target.id, {
        userPrompt: target.goal,
        contextTaskId: target.id,
        executionMode: 'resume-blocked',
        origin: 'system',
        schedulingReason: '定时检查确认执行器可用，恢复阻塞任务',
        recoveryTrigger: this.buildRecoveryTrigger(target, {
          kind: 'timer-recheck',
          blockedReason,
          triggerReason: '定时检查确认执行器可用',
        }),
      });
      return true;
    } finally {
      this.blockedRecheckInFlight = false;
      this.refreshRuntimeState();
    }
  }

  getBlockedRecheckIntervalMs(): number {
    const seconds = this.deps.config.orchestration.blocked_recheck_interval ?? 60;
    return Math.max(seconds, 5) * 1000;
  }

  async maybeReviewTaskPoolOnTimer(nowMs = Date.now()): Promise<boolean> {
    if (await this.maybeReconcileBlockedTasksOnTimer(nowMs)) {
      return true;
    }

    const beforeState = this.scheduler.getRuntimeState();
    const scheduledTaskId = await this.scheduler.scheduleNext();
    this.refreshRuntimeState();

    if (!beforeState.runningTaskId && scheduledTaskId) {
      const task = this.taskRuntimeService.findTask(scheduledTaskId);
      if (task) {
        this.appendOutput(
          `→ 任务池看护：发现可执行任务 #${task.id} ${task.title}`,
          '→ 已自动进入调度执行',
        );
      }
      return true;
    }

    return this.maybeEmitTaskPoolWatchdogReminder(nowMs);
  }

  private findTimerRecheckableBlockedTasks(): Task[] {
    return this.taskRuntimeService.listTasks()
      .filter(task => task.status === 'blocked')
      .filter(task => this.isTimerRecheckableBlockedTask(task))
      .sort((left, right) => new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime());
  }

  private isTimerRecheckableBlockedTask(task: Task): boolean {
    const reason = this.getWaitingBlockReason(task);
    if (!reason) {
      return false;
    }

    if (isPermissionFailure(reason)) {
      return false;
    }

    if (/材料|文件|链接|文档|资料|补充|缺少|等待|授权|权限|permission|authorized|access/i.test(reason)) {
      return false;
    }

    return isRecoverableExecutorFailure(reason);
  }

  private getWaitingBlockReason(task: Task): string {
    return task.dependencies
      .filter(dependency => dependency.status === 'waiting')
      .map(dependency => dependency.description)
      .filter(Boolean)
      .join('；');
  }

  private buildRecoveryTrigger(
    task: Task,
    input: {
      kind: TaskRecoveryTrigger['kind'];
      triggerReason: string;
      sourceInput?: string;
      blockedReason?: string;
      newlyProvidedResources?: string[];
    },
  ): TaskRecoveryTrigger {
    return {
      kind: input.kind,
      blockedReason: input.blockedReason || this.getWaitingBlockReason(task) || '未知原因',
      triggerReason: input.triggerReason,
      sourceInputExcerpt: input.sourceInput ? this.excerptInput(input.sourceInput) : undefined,
      newlyProvidedResources: input.newlyProvidedResources,
    };
  }

  private excerptInput(input: string, maxLength = 80): string {
    const normalized = input.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }

    return `${normalized.slice(0, maxLength - 1)}…`;
  }

  private maybeEmitTaskPoolWatchdogReminder(nowMs: number): boolean {
    if (!this.deps.config.orchestration.reminder_enabled) {
      return false;
    }

    const blockedTasks = this.taskRuntimeService.listTasks()
      .filter(task => task.status === 'blocked');
    const parkedTasks = this.taskRuntimeService.listTasks()
      .filter(task => task.status === 'parked');
    if (blockedTasks.length === 0 && parkedTasks.length === 0) {
      return false;
    }

    const fingerprint = [
      ...blockedTasks.map(task => `b:${task.id}:${this.getWaitingBlockReason(task)}`),
      ...parkedTasks.map(task => `p:${task.id}:${task.lastInterruptionReason}:${task.snapshots.at(-1)?.nextStep ?? ''}`),
    ].join('|');
    const throttleMs = this.deps.config.orchestration.reminder_throttle * 1000;
    if (
      this.lastTaskPoolWatchdogFingerprint === fingerprint
      && this.lastTaskPoolWatchdogReminderAt !== null
      && nowMs - this.lastTaskPoolWatchdogReminderAt < throttleMs
    ) {
      return false;
    }

    this.lastTaskPoolWatchdogFingerprint = fingerprint;
    this.lastTaskPoolWatchdogReminderAt = nowMs;
    this.appendOutput(...this.presentation.formatTaskPoolWatchdogReminder({
      blockedTasks,
      parkedTasks,
      getWaitingBlockReason: task => this.getWaitingBlockReason(task),
    }));
    return true;
  }

  private notify(): void {
    const snapshot = this.getSnapshot();
    this.listeners.forEach(listener => listener(snapshot));
  }

  private buildSuggestionTaskTitleSuffix(taskId: string): string {
    const task = this.taskRuntimeService.findTask(taskId);
    if (!task?.title) {
      return '';
    }

    return ` ${task.title}`;
  }

  private setLatestGuidance(
    scene: string,
    suggestion: { taskId: string; recommendedAction: string; reasons: string[] },
  ): GuidanceState {
    this.latestGuidance = this.presentation.buildGuidanceState(
      scene,
      suggestion,
      this.taskRuntimeService.findTask(suggestion.taskId)?.title ?? '',
    );
    return this.latestGuidance;
  }

  private appendGuidance(
    scene: string,
    suggestion: { taskId: string; recommendedAction: string; reasons: string[] },
  ): void {
    this.setLatestGuidance(scene, suggestion);
    this.appendOutput(
      ...this.presentation.formatGuidanceBlock(scene, suggestion, this.latestGuidance?.taskTitle ?? ''),
    );
  }

  private queueProposal(scene: string, proposal: GuidanceProposal): void {
    this.appendOutput(...this.presentation.formatProposalBlock(
      scene,
      proposal,
      proposal.taskId ? this.taskRuntimeService.findTask(proposal.taskId)?.title ?? '' : '',
    ));
    this.appendOutput('→ 操作提案已记录，不等待用户确认；满足执行条件的任务由调度器自动处理');
  }

  private seedAgentRuntime(): void {
    this.agentClassService.seedDefaults();
  }

  private async handlePlanningKernelDecision(userInput: string): Promise<boolean> {
    this.appendOutput(
      '【MetaClaw｜理解用户请求】',
      '→ MetaClaw：正在分析目标、上下文与可执行边界',
    );
    const context = this.planningContextBuilder.build({ userInput });
    const plan = await this.planningAgent.plan(context);
    const decision = this.policyKernel.decide(plan, {
      tasks: this.taskRuntimeService.listTasks(),
      runningTask: this.taskRuntimeService.getCurrentRunningTask(),
      agentClasses: this.listRuntimeVisibleAgentClasses(),
      currentFocus: this.getFocusContext(),
    });

    return this.kernelDecisionApplier.apply({
      userInput,
      plan,
      decision,
    });
  }

  private listRuntimeVisibleAgentClasses(): AgentClass[] {
    return this.agentClassService.listAgentClasses();
  }

  private appendPlanningClarification(userInput: string, plan: PlanningAgentPlan, decision: KernelDecision): void {
    this.appendOutput(
      '→ 统一意图裁决置信度不足，未创建任务、未恢复旧任务、未派发执行器。',
      `→ 输入：${userInput}`,
      `→ 判断：${decision.reason || plan.reason || '无可靠语义裁决'} (confidence=${plan.confidence.toFixed(2)})`,
      plan.clarificationQuestion
        || '我不确定你是想继续聊天、创建新任务，还是恢复某个已有任务。请明确说明下一步动作。',
    );
  }

  private async prepareTaskExecution(
    taskId: string,
    request: QueuedExecutionRequest,
    proposalType: GuidanceActionType | null = null,
  ): Promise<void> {
    return this.taskExecutionApplicationService.prepareTaskExecution(taskId, request, proposalType);
  }

  private appendOutput(...lines: string[]): void {
    if (lines.length === 0) return;
    this.output.push(...lines);
    this.notify();
  }

  private setCurrentTaskId(taskId: string | null): void {
    this.taskRuntimeService.setCurrentTaskId(taskId);
    this.notify();
  }

  private getCurrentTaskId(): string | null {
    return this.taskRuntimeService.getCurrentTaskId();
  }

  private refreshRuntimeState(): void {
    const schedulerState = this.scheduler.getRuntimeState();
    this.runtimeState = {
      ...schedulerState,
      runningExecutorName: schedulerState.runningTaskId
        ? this.runningExecutorNameByTask.get(schedulerState.runningTaskId) ?? null
        : null,
    };
    this.notify();
  }

  private appendTaskQueueSnapshot(trigger: string): void {
    const entries = this.buildTaskQueueSnapshotEntries();
    if (entries.length === 0) {
      return;
    }

    this.appendOutput(...this.presentation.formatTaskQueueSnapshot({
      trigger,
      runtimeState: this.runtimeState,
      entries,
    }));
  }

  private buildTaskQueueSnapshotEntries() {
    return this.presentation.buildTaskQueueSnapshotEntries({
      tasks: this.taskRuntimeService.listTasks(),
      runningTaskId: this.runtimeState.runningTaskId,
      evaluateTask: task => this.deps.orchestration.evaluateTask(task),
    });
  }

  private persistSessionState(changes: {
    lastFocusedTaskId?: string | null;
    lastCompletedTaskId?: string | null;
    lastSessionId?: string | null;
  }): void {
    this.sessionStateRepo.upsert(changes);
  }

  private async handleCommand(userInput: string): Promise<boolean> {
    const result = await this.commandCatalog.execute(userInput, this.getCommandContext());
    this.appendOutput(result.content);

    if (result.type === 'directive' && result.directive.kind === 'start-executor-register-wizard') {
      this.appendOutput(...this.executorAdminService.startWizard());
    }

    if (result.type === 'exit') {
      this.persistSessionState({ lastSessionId: this.deps.sessionId });
      return true;
    }

    if (result.type === 'directive' && result.directive.kind === 'resume-task') {
      const directive = result.directive;
      const resumedTask = this.taskRuntimeService.findTask(directive.taskId);
      if (resumedTask) {
        this.setCurrentTaskId(resumedTask.id);
        await this.prepareTaskExecution(resumedTask.id, {
          userPrompt: resumedTask.goal,
          contextTaskId: resumedTask.id,
          executionMode: directive.mode,
          schedulingReason: directive.mode === 'resume-blocked' ? '解除阻塞' : '恢复已暂停任务',
          newlyProvidedResources: directive.newlyProvidedResources,
          recoveryTrigger: directive.mode === 'resume-blocked'
            ? this.buildRecoveryTrigger(resumedTask, {
                kind: 'explicit-task-command',
                blockedReason: directive.blockedReason,
                triggerReason: directive.newlyProvidedResources?.length
                  ? '显式解除阻塞并补充材料'
                  : '显式解除阻塞',
                sourceInput: userInput,
                newlyProvidedResources: directive.newlyProvidedResources,
              })
            : undefined,
        });
      }
    }

    return false;
  }

  private getCommandContext(): CommandContext {
    return {
      taskEngine: this.deps.taskEngine,
      memoryEngine: this.deps.memoryEngine,
      orchestration: this.deps.orchestration,
      executor: this.deps.executor,
      activeExecutions: this.executionRuntime,
      currentTaskId: this.getCurrentTaskId(),
      db: this.deps.db,
      config: this.deps.config,
    };
  }

  private async handlePendingExecutorRegisterWizardInput(userInput: string): Promise<boolean> {
    const result = await this.executorAdminService.handlePendingWizardInput(userInput);
    this.appendOutput(...result.lines);
    return result.handled;
  }

  private async handleNaturalLanguageInput(userInput: string): Promise<void> {
    if (await this.handlePlanningKernelDecision(userInput)) {
      return;
    }

    this.appendOutput(
      '-> PolicyKernel did not produce a runtime action.',
      'Please clarify whether you want to chat, create a new task, resume an existing task, or dispatch an executor.',
    );
  }

  private getPlannerTimeoutMs(): number {
    const configured = Number(process.env.METACLAW_PLANNER_TIMEOUT_MS);
    return Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_PLANNER_TIMEOUT_MS;
  }

  private async runConversationInput(userInput: string): Promise<void> {
    const result = await this.conversationRuntimeService.run({
      sessionId: this.deps.sessionId,
      userInput,
    });
    if (result.focus) {
      this.setFocusContext(result.focus);
    }
    this.appendOutput(...result.lines);
  }

  private dispatchTask(taskId: string, context?: DispatchContext<QueuedExecutionRequest>): Promise<void> {
    return this.taskExecutionApplicationService.dispatchTask(taskId, context);
  }

  private setFocusContext(focus: FocusContext | null): void {
    this.taskRuntimeService.setFocusContext(focus);
    if (focus?.kind === 'task' && focus.taskId) {
      this.persistSessionState({ lastFocusedTaskId: focus.taskId });
    }
  }

  private getFocusContext(): FocusContext | null {
    return this.taskRuntimeService.getFocusContext();
  }

  private recoverOrphanedRunningTasks(): Task[] {
    const runningTasks = this.taskRuntimeService.listTasksByStatus('running');
    const recovered: Task[] = [];

    for (const task of runningTasks) {
      const interruptionReason = 'Metaclaw 重启，原执行器会话已断开';
      this.taskRuntimeService.parkTask(task.id, interruptionReason, {
        done: task.summary ? [task.summary] : [],
        pending: [task.goal],
        nextStep: '确认环境后恢复当前任务',
        pauseReason: interruptionReason,
      });
      this.taskRuntimeService.updateTask(task.id, {
        lastInterruptionReason: interruptionReason,
        interruptionCount: task.interruptionCount + 1,
      });
      const parkedTask = this.taskRuntimeService.findTask(task.id);
      if (parkedTask) {
        recovered.push(parkedTask);
      }
    }

    return recovered;
  }

  private resumeUnfinishedTasksOnStartup(recoveredRunningTasks: Task[]): void {
    const candidates = this.buildStartupResumeCandidates(recoveredRunningTasks);
    if (candidates.length === 0) {
      return;
    }

    this.trackBackgroundWork((async () => {
      const task = candidates[0];
      this.appendStartupResumeLine(task.id);
      if (task.status === 'parked') {
        this.resumeParkedTaskIfStillParked(task.id);
      }
      await this.prepareTaskExecution(task.id, {
        userPrompt: task.goal,
        contextTaskId: task.id,
        executionMode: task.snapshots.length > 0 || task.lastInterruptionReason ? 'resume-parked' : 'fresh',
        origin: 'system',
        schedulingReason: '启动后恢复未完成任务',
      });
    })().finally(() => {
      this.notify();
    }));
  }

  private trackBackgroundWork(work: Promise<void>): void {
    this.backgroundWork.add(work);
    void work.finally(() => {
      this.backgroundWork.delete(work);
    });
  }

  private resumeParkedTaskIfStillParked(taskId: string): void {
    const latestTask = this.taskRuntimeService.findTask(taskId);
    if (latestTask?.status === 'parked') {
      this.taskRuntimeService.resumeParkedTask(taskId);
    }
  }

  private buildStartupResumeCandidates(recoveredRunningTasks: Task[]): Task[] {
    const byId = new Map<string, Task>();

    for (const task of recoveredRunningTasks) {
      byId.set(task.id, task);
    }

    for (const task of this.taskRuntimeService.listTasks()) {
      if (['created', 'ready'].includes(task.status) && !byId.has(task.id)) {
        byId.set(task.id, task);
      }
      if (
        task.status === 'parked'
        && task.prioritySignals.isReady
        && task.dependencies.every(dependency => dependency.status === 'resolved')
        && !byId.has(task.id)
      ) {
        byId.set(task.id, task);
      }
    }

    const recoveredIds = new Set(recoveredRunningTasks.map(task => task.id));
    return Array.from(byId.values()).sort((left, right) => {
      const leftRecovered = recoveredIds.has(left.id);
      const rightRecovered = recoveredIds.has(right.id);
      if (leftRecovered !== rightRecovered) {
        return leftRecovered ? -1 : 1;
      }

      return right.updatedAt.localeCompare(left.updatedAt);
    });
  }

  private appendStartupResumeLine(taskId: string): void {
    const task = this.taskRuntimeService.findTask(taskId);
    if (!task) {
      return;
    }

    this.appendOutput(
      task.snapshots.length > 0 || task.lastInterruptionReason
        ? `→ 启动后继续未完成任务 #${task.id}`
        : `→ 启动后恢复待执行任务 #${task.id}`,
    );
  }
}
