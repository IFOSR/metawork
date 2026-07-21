// Session facade that wires MetaClaw's task OS modules and exposes the user-facing session snapshot.
import type Database from 'better-sqlite3';
import type {
  Config,
  GuidanceActionType,
  GuidanceProposal,
  RuntimeState,
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
import { ResumeContextBuilder } from '../memory/resume-context-builder.js';
import { MemoryContextService } from '../memory/memory-context-service.js';
import { RecallReviewApplicationService, createDefaultRecallReviewApplicationService } from '../memory/recall-review-application-service.js';
import { SessionPersistenceService } from './session-persistence-service.js';
import { MemoryCaptureService } from '../memory/memory-capture-service.js';
import { createDefaultCommandCatalog } from '../commands/command-tree.js';
import { CommandReadServices } from '../commands/command-read-services.js';
import type { CommandCatalog, CommandCompletion, CommandContext } from '../commands/catalog.js';
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
import { KernelExecutionRuntime } from './session-execution-coordinator.js';
import { SessionTaskExecutionApplicationService } from './session-task-execution-application-service.js';
import { type QueuedExecutionRequest } from './session-helpers.js';
import { SubtaskRepo } from '../storage/subtask-repo.js';
import { TaskEventRepo } from '../storage/task-event-repo.js';
import { WorkUnitRepo } from '../storage/work-unit-repo.js';
import { WorkGraphRuntimeService } from '../execution/work-graph-runtime-service.js';
import { TaskExecutionEvidenceRepo } from '../execution/execution-evidence-port.js';
import { SubtaskAttemptRunner } from '../execution/subtask-attempt-runner.js';
import { contextRefKey } from '../work-graph/index.js';
import { isEligibleInteractionRef } from './assistant-reference-eligibility.js';
import { SubtaskHandoffRepo } from '../storage/subtask-handoff-repo.js';
import type { PlanningAgent } from '../planning/planning-agent.js';
import { PlanningContextBuilder } from '../planning/planning-context-builder.js';
import { createDefaultPlanningAgent } from '../planning/codex-planning-agent.js';
import type { PlanningAgentPlan } from '../planning/planning-types.js';
import { ControlKernel, type KernelEvent, type KernelSnapshot } from '../kernel/control-kernel.js';
import { DurableKernelWorkflow } from '../kernel/kernel-workflow.js';
import { KernelDecisionRepo } from '../storage/kernel-decision-repo.js';
import { KernelWorkflowRepo } from '../storage/kernel-workflow-repo.js';
import { SessionKernelRuntime } from './session-kernel-runtime.js';
import { PlannerRunRepo } from '../storage/planner-run-repo.js';
import { KernelExecutorStatusRepo } from '../storage/kernel-executor-status-repo.js';
import { KernelExecutorStatusProjector } from '../execution/kernel-executor-status-projector.js';
import { generateInteractionId } from '../utils/id.js';

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
  defaultExecutorFactory?: () => ExecutorAdapter;
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
  private currentTaskId: string | null = null;
  private focusContext: FocusContext | null = null;
  private readonly memoryContextService: MemoryContextService;
  private readonly commandCatalog: CommandCatalog;
  private readonly sessionStateRepo: SessionStateRepo;
  private readonly notifier: NotificationService;
  private readonly inputController: InputController;
  private readonly taskRuntimeService: TaskRuntimeService;
  private readonly executionRuntime: ExecutionRuntime;
  private readonly commandReadServices: CommandReadServices;
  private readonly verificationAndDeliveryService: VerificationAndDeliveryService;
  private readonly persistenceService: SessionPersistenceService;
  private readonly memoryCaptureService: MemoryCaptureService;
  private readonly recallReviewApplicationService: RecallReviewApplicationService;
  private readonly presentation: SessionPresentationService;
  private readonly agentClassService: AgentClassService;
  private readonly executorAdminService: ExecutorAdminService;
  private readonly executionProgressService: ExecutionProgressService;
  private readonly planningContextBuilder: PlanningContextBuilder;
  private readonly planningAgent: PlanningAgent;
  private readonly controlKernel: ControlKernel;
  private readonly kernelDecisionRepo: KernelDecisionRepo;
  private readonly kernelWorkflowRepo: KernelWorkflowRepo;
  private readonly workGraphRuntimeService: WorkGraphRuntimeService;
  private readonly subtaskRepo: SubtaskRepo;
  private readonly taskEventRepo: TaskEventRepo;
  private readonly workUnitClaimService: WorkUnitClaimService;
  private readonly workspaceTargetService: WorkspaceTargetService;
  private readonly kernelExecutionRuntime: KernelExecutionRuntime;
  private readonly taskExecutionApplicationService: SessionTaskExecutionApplicationService;
  private readonly sessionKernelRuntime: SessionKernelRuntime;
  private readonly kernelExecutorStatusRepo: KernelExecutorStatusRepo;

  constructor(private deps: MetaclawSessionDeps) {
    this.notifier = deps.notifier ?? new NoopNotificationService();
    this.sessionStateRepo = new SessionStateRepo(deps.db);
    this.taskRuntimeService = new TaskRuntimeService({
      taskEngine: deps.taskEngine,
      taskRepo: deps.taskEngine.getTaskRepo(),
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
      defaultExecutorFactory: deps.defaultExecutorFactory,
      executorFactory: deps.executorFactory,
    });
    this.executionRuntime = new ExecutionRuntime(executorRegistry, deps.executor);
    this.commandReadServices = new CommandReadServices(deps.db, this.executionRuntime);
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
      new TaskExecutionEvidenceRepo(deps.db),
    );
    this.workUnitClaimService = new WorkUnitClaimService(
      new WorkUnitRepo(deps.db),
      60_000,
      name => this.executionRuntime.isExecutorAvailable(name),
    );
    this.kernelExecutorStatusRepo = new KernelExecutorStatusRepo(deps.db);
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
    this.planningContextBuilder = new PlanningContextBuilder({
      sessionId: deps.sessionId,
      requestSource: 'session',
      getTimeoutMs: () => this.getPlannerTimeoutMs(),
    });
    this.planningAgent = deps.planningAgent ?? createDefaultPlanningAgent({
      audit: new PlannerRunRepo(deps.db),
    });
    this.controlKernel = new ControlKernel();
    this.kernelDecisionRepo = new KernelDecisionRepo(deps.db);
    this.kernelWorkflowRepo = new KernelWorkflowRepo(deps.db);
    this.commandCatalog = createDefaultCommandCatalog();
    this.inputController = new InputController({
      appendUserInput: (input: string) => this.appendUserInput(input),
      hasPendingExecutorRegisterWizard: () => this.executorAdminService.hasPendingWizard(),
      handlePendingExecutorRegisterWizard: (input: string) => this.handlePendingExecutorRegisterWizardInput(input),
      handleCommand: (input: string) => this.handleCommand(input),
      handleNaturalLanguageInput: (input: string) => this.handleNaturalLanguageInput(input),
      waitForAsyncWork: () => this.waitForAsyncWork(),
      handleSubmitError: (error: unknown) => this.appendOutput(`错误: ${(error as Error).message}`),
    });
    const attemptRunner = new SubtaskAttemptRunner({
      db: deps.db,
      sessionId: deps.sessionId,
      taskRuntimeService: this.taskRuntimeService,
      subtaskRepo: this.subtaskRepo,
      workUnitClaimService: this.workUnitClaimService,
      executionRuntime: this.executionRuntime,
      agentClassService: this.agentClassService,
    });
    this.kernelExecutionRuntime = new KernelExecutionRuntime({
      sessionId: deps.sessionId,
      orchestration: deps.orchestration,
      notifier: this.notifier,
      taskRuntimeService: this.taskRuntimeService,
      agentClassService: this.agentClassService,
      workGraphRuntimeService: this.workGraphRuntimeService,
      subtaskRepo: this.subtaskRepo,
      subtaskHandoffRepo: new SubtaskHandoffRepo(deps.db),
      taskEventRepo: this.taskEventRepo,
      workUnitClaimService: this.workUnitClaimService,
      attemptRunner,
      controlKernel: this.controlKernel,
      kernelWorkflowStore: this.kernelWorkflowRepo,
      executionProgressService: this.executionProgressService,
      verificationAndDeliveryService: this.verificationAndDeliveryService,
      persistenceService: this.persistenceService,
      memoryCaptureService: this.memoryCaptureService,
      kernelExecutorStatusProjector: new KernelExecutorStatusProjector(this.kernelExecutorStatusRepo),
      presentation: this.presentation,
      callbacks: {
        appendOutput: (...lines: string[]) => this.appendOutput(...lines),
        refreshRuntimeState: () => this.refreshRuntimeState(),
        appendTaskQueueSnapshot: trigger => this.appendTaskQueueSnapshot(trigger),
        setFocusContext: focus => this.setFocusContext(focus),
        setRunningExecutorName: (taskId, name) => this.setRunningExecutorName(taskId, name),
        clearRunningExecutorName: taskId => this.clearRunningExecutorName(taskId),
        persistSessionState: changes => this.persistSessionState(changes),
        setLatestGuidance: (scene, suggestion) => this.setLatestGuidance(scene, suggestion),
        queueProposal: (scene, proposal) => this.queueProposal(scene, proposal),
      },
    });
    this.taskExecutionApplicationService = new SessionTaskExecutionApplicationService({
      taskRuntimeService: this.taskRuntimeService,
      recallReviewApplicationService: this.recallReviewApplicationService,
      kernelExecutionRuntime: this.kernelExecutionRuntime,
      presentation: this.presentation,
      callbacks: {
        appendOutput: (...lines: string[]) => this.appendOutput(...lines),
        appendGuidance: (scene, suggestion) => this.appendGuidance(scene, suggestion),
        refreshRuntimeState: () => this.refreshRuntimeState(),
      },
    });
    this.sessionKernelRuntime = new SessionKernelRuntime({
      taskRuntimeService: this.taskRuntimeService,
      memoryContextService: this.memoryContextService,
      orchestration: deps.orchestration,
      activeExecutions: this.executionRuntime,
      presentation: this.presentation,
      callbacks: {
        appendOutput: (...lines: string[]) => this.appendOutput(...lines),
        deliverDirectReply: (userInput, reply) => this.deliverDirectReply(userInput, reply),
        prepareTaskExecution: (taskId, request) => this.prepareTaskExecution(taskId, request),
        refreshRuntimeState: () => this.refreshRuntimeState(),
        setCurrentTaskId: taskId => this.setCurrentTaskId(taskId),
        getCurrentTaskId: () => this.getCurrentTaskId(),
        setFocusContext: focus => this.setFocusContext(focus),
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
          `→ 检测到上次异常退出，任务 #${task.id} 已安全阻塞`,
          `→ 可执行 /task resume ${task.id} 提交显式恢复请求`,
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

    const candidates = this.kernelDecisionRepo.listCurrentByAction('wait_for_capacity');
    if (candidates.length === 0) {
      this.lastBlockedRecheckAt = nowMs;
      return false;
    }

    this.lastBlockedRecheckAt = nowMs;
    this.blockedRecheckInFlight = true;
    try {
      const target = candidates[0];
      if (!target?.taskId || !target.subtaskId) return false;
      return this.kernelExecutionRuntime.recheckCapacity({
        taskId: target.taskId,
        subtaskId: target.subtaskId,
        blockedDecisionId: target.id,
        blockedAt: target.createdAt,
        recheckAfterMs: intervalMs,
        occurredAt: new Date(nowMs).toISOString(),
      });
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

    this.refreshRuntimeState();
    return this.maybeEmitTaskPoolWatchdogReminder(nowMs);
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
    this.appendOutput('【MetaClaw｜理解用户请求】');
    const initialContext = await this.memoryContextService.preparePlanningInitialContext({
      sessionId: this.deps.sessionId,
      userInput,
      topK: this.deps.config.orchestration.top_k_preferences,
    });
    const context = this.planningContextBuilder.build({ userInput, initialContext });
    const plan = await this.planningAgent.plan(context);
    const event: KernelEvent = {
      schemaVersion: 1,
      type: 'plan_proposed',
      id: `plan_event_${plan.id}_${generateInteractionId()}`,
      correlationId: plan.id,
      causationId: null,
      occurredAt: new Date().toISOString(),
      sessionId: this.deps.sessionId,
      taskId: plan.task.taskId ?? undefined,
      proposal: plan,
    };
    const snapshot: KernelSnapshot = {
      schemaVersion: 1,
      type: 'plan_admission',
      tasks: this.taskRuntimeService.listTasks().map(task => ({ id: task.id, status: task.status })),
      runningTaskId: this.taskRuntimeService.getCurrentRunningTask()?.id ?? null,
      executorCatalog: context.executorCatalog,
      executorStatuses: this.kernelExecutorStatusRepo.list(),
      v4WorkGraphTaskIds: this.subtaskRepo.listTaskIds(),
      eligibleContextRefKeys: this.buildEligibleContextRefKeys(plan, userInput),
    };
    const workflow = new DurableKernelWorkflow({
      kernel: this.controlKernel,
      buildSnapshot: () => snapshot,
      store: this.kernelWorkflowRepo,
      clock: { now: () => new Date().toISOString() },
      runtime: this.sessionKernelRuntime.forInput(userInput),
    });
    await workflow.submit(event);
    return true;
  }

  private buildEligibleContextRefKeys(plan: PlanningAgentPlan, userInput: string): string[] {
    const refs = (plan.workGraph?.subtasks ?? []).flatMap(subtask => subtask.contextRefs);
    const targetTask = plan.task.taskId ? this.taskRuntimeService.findTask(plan.task.taskId) : null;
    const eligible = new Set<string>();
    for (const ref of refs) {
      if (ref.kind === 'current_user_input') {
        eligible.add(contextRefKey(ref));
        continue;
      }
      if (ref.kind === 'task_resource') {
        if (targetTask?.resources.includes(ref.locator) || (!targetTask && userInput.includes(ref.locator))) {
          eligible.add(contextRefKey(ref));
        }
        continue;
      }
      if (ref.kind === 'preference') {
        const row = this.deps.db.prepare('SELECT status FROM preferences WHERE id = ?').get(ref.preferenceId) as { status: string } | undefined;
        if (row?.status === 'confirmed') eligible.add(contextRefKey(ref));
        continue;
      }
      if (isEligibleInteractionRef({
        db: this.deps.db,
        sessionId: this.deps.sessionId,
        ref,
        targetTaskId: targetTask?.id ?? null,
        userInput,
      })) {
        eligible.add(contextRefKey(ref));
      }
    }
    return [...eligible];
  }

  private appendPlanningClarification(plan: PlanningAgentPlan): void {
    this.appendOutput(
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
    this.currentTaskId = taskId;
    this.notify();
  }

  private getCurrentTaskId(): string | null {
    return this.currentTaskId;
  }

  private refreshRuntimeState(): void {
    const tasks = this.taskRuntimeService.listTasks();
    const runningTask = tasks.find(task => task.status === 'running') ?? null;
    const schedulerState: RuntimeState = {
      runningTaskId: runningTask?.id ?? null,
      runningExecutorName: null,
      readyTaskIds: tasks.filter(task => task.status === 'ready').map(task => task.id),
      blockedTaskIds: tasks.filter(task => task.status === 'blocked').map(task => task.id),
      parkedTaskIds: tasks.filter(task => task.status === 'parked').map(task => task.id),
      lastEvent: this.runtimeState.lastEvent,
    };
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
      readServices: this.commandReadServices,
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
      '-> ControlKernel did not produce a runtime action.',
      'Please clarify whether you want to chat, create a new task, resume an existing task, or dispatch an executor.',
    );
  }

  private getPlannerTimeoutMs(): number {
    const configured = Number(process.env.METACLAW_PLANNER_TIMEOUT_MS);
    return Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_PLANNER_TIMEOUT_MS;
  }

  // Delivers the PlanningAgent's own answer for a direct_reply turn. The planner
  // runs read-only and already produced the user-visible reply, so we surface it
  // directly and record the interaction — no second (writable) executor call.
  // While the reply is being delivered we surface the planner as the active
  // executor in runtimeState (mirrors the conversation-runtime status main kept
  // for TUI/Feishu), then restore the scheduler-backed state afterwards.
  private deliverDirectReply(userInput: string, reply: string): void {
    this.setDirectReplyRuntimeState('planning-agent');
    try {
      this.appendOutput(reply);
      this.persistenceService.recordInteraction({
        taskId: null,
        sessionId: this.deps.sessionId,
        userInput,
        systemOutput: reply,
        executorUsed: 'planning-agent',
      });
      this.setFocusContext({ kind: 'conversation', taskId: null });
    } finally {
      this.setDirectReplyRuntimeState(null);
    }
  }

  // Sets/clears the runtime state for a direct-reply turn. When a durable task
  // is running we leave its state untouched (refresh only); otherwise we pin the
  // replying executor name and a descriptive lastEvent so the TUI status bar and
  // Feishu can show who is answering. Clearing passes null to restore.
  private setDirectReplyRuntimeState(executorName: string | null): void {
    this.refreshRuntimeState();
    const schedulerState = this.runtimeState;
    if (schedulerState.runningTaskId) {
      this.refreshRuntimeState();
      return;
    }

    this.runtimeState = {
      ...schedulerState,
      runningExecutorName: executorName,
      lastEvent: executorName
        ? `普通对话由 ${executorName} 生成回答`
        : schedulerState.lastEvent,
    };
    this.notify();
  }

  private setFocusContext(focus: FocusContext | null): void {
    this.focusContext = focus ? { ...focus } : null;
    if (focus?.kind === 'task' && focus.taskId) {
      this.persistSessionState({ lastFocusedTaskId: focus.taskId });
    }
  }

  private getFocusContext(): FocusContext | null {
    return this.focusContext ? { ...this.focusContext } : null;
  }

  private recoverOrphanedRunningTasks(): Task[] {
    const runningTasks = this.taskRuntimeService.listTasksByStatus('running');
    const recovered: Task[] = [];

    for (const task of runningTasks) {
      const interruptionReason = 'Metaclaw restarted with orphaned active work; explicit recovery is required';
      const subtasks = this.subtaskRepo.listByTask(task.id);
      const orphan = subtasks.find(subtask => subtask.status === 'running' || subtask.status === 'awaiting_decision') ?? null;
      const occurredAt = new Date().toISOString();
      const event: KernelEvent = {
        schemaVersion: 1,
        type: 'execution_outcome',
        id: `startup_orphan_${task.id}_${task.updatedAt.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        correlationId: task.id,
        causationId: null,
        occurredAt,
        sessionId: this.deps.sessionId,
        taskId: task.id,
        subtaskId: orphan?.id,
        terminalKind: 'failed',
        agentClassName: orphan?.preferredAgentClassList[0] ?? 'unknown',
        attemptKind: 'primary',
        sourceAttemptId: null,
        failure: {
          kind: 'heartbeat_lost',
          scope: 'agent_class',
          code: 'startup_orphaned_work',
          summary: interruptionReason,
        },
      };
      const snapshot: KernelSnapshot = {
        schemaVersion: 1,
        type: 'dispatch',
        task: { id: task.id, status: task.status },
        runningTaskId: task.id,
        graphState: 'ready',
        subtasks: subtasks.map(subtask => ({
          id: subtask.id,
          taskId: subtask.taskId,
          status: subtask.status,
          preferredAgentClassList: subtask.preferredAgentClassList,
        })),
        readyFrontier: [],
        attemptedAgentClasses: [],
        executorStatuses: this.kernelExecutorStatusRepo.list(),
        correctionSupportedAgentClasses: [],
        attempts: [],
        generationId: `generation_${task.id}_1`,
        graphRevision: 1,
        automaticReplansUsed: 1,
        recoverySafety: 'workspace_reconcilable',
        automaticRecoveryAllowed: false,
      };
      const decision = this.controlKernel.decide(event, snapshot);
      const issued = this.kernelDecisionRepo.issue({
        id: decision.id,
        schemaVersion: 1,
        eventId: event.id,
        eventType: event.type,
        correlationId: event.correlationId,
        causationId: event.causationId,
        sessionId: event.sessionId,
        taskId: task.id,
        subtaskId: orphan?.id ?? null,
        attemptId: null,
        event,
        snapshot,
        decision,
        action: decision.action.type,
        reason: decision.reason,
        createdAt: occurredAt,
      });
      if (!issued || decision.action.type !== 'block_work') continue;
      if (orphan && orphan.status !== 'blocked') {
        this.subtaskRepo.updateStatus(orphan.id, 'blocked', { error: interruptionReason });
      }
      this.taskRuntimeService.blockTask(task.id, {
        taskId: task.id,
        type: 'manual',
        description: interruptionReason,
        status: 'waiting',
      });
      this.taskRuntimeService.updateTask(task.id, {
        lastInterruptionReason: interruptionReason,
        interruptionCount: task.interruptionCount + 1,
      });
      const blockedTask = this.taskRuntimeService.findTask(task.id);
      if (blockedTask) {
        recovered.push(blockedTask);
      }
    }

    return recovered;
  }

  private setRunningExecutorName(taskId: string, name: string): void {
    this.runningExecutorNameByTask.set(taskId, name);
    this.runtimeState = { ...this.runtimeState, lastEvent: `Kernel dispatched ${name} for ${taskId}` };
    this.refreshRuntimeState();
  }

  private clearRunningExecutorName(taskId: string): void {
    this.runningExecutorNameByTask.delete(taskId);
    this.runtimeState = { ...this.runtimeState, lastEvent: `Kernel execution settled for ${taskId}` };
    this.refreshRuntimeState();
  }

  private trackBackgroundWork(work: Promise<void>): void {
    this.backgroundWork.add(work);
    void work.finally(() => {
      this.backgroundWork.delete(work);
    });
  }

}
