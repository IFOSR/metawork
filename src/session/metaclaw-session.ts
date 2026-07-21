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
import { WorkGraphRevisionRepo } from '../storage/work-graph-revision-repo.js';
import { TaskExecutionEvidenceRepo } from '../execution/execution-evidence-port.js';
import { SubtaskAttemptRunner } from '../execution/subtask-attempt-runner.js';
import { contextRefKey } from '../work-graph/index.js';
import { isEligibleInteractionRef } from './assistant-reference-eligibility.js';
import { SubtaskHandoffRepo } from '../storage/subtask-handoff-repo.js';
import type { PlanningAgent } from '../planning/planning-agent.js';
import { PlanningContextBuilder } from '../planning/planning-context-builder.js';
import { createDefaultPlanningAgent } from '../planning/codex-planning-agent.js';
import type { PlanningAgentPlan } from '../planning/planning-types.js';
import { ControlKernel, type KernelDecision, type KernelEvent, type KernelSnapshot } from '../kernel/control-kernel.js';
import { DurableKernelWorkflow } from '../kernel/kernel-workflow.js';
import { KernelDecisionRepo } from '../storage/kernel-decision-repo.js';
import { KernelWorkflowRepo } from '../storage/kernel-workflow-repo.js';
import { SessionKernelRuntime } from './session-kernel-runtime.js';
import { PlannerRunRepo } from '../storage/planner-run-repo.js';
import { KernelExecutorStatusRepo } from '../storage/kernel-executor-status-repo.js';
import { KernelExecutorStatusProjector } from '../execution/kernel-executor-status-projector.js';
import { generateInteractionId } from '../utils/id.js';
import { KernelEffectOutboxRepo } from '../storage/kernel-effect-outbox-repo.js';
import { ExecutorAttemptReceiptRepo } from '../storage/executor-attempt-receipt-repo.js';

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

function startupOrphanEvent(input: {
  sessionId: string;
  task: Task;
  subtaskId: string;
  attemptId: string;
  agentClassName: string;
  occurredAt: string;
}): Extract<KernelEvent, { type: 'execution_outcome' }> {
  return {
    schemaVersion: 2,
    type: 'execution_outcome',
    id: `startup_orphan_${input.attemptId}`,
    correlationId: input.task.id,
    causationId: input.attemptId,
    occurredAt: input.occurredAt,
    sessionId: input.sessionId,
    taskId: input.task.id,
    subtaskId: input.subtaskId,
    attemptId: input.attemptId,
    terminalKind: 'failed',
    agentClassName: input.agentClassName,
    attemptKind: 'primary',
    sourceAttemptId: null,
    failure: {
      kind: 'heartbeat_lost',
      scope: 'agent_class',
      code: 'startup_orphaned_work',
      summary: 'Metaclaw restarted with orphaned active work; explicit recovery is required',
    },
  };
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
  private initialization: Promise<void> | null = null;
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
  private readonly workGraphRevisionRepo: WorkGraphRevisionRepo;
  private readonly effectOutboxRepo: KernelEffectOutboxRepo;
  private readonly subtaskRepo: SubtaskRepo;
  private readonly taskEventRepo: TaskEventRepo;
  private readonly workUnitClaimService: WorkUnitClaimService;
  private readonly attemptRunner: SubtaskAttemptRunner;
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
    this.workGraphRevisionRepo = new WorkGraphRevisionRepo(deps.db);
    this.effectOutboxRepo = new KernelEffectOutboxRepo(deps.db);
    this.workGraphRuntimeService = new WorkGraphRuntimeService(
      this.subtaskRepo,
      this.taskEventRepo,
      this.workGraphRevisionRepo,
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
    this.attemptRunner = new SubtaskAttemptRunner({
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
      workGraphRevisionRepo: this.workGraphRevisionRepo,
      effectOutboxRepo: this.effectOutboxRepo,
      attemptReceiptRepo: new ExecutorAttemptReceiptRepo(deps.db),
      subtaskHandoffRepo: new SubtaskHandoffRepo(deps.db),
      taskEventRepo: this.taskEventRepo,
      workUnitClaimService: this.workUnitClaimService,
      attemptRunner: this.attemptRunner,
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
        requestReplan: decision => this.requestKernelReplan(decision),
        buildPlanAdmissionSnapshot: event => this.buildPlanAdmissionSnapshot(event),
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
    const recoveredRunningTasks: Task[] = [];

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
    this.initialization = resumeStartupTasks
      ? this.recoverDurableStartup().then(recovered => {
          for (const task of recovered) {
            this.appendOutput(
              `→ 检测到上次异常退出，任务 #${task.id} 已安全阻塞（由 Kernel 持久恢复收敛）`,
              `→ 可执行 /task recovery ${task.id} 查看不确定项`,
            );
          }
        })
      : Promise.resolve();
    this.refreshRuntimeState();
    this.notify();
  }

  async submit(
    rawInput: string,
    options: { awaitAsyncWork?: boolean } = {},
  ): Promise<{ exitRequested: boolean }> {
    await this.initialization;
    return this.inputController.submit(rawInput, options);
  }

  async waitForAsyncWork(): Promise<void> {
    await this.initialization;
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
    for (const task of this.taskRuntimeService.listTasksByStatus('blocked')) {
      if (await this.kernelExecutionRuntime.recoverDue(task.id, 'timer durable recovery drain')) return true;
    }
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
    const eventId = `plan_event_${plan.id}_${generateInteractionId()}`;
    const event: KernelEvent = {
      schemaVersion: 2,
      type: 'plan_proposed',
      id: eventId,
      correlationId: plan.id,
      causationId: null,
      occurredAt: new Date().toISOString(),
      sessionId: this.deps.sessionId,
      taskId: plan.task.taskId ?? undefined,
      proposal: plan,
      generationId: `generation_${eventId}`,
      proposalSource: 'initial',
      targetGraphRevision: 1,
    };
    const snapshot = this.buildPlanAdmissionSnapshot(event, context.executorCatalog, userInput);
    const workflow = new DurableKernelWorkflow({
      kernel: this.controlKernel,
      buildSnapshot: () => snapshot,
      store: this.kernelWorkflowRepo,
      clock: { now: () => new Date().toISOString() },
      runtime: this.sessionKernelRuntime.forInput(userInput),
      acceptedEventTypes: ['plan_proposed'],
      acceptedActions: [
        'reject_request', 'request_clarification', 'deliver_direct_reply', 'no_op',
        'authorize_task_plan', 'authorize_task_control', 'block_work', 'park_for_replan',
      ],
    });
    await workflow.submit(event);
    return true;
  }

  private async requestKernelReplan(
    decision: KernelDecision & {
      action: Extract<KernelDecision['action'], { type: 'request_replan' }>;
    },
  ): Promise<Extract<KernelEvent, { type: 'plan_proposed' }>> {
    const task = this.taskRuntimeService.findTask(decision.action.taskId);
    if (!task) throw new Error(`replan Task not found: ${decision.action.taskId}`);
    this.workGraphRuntimeService.materializeCompletedEvidence(task.id, decision.action.sourceRevision);
    const evidence = this.deps.db.prepare(`
      SELECT id, title, content FROM task_execution_evidence
      WHERE task_id = ? AND kind = 'task_evidence'
      ORDER BY created_at ASC, id ASC
    `).all(task.id) as Array<{ id: string; title: string; content: string }>;
    const failures = this.deps.db.prepare(`
      SELECT attempt_id, agent_class_name, terminal_state, failure_json, error_code, error_detail
      FROM executor_attempt_receipts
      WHERE task_id = ? AND graph_revision = ? AND terminal_state <> 'completed'
      ORDER BY completed_at ASC, attempt_id ASC
    `).all(task.id, decision.action.sourceRevision) as Array<Record<string, unknown>>;
    const request = [
      'Produce a replan for the remaining work of the existing Task. Return plan_work_graph only.',
      `Task id: ${task.id}`,
      `Task goal: ${task.goal}`,
      `Generation: ${decision.action.generationId}`,
      `Superseded revision: ${decision.action.sourceRevision}`,
      'The new graph must describe only remaining work and may reference the task_evidence IDs below.',
      `Completed evidence: ${JSON.stringify(evidence.map(item => ({
        evidenceId: item.id,
        title: item.title,
        summary: item.content.slice(0, 2_000),
      })))}`,
      `Structured failures and attempted candidates: ${JSON.stringify(failures.map(item => ({
        attemptId: item.attempt_id,
        agentClassName: item.agent_class_name,
        terminalState: item.terminal_state,
        failure: item.failure_json ? JSON.parse(String(item.failure_json)) : null,
        code: item.error_code,
        summary: String(item.error_detail ?? '').slice(0, 1_000),
      })))}`,
      'Bind the proposal to the exact existing Task id. Do not include raw Executor responses.',
    ].join('\n\n').slice(0, 24_000);
    const context = this.planningContextBuilder.build({
      userInput: request,
      initialContext: { longTermMemories: [], conversationHistory: [] },
    });
    const plan = await this.planningAgent.plan(context);
    return {
      schemaVersion: 2,
      type: 'plan_proposed',
      id: `replan_event_${decision.id}`,
      correlationId: decision.eventId,
      causationId: decision.id,
      occurredAt: new Date().toISOString(),
      sessionId: this.deps.sessionId,
      taskId: task.id,
      proposal: plan,
      generationId: decision.action.generationId,
      proposalSource: 'replan',
      targetGraphRevision: decision.action.sourceRevision + 1,
    };
  }

  private buildPlanAdmissionSnapshot(
    event: Extract<KernelEvent, { type: 'plan_proposed' }>,
    executorCatalog = this.planningContextBuilder.build({ userInput: '' }).executorCatalog,
    userInput = event.proposal.task.goal ?? '',
  ): Extract<KernelSnapshot, { type: 'plan_admission' }> {
    return {
      schemaVersion: 2,
      type: 'plan_admission',
      tasks: this.taskRuntimeService.listTasks().map(task => ({ id: task.id, status: task.status })),
      runningTaskId: this.taskRuntimeService.getCurrentRunningTask()?.id ?? null,
      executorCatalog,
      executorStatuses: this.kernelExecutorStatusRepo.list(),
      v5WorkGraphTaskIds: this.subtaskRepo.listTaskIds(),
      eligibleContextRefKeys: this.buildEligibleContextRefKeys(event.proposal as PlanningAgentPlan, userInput),
    };
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
      if (ref.kind === 'task_evidence') {
        const row = this.deps.db.prepare(`
          SELECT id FROM task_execution_evidence WHERE id = ? AND task_id = ? AND kind = 'task_evidence'
        `).get(ref.evidenceId, targetTask?.id ?? '') as { id: string } | undefined;
        if (row) eligible.add(contextRefKey(ref));
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

    if (result.type === 'directive' && result.directive.kind === 'show-task-recovery') {
      this.appendOutput(this.formatTaskRecovery(result.directive.taskId));
    }

    if (result.type === 'directive' && result.directive.kind === 'resolve-task-recovery') {
      await this.resolveTaskRecovery(result.directive);
    }

    return false;
  }

  private formatTaskRecovery(taskId: string): string {
    const applications = this.kernelWorkflowRepo.listRecoveryItems(taskId).map(item =>
      `- ${item.id} [application/${item.status}] ${item.decision.action.type}: ${item.errorSummary ?? 'no error summary'}`
    );
    const effects = this.effectOutboxRepo.listRecoveryItems(taskId).map(item =>
      `- ${item.id} [effect/${item.status}] ${item.effectType}: ${item.errorSummary ?? 'no error summary'}`
    );
    const items = [...applications, ...effects];
    return items.length > 0
      ? `Task #${taskId} recovery items:\n${items.join('\n')}`
      : `Task #${taskId} has no uncertain or failed recovery items.`;
  }

  private async resolveTaskRecovery(input: {
    taskId: string;
    recoveryItemId: string;
    resolution: 'assume_applied' | 'retry';
  }): Promise<void> {
    const event: Extract<KernelEvent, { type: 'recovery_resolution_requested' }> = {
      schemaVersion: 2,
      type: 'recovery_resolution_requested',
      id: `recovery_event_${input.recoveryItemId}_${generateInteractionId()}`,
      correlationId: input.taskId,
      causationId: null,
      occurredAt: new Date().toISOString(),
      sessionId: this.deps.sessionId,
      taskId: input.taskId,
      recoveryItemId: input.recoveryItemId,
      resolution: input.resolution,
    };
    const workflow = new DurableKernelWorkflow({
      kernel: this.controlKernel,
      buildSnapshot: () => this.buildRecoverySnapshot(input.taskId, input.recoveryItemId),
      store: this.kernelWorkflowRepo,
      clock: { now: () => new Date().toISOString() },
      runtime: {
        apply: async decision => {
          if (decision.action.type === 'resolve_recovery') {
            const now = new Date().toISOString();
            if (this.kernelWorkflowRepo.findRecoveryItem(decision.action.recoveryItemId)) {
              this.kernelWorkflowRepo.resolveRecoveryItem(
                decision.action.recoveryItemId, decision.action.resolution, now,
              );
            } else {
              this.effectOutboxRepo.resolve(
                decision.action.recoveryItemId, decision.action.resolution, now,
              );
            }
            return null;
          }
          if (decision.action.type === 'block_work') {
            this.appendOutput(`Recovery blocked: ${decision.reason}`);
            return null;
          }
          throw new Error(`manual recovery Runtime cannot apply ${decision.action.type}`);
        },
      },
      acceptedEventTypes: ['recovery_resolution_requested'],
      acceptedActions: ['resolve_recovery', 'block_work'],
      taskId: input.taskId,
    });
    await workflow.submit(event);
    this.appendOutput(this.formatTaskRecovery(input.taskId));
  }

  private buildRecoverySnapshot(
    taskId: string,
    recoveryItemId: string,
  ): Extract<KernelSnapshot, { type: 'recovery' }> {
    const task = this.taskRuntimeService.findTask(taskId);
    const application = this.kernelWorkflowRepo.findRecoveryItem(recoveryItemId);
    const effect = this.effectOutboxRepo.find(recoveryItemId);
    return {
      schemaVersion: 2,
      type: 'recovery',
      task: task ? { id: task.id, status: task.status } : null,
      item: application
        ? { id: application.id, kind: 'application', status: application.status as 'uncertain' | 'failed', retrySafe: true }
        : effect && (effect.status === 'uncertain' || effect.status === 'failed')
          ? { id: effect.id, kind: 'effect', status: effect.status, retrySafe: false }
          : null,
    };
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

  private async recoverDurableStartup(): Promise<Task[]> {
    const now = new Date().toISOString();
    this.effectOutboxRepo.reconcileSending(now);
    this.kernelWorkflowRepo.reconcileProcessing();
    for (const effect of this.effectOutboxRepo.listPending(now)) {
      if (effect.effectType !== 'task_completion_notification') continue;
      await this.effectOutboxRepo.deliver(effect.id, async record => {
        await this.verificationAndDeliveryService.deliverTaskCompletion(
          this.notifier,
          record.payload as unknown as Parameters<VerificationAndDeliveryService['deliverTaskCompletion']>[1],
        );
        return effect.id;
      }, () => new Date().toISOString());
    }

    const planningWorkflow = new DurableKernelWorkflow({
      kernel: this.controlKernel,
      buildSnapshot: event => this.buildPlanAdmissionSnapshot(
        event as Extract<KernelEvent, { type: 'plan_proposed' }>,
      ),
      store: this.kernelWorkflowRepo,
      runtime: this.sessionKernelRuntime.forInput(''),
      clock: { now: () => new Date().toISOString() },
      acceptedEventTypes: ['plan_proposed'],
      acceptedActions: [
        'reject_request', 'request_clarification', 'deliver_direct_reply', 'no_op',
        'authorize_task_plan', 'authorize_task_control', 'block_work', 'park_for_replan',
      ],
    });
    await planningWorkflow.recover();

    const claimedOrphans = this.workUnitClaimService.reconcileOrphanedClaims();
    const recovered: Task[] = [];
    for (const task of this.taskRuntimeService.listTasksByStatus('running')) {
      const activeSubtasks = this.subtaskRepo.listActiveByTask(task.id);
      const subtasks = activeSubtasks.length > 0 ? activeSubtasks : this.subtaskRepo.listByTask(task.id);
      const taskClaims = claimedOrphans.filter(workUnit => workUnit.claimedTaskId === task.id);
      for (const workUnit of taskClaims) {
        if (!workUnit.claimedSubtaskId || !workUnit.claimedAttemptId) continue;
        this.attemptRunner.landHeartbeatLost({
          attemptId: workUnit.claimedAttemptId,
          executionId: `startup_${workUnit.claimedAttemptId}`,
          taskId: task.id,
          subtaskId: workUnit.claimedSubtaskId,
          workUnitId: workUnit.id,
          agentClassName: workUnit.agentClassName,
        });
        this.kernelWorkflowRepo.enqueue(startupOrphanEvent({
          sessionId: this.deps.sessionId,
          task,
          subtaskId: workUnit.claimedSubtaskId,
          attemptId: workUnit.claimedAttemptId,
          agentClassName: workUnit.agentClassName,
          occurredAt: now,
        }));
      }
      if (taskClaims.length === 0 && !this.kernelWorkflowRepo.hasRecoverableWork(task.id)) {
        const orphan = subtasks.find(subtask => !['done', 'cancelled'].includes(subtask.status));
        if (orphan) {
          this.kernelWorkflowRepo.enqueue(startupOrphanEvent({
            sessionId: this.deps.sessionId,
            task,
            subtaskId: orphan.id,
            attemptId: `startup_missing_${task.id}_${orphan.id}`,
            agentClassName: orphan.preferredAgentClassList[0] ?? 'unknown',
            occurredAt: now,
          }));
        }
      }
      await this.kernelExecutionRuntime.recoverDue(task.id, 'startup durable recovery');
      const current = this.taskRuntimeService.findTask(task.id);
      if (current) recovered.push(current);
    }
    for (const task of this.taskRuntimeService.listTasksByStatus('blocked')) {
      if (recovered.some(item => item.id === task.id)) continue;
      await this.kernelExecutionRuntime.recoverDue(task.id, 'startup due-event drain');
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
