/**
 * ConversationSession（ADR-0031 第 2、7 节）。
 *
 * 一个 Conversation 的实时应用外壳对象。它拥有稳定的 Planner 会话身份、
 * 串行输入邮箱、输出/轨迹投影、聚焦状态与客户端附着；通过
 * ConversationRuntimePort 访问账户事实，不拥有 Kernel、调度、恢复或
 * Executor 服务。
 *
 * 本文件逐步接管 MetaclawSession 的 conversation-facing 行为。当前实现
 * 基础状态（output/currentTaskId/runtimeState/focus/listeners）与基础
 * callbacks（appendOutput/setCurrentTaskId/getCurrentTaskId/refreshRuntimeState）。
 */

import type { GuidanceProposal, RuntimeState } from '../core/types.js';
import type { Config } from '../core/types.js';
import type { Task, TaskRecoveryTrigger } from '../core/types.js';
import type { SessionTaskExecutionApplicationService } from './session-task-execution-application-service.js';
import type { QueuedExecutionRequest } from './session-helpers.js';
import type { TaskEngine } from '../task/task-engine.js';
import type { MemoryEngine } from '../memory/memory-engine.js';
import type { OrchestrationEngine } from '../guidance/orchestration.js';
import type { CommandCatalog, CommandContext } from '../commands/catalog.js';
import type { CommandReadServices } from '../commands/command-read-services.js';
import type { SessionPresentationService, GuidanceState } from './session-presentation-service.js';
import type { SessionStateRepo } from '../storage/session-state-repo.js';
import type { SessionPersistenceService } from './session-persistence-service.js';
import type { InteractionTraceStream } from './interaction-trace-stream.js';
import type { KernelDecision, KernelEvent, KernelSnapshot } from '../kernel/control-kernel.js';
import type { KernelExecutionRuntime } from '../execution/kernel-execution-runtime.js';
import type { PlanningContextBuilder } from '../planning/planning-context-builder.js';
import type { PlanningContext } from '../planning/planning-types.js';
import type { PlannerProposalResult } from '../planning/planner-proposal.js';
import type Database from 'better-sqlite3';
import type { KernelConfigurationView } from '../configuration/index.js';
import { DurableKernelWorkflow } from '../kernel/kernel-workflow.js';
import { generateInteractionId } from '../utils/id.js';
import type { SessionKernelRuntime } from './session-kernel-runtime.js';
import type { PlanningAgentPlan } from '../planning/planning-types.js';
import {
  ConversationInputMailbox,
  type MailboxCommand,
  type MailboxReceipt,
} from './conversation-input-mailbox.js';
import { InputController, type InputControllerSubmitOptions } from './input-controller.js';
import type { ConversationRuntimePort } from './conversation-runtime-port.js';

export interface ConversationSessionSnapshot {
  readonly output: string[];
  readonly currentTaskId: string | null;
  readonly runtimeState: RuntimeState;
  readonly plannerState: { readonly status: 'idle' | 'running' };
}

export interface ConversationSessionDeps {
  readonly conversationId: string;
  readonly plannerSessionId: string;
  readonly runtimePort: ConversationRuntimePort;
  readonly mailbox: ConversationInputMailbox;
  readonly presentation?: SessionPresentationService;
  readonly sessionStateRepo?: SessionStateRepo;
  readonly persistenceService?: SessionPersistenceService;
  readonly interactionTraceStream?: InteractionTraceStream;
  readonly kernelExecutionRuntime?: KernelExecutionRuntime;
  readonly planningContextBuilder?: PlanningContextBuilder;
  readonly db?: Database.Database;
  readonly kernelConfiguration?: KernelConfigurationView;
  readonly sessionKernelRuntime?: SessionKernelRuntime;
  readonly executeUserInput?: (text: string) => Promise<{ exitRequested: boolean }>;
  readonly handleCommand?: (input: string) => Promise<boolean>;
  readonly commandCatalog?: CommandCatalog;
  readonly commandReadServices?: CommandReadServices;
  readonly taskEngine?: TaskEngine;
  readonly memoryEngine?: MemoryEngine;
  readonly orchestration?: OrchestrationEngine;
  readonly config?: Config;
  readonly taskExecutionApplicationService?: SessionTaskExecutionApplicationService;
  readonly directiveExecutor?: (directive: unknown, userInput: string) => Promise<void>;
  readonly dispose?: () => Promise<void>;
}

export class ConversationSession {
  private output: string[] = [];
  private currentTaskId: string | null = null;
  private runtimeState: RuntimeState = {
    runningTaskId: null,
    runningExecutorName: null,
    readyTaskIds: [],
    blockedTaskIds: [],
    parkedTaskIds: [],
    lastEvent: null,
  };
  private focusContext: { kind: 'conversation' | 'task'; taskId: string | null } | null = null;
  private activePlannerRuns = 0;
  private latestGuidance: GuidanceState | null = null;
  private runningExecutorsByAttempt = new Map<string, { taskId: string; subtaskId: string; name: string }>();
  private backgroundWork = new Set<Promise<void>>();
  private kernelExecutionRuntime: KernelExecutionRuntime | null = null;
  private readonly inputController: InputController;
  private listeners = new Set<(snapshot: ConversationSessionSnapshot) => void>();
  private attachedClients = 0;

  constructor(private readonly deps: ConversationSessionDeps) {
    this.kernelExecutionRuntime = deps.kernelExecutionRuntime ?? null;
    this.inputController = new InputController({
      appendUserInput: input => this.appendOutput('', `> ${input}`),
      handleCommand: input => this.handleCommand(input),
      handleNaturalLanguageInput: input => this.handleNaturalLanguageInput(input),
      waitForAsyncWork: async () => { await this.waitForBackgroundWork(); },
      handleSubmitError: error => this.appendOutput(`错误: ${(error as Error).message}`),
    });
  }

  get conversationId(): string {
    return this.deps.conversationId;
  }

  get plannerSessionId(): string {
    return this.deps.plannerSessionId;
  }

  get accountId(): string {
    return this.deps.runtimePort.accountId;
  }

  attachClient(): void {
    this.attachedClients += 1;
  }

  detachClient(): void {
    this.attachedClients = Math.max(0, this.attachedClients - 1);
  }

  get attachedClientCount(): number {
    return this.attachedClients;
  }

  appendOutput(...lines: string[]): void {
    if (lines.length === 0) return;
    this.output.push(...lines);
    this.notify();
  }

  getOutput(): readonly string[] {
    return [...this.output];
  }

  setCurrentTaskId(taskId: string | null): void {
    this.currentTaskId = taskId;
    this.notify();
  }

  getCurrentTaskId(): string | null {
    return this.currentTaskId;
  }

  setFocusContext(focus: { kind: 'conversation' | 'task'; taskId: string | null } | null): void {
    this.focusContext = focus;
    if (focus?.kind === 'task' && focus.taskId) {
      this.persistSessionState({ lastFocusedTaskId: focus.taskId });
    }
  }

  getFocusContext(): { kind: 'conversation' | 'task'; taskId: string | null } | null {
    return this.focusContext;
  }

  setLatestGuidance(
    scene: string,
    suggestion: { taskId: string; recommendedAction: string; reasons: string[] },
  ): GuidanceState | null {
    if (!this.deps.presentation) return null;
    this.latestGuidance = this.deps.presentation.buildGuidanceState(
      scene,
      suggestion,
      this.deps.runtimePort.taskServices?.taskRuntimeService.findTask(suggestion.taskId)?.title ?? '',
    );
    return this.latestGuidance;
  }

  appendGuidance(
    scene: string,
    suggestion: { taskId: string; recommendedAction: string; reasons: string[] },
  ): void {
    this.setLatestGuidance(scene, suggestion);
    if (!this.deps.presentation) return;
    this.appendOutput(
      ...this.deps.presentation.formatGuidanceBlock(scene, suggestion, this.latestGuidance?.taskTitle ?? ''),
    );
  }

  queueProposal(scene: string, proposal: GuidanceProposal): void {
    if (!this.deps.presentation) return;
    this.appendOutput(...this.deps.presentation.formatProposalBlock(
      scene,
      proposal,
      proposal.taskId
        ? this.deps.runtimePort.taskServices?.taskRuntimeService.findTask(proposal.taskId)?.title ?? ''
        : '',
    ));
    this.appendOutput('→ 操作提案已记录，不等待用户确认；满足执行条件的任务由调度器自动处理');
  }

  persistSessionState(changes: {
    lastFocusedTaskId?: string | null;
    lastCompletedTaskId?: string | null;
    lastSessionId?: string | null;
  }): void {
    this.deps.sessionStateRepo?.upsert(changes);
  }

  resolveRequestText(eventId: string): string {
    const event = this.deps.runtimePort.kernelServices.kernelWorkflowRepo.findEvent(eventId);
    return event?.type === 'plan_proposed' ? event.requestText : '';
  }

  setRunningExecutorName(taskId: string, subtaskId: string, attemptId: string, name: string): void {
    this.runningExecutorsByAttempt.set(attemptId, { taskId, subtaskId, name });
  }

  bindKernelExecutionRuntime(runtime: KernelExecutionRuntime): void {
    this.kernelExecutionRuntime = runtime;
  }

  recordKernelDecisionTrace(decision: KernelDecision): void {
    this.deps.interactionTraceStream?.append({
      phase: 'kernel',
      actor: 'kernel',
      kind: 'kernel_decision',
      status: 'completed',
      title: 'Kernel decision',
      summary: decision.reason,
      details: {},
      eventKey: 'kernel_decision',
    } as never);
  }

  async cancelTask(taskId: string, reason: string): Promise<void> {
    await this.kernelExecutionRuntime?.cancelTask(taskId, reason);
  }

  buildPlanningContext(userInput: string): PlanningContext | null {
    if (!this.deps.planningContextBuilder) return null;
    const permissionRepository = this.deps.runtimePort.workspaceServices.permissionRepository;
    const pendingPermission = permissionRepository.findOldestPending();
    return this.deps.planningContextBuilder.build({
      userInput,
      pendingAuthorizationRequest: pendingPermission
        ? {
            requestId: pendingPermission.request.id,
            taskId: pendingPermission.request.taskId,
            capability: pendingPermission.request.capability,
            resource: pendingPermission.request.resource,
            operation: pendingPermission.request.operation,
            reason: pendingPermission.request.reason,
          }
        : null,
    });
  }

  buildPlanAdmissionSnapshot(
    event: Extract<KernelEvent, { type: 'plan_proposed' }>,
  ): Extract<KernelSnapshot, { type: 'plan_admission' }> | null {
    const port = this.deps.runtimePort;
    const plannerConfiguration = this.deps.planningContextBuilder?.getPlannerConfiguration();
    if (!plannerConfiguration || !this.deps.kernelConfiguration) return null;
    if (
      event.configurationRevision !== plannerConfiguration.revisionId
      || event.configurationRevision !== this.deps.kernelConfiguration.revisionId
    ) {
      throw new Error(`plan admission configuration revision mismatch: ${event.configurationRevision}`);
    }
    return {
      schemaVersion: 5,
      type: 'plan_admission',
      tasks: port.taskServices?.taskRuntimeService.listTasks().map(task => ({ id: task.id, status: task.status })) ?? [],
      runningTaskId: this.kernelExecutionRuntime?.getSingleActiveTaskId() ?? null,
      plannerConfiguration,
      kernelConfiguration: this.deps.kernelConfiguration,
      executorStatuses: port.repositories.kernelExecutorStatusRepo.list(event.configurationRevision),
      v5WorkGraphTaskIds: port.repositories.subtaskRepo.listTaskIds(),
      eligibleContextRefKeys: [],
      pendingAuthorizationRequest: (() => {
        const pending = port.workspaceServices.permissionRepository.findOldestPending();
        return pending ? { requestId: pending.request.id, taskId: pending.request.taskId } : null;
      })(),
    };
  }

  async handleNaturalLanguageInput(userInput: string): Promise<void> {
    const handled = await this.handlePlanningKernelDecision(userInput);
    if (handled) return;
    this.appendOutput(
      '-> ControlKernel did not produce a runtime action.',
      'Please clarify whether you want to chat, create a new task, resume an existing task, or dispatch an executor.',
    );
  }

  private async handlePlanningKernelDecision(userInput: string): Promise<boolean> {
    const planningAgent = this.deps.runtimePort.plannerServices?.planningAgent;
    if (!planningAgent) return false;
    const context = this.buildPlanningContext(userInput);
    if (!context) return false;
    const result = await planningAgent.submit(context, {
      submit: async plan => this.submitPlannerProposal(userInput, plan, context),
    });
    return result.status === 'accepted';
  }

  private async submitPlannerProposal(
    userInput: string,
    plan: PlanningAgentPlan,
    context: PlanningContext,
  ): Promise<PlannerProposalResult> {
    const port = this.deps.runtimePort;
    const sessionKernelRuntime = this.deps.sessionKernelRuntime;
    if (!sessionKernelRuntime) {
      if (this.deps.executeUserInput) {
        await this.deps.executeUserInput(userInput);
      }
      return { status: 'accepted' } as PlannerProposalResult;
    }

    const eventId = `plan_event_${plan.id}_${generateInteractionId()}`;
    const event: KernelEvent = {
      schemaVersion: 5,
      configurationRevision: context.configuration.revisionId,
      type: 'plan_proposed',
      id: eventId,
      correlationId: plan.id,
      causationId: null,
      occurredAt: new Date().toISOString(),
      sessionId: this.deps.plannerSessionId,
      taskId: plan.task.taskId ?? undefined,
      proposal: plan,
      requestText: userInput.slice(0, 24_000),
      generationId: `generation_${eventId}`,
      proposalSource: 'initial',
      targetGraphRevision: 1,
    };
    const workflow = new DurableKernelWorkflow({
      kernel: port.kernelServices.controlKernel,
      buildSnapshot: claimed => this.buildPlanAdmissionSnapshot(
        claimed as Extract<KernelEvent, { type: 'plan_proposed' }>,
      )!,
      store: port.kernelServices.kernelWorkflowRepo,
      clock: { now: () => new Date().toISOString() },
      runtime: sessionKernelRuntime.forInput(userInput),
      acceptedEventTypes: ['plan_proposed'],
      acceptedActions: [
        'reject_request', 'request_clarification', 'deliver_direct_reply', 'no_op',
        'authorize_task_plan', 'authorize_task_control', 'block_work', 'park_for_replan',
        'record_permission_resolution',
      ],
    });
    await workflow.submit(event);
    return { status: 'accepted' } as PlannerProposalResult;
  }

  clearRunningExecutorName(_taskId: string, attemptId: string): void {
    this.runningExecutorsByAttempt.delete(attemptId);
  }

  startBackgroundExecution(_taskId: string, launch: () => Promise<void>): void {
    const promise = launch()
      .catch(() => undefined)
      .finally(() => {
        this.backgroundWork.delete(promise);
      });
    this.backgroundWork.add(promise);
  }

  deliverDirectReply(userInput: string, reply: string): void {
    this.setDirectReplyRuntimeState('planning-agent');
    try {
      this.deps.interactionTraceStream?.append({
        phase: 'delivery',
        actor: 'runtime',
        kind: 'delivery_completed',
        status: 'completed',
        title: 'Final answer delivered',
        summary: 'The Planner answer passed Kernel authorization and was delivered.',
        details: { executor: 'planning-agent' },
        eventKey: 'direct_reply',
        traceStatus: 'completed',
      } as never);
      this.appendOutput(reply);
      this.deps.persistenceService?.recordInteraction({
        taskId: null,
        sessionId: this.deps.plannerSessionId,
        userInput,
        systemOutput: reply,
        executorUsed: 'planning-agent',
      });
      this.setFocusContext({ kind: 'conversation', taskId: null });
    } finally {
      this.setDirectReplyRuntimeState(null);
    }
  }

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

  refreshRuntimeState(): void {
    const taskRuntimeService = this.deps.runtimePort.taskServices?.taskRuntimeService;
    if (!taskRuntimeService) return;
    const tasks = taskRuntimeService.listTasks();
    const runningTask = tasks.find(task => task.status === 'running') ?? null;
    this.runtimeState = {
      runningTaskId: runningTask?.id ?? null,
      runningExecutorName: null,
      readyTaskIds: tasks.filter(task => task.status === 'ready').map(task => task.id),
      blockedTaskIds: tasks.filter(task => task.status === 'blocked').map(task => task.id),
      parkedTaskIds: tasks.filter(task => task.status === 'parked').map(task => task.id),
      lastEvent: this.runtimeState.lastEvent,
    };
    this.notify();
  }

  subscribe(listener: (snapshot: ConversationSessionSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): ConversationSessionSnapshot {
    return {
      output: [...this.output],
      currentTaskId: this.currentTaskId,
      runtimeState: {
        ...this.runtimeState,
        readyTaskIds: [...this.runtimeState.readyTaskIds],
        blockedTaskIds: [...this.runtimeState.blockedTaskIds],
        parkedTaskIds: [...this.runtimeState.parkedTaskIds],
      },
      plannerState: {
        status: this.activePlannerRuns > 0 ? 'running' : 'idle',
      },
    };
  }

  submit(command: MailboxCommand): MailboxReceipt {
    return this.deps.mailbox.submit(command);
  }

  /**
   * 提交用户输入并触发 Planner 回合（通过注入的执行委托）。委托由调用方
   * （当前 MetaclawSession，未来 AccountRuntime 内联）提供。
   */
  async submitUserInput(text: string): Promise<{ exitRequested: boolean }> {
    return this.inputController.submit(text);
  }

  private async handleCommand(input: string): Promise<boolean> {
    // 命令处理由调用方注入（当前 MetaclawSession.handleCommand 桥接）时优先使用；
    // 否则降级为内联 commandCatalog 执行。
    if (this.deps.handleCommand) {
      return this.deps.handleCommand(input);
    }
    const commandCatalog = this.deps.commandCatalog;
    if (!commandCatalog) {
      this.appendOutput(`命令不受支持（Conversation 外壳未接入命令处理）: ${input}`);
      return false;
    }
    const executorRecoveryRefreshService = this.deps.runtimePort.coordinatorServices?.executorRecoveryRefreshService;
    if (/^\/task\s+(resume|recover|recovery)\b/iu.test(input)) {
      await executorRecoveryRefreshService?.refresh({ trigger: 'task_recovery' });
    }
    const result = await commandCatalog.execute(input, this.getCommandContext());
    this.appendOutput(result.content);
    if (/^\/executor\s+(register|unregister)\b/iu.test(input)) {
      await executorRecoveryRefreshService?.refresh({ trigger: 'executor_changed' });
    }
    if (result.type === 'exit') {
      this.persistSessionState({ lastSessionId: this.deps.plannerSessionId });
      return true;
    }
    if (result.type === 'directive') {
      const directive = result.directive as {
        kind: string;
        taskId?: string;
        recoveryItemId?: string;
        resolution?: string;
        mode?: 'resume-parked' | 'resume-blocked';
        newlyProvidedResources?: string[];
        blockedReason?: string;
      };
      if (directive.kind === 'show-task-recovery' && directive.taskId) {
        this.appendOutput(this.formatTaskRecovery(directive.taskId));
      } else if (directive.kind === 'resolve-task-recovery' && directive.taskId && directive.recoveryItemId) {
        await this.resolveTaskRecovery({
          taskId: directive.taskId,
          recoveryItemId: directive.recoveryItemId,
          resolution: directive.resolution as 'assume_applied' | 'retry',
        });
      } else if (directive.kind === 'resume-task' && directive.taskId) {
        await this.resumeTask(directive.taskId, input, directive);
      } else {
        await this.deps.directiveExecutor?.(result.directive, input);
      }
    }
    return false;
  }

  private async resumeTask(
    taskId: string,
    userInput: string,
    directive: {
      mode?: 'resume-parked' | 'resume-blocked';
      newlyProvidedResources?: string[];
      blockedReason?: string;
    },
  ): Promise<void> {
    const taskRuntimeService = this.deps.runtimePort.taskServices?.taskRuntimeService;
    const taskExecutionApplicationService = this.deps.taskExecutionApplicationService;
    if (!taskRuntimeService || !taskExecutionApplicationService) return;
    const resumedTask = taskRuntimeService.findTask(taskId);
    if (!resumedTask) return;
    this.setCurrentTaskId(resumedTask.id);
    taskExecutionApplicationService.prepareTaskExecution(resumedTask.id, {
      userPrompt: resumedTask.goal,
      contextTaskId: resumedTask.id,
      executionMode: directive.mode ?? 'resume-parked',
      schedulingReason: directive.mode === 'resume-blocked' ? '解除阻塞' : '恢复已暂停任务',
      newlyProvidedResources: directive.newlyProvidedResources,
      recoveryTrigger: directive.mode === 'resume-blocked'
        ? this.buildRecoveryTrigger(resumedTask, {
            kind: 'explicit-task-command',
            blockedReason: directive.blockedReason,
            triggerReason: directive.newlyProvidedResources?.length ? '显式解除阻塞并补充材料' : '显式解除阻塞',
            sourceInput: userInput,
            newlyProvidedResources: directive.newlyProvidedResources,
          })
        : undefined,
    });
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

  private getWaitingBlockReason(task: Task): string {
    return task.dependencies
      .filter(dependency => dependency.status === 'waiting')
      .map(dependency => dependency.description)
      .filter(Boolean)
      .join('；');
  }

  private excerptInput(input: string, maxLength = 80): string {
    const normalized = input.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }
    return `${normalized.slice(0, maxLength - 1)}…`;
  }

  private formatTaskRecovery(taskId: string): string {
    const port = this.deps.runtimePort;
    const kernelWorkflowRepo = port.kernelServices.kernelWorkflowRepo;
    const effectOutboxRepo = port.repositories.effectOutboxRepo;
    const applications = kernelWorkflowRepo.listRecoveryItems(taskId).map(item =>
      `- ${item.id} [application/${item.status}] ${item.decision.action.type}: ${item.errorSummary ?? 'no error summary'}`
    );
    const effects = effectOutboxRepo.listRecoveryItems(taskId).map(item =>
      `- ${item.id} [effect/${item.status}] ${item.effectType}: ${item.errorSummary ?? 'no error summary'}`
    );
    const items = [...applications, ...effects];
    return items.length > 0
      ? `Task #${taskId} recovery items:\n${items.join('\n')}`
      : `Task #${taskId} has no uncertain or failed recovery items.`;
  }

  private buildRecoverySnapshot(
    taskId: string,
    recoveryItemId: string,
  ): Extract<KernelSnapshot, { type: 'recovery' }> {
    const port = this.deps.runtimePort;
    const task = port.taskServices?.taskRuntimeService.findTask(taskId);
    const application = port.kernelServices.kernelWorkflowRepo.findRecoveryItem(recoveryItemId);
    const effect = port.repositories.effectOutboxRepo.find(recoveryItemId);
    return {
      schemaVersion: 5,
      type: 'recovery',
      task: task ? { id: task.id, status: task.status } : null,
      item: application
        ? { id: application.id, kind: 'application', status: application.status as 'uncertain' | 'failed', retrySafe: true }
        : effect && (effect.status === 'uncertain' || effect.status === 'failed')
          ? { id: effect.id, kind: 'effect', status: effect.status, retrySafe: false }
          : null,
    };
  }

  private async resolveTaskRecovery(input: {
    taskId: string;
    recoveryItemId: string;
    resolution: 'assume_applied' | 'retry';
  }): Promise<void> {
    const port = this.deps.runtimePort;
    const kernelWorkflowRepo = port.kernelServices.kernelWorkflowRepo;
    const effectOutboxRepo = port.repositories.effectOutboxRepo;
    const kernelDecisionRepo = port.kernelServices.kernelDecisionRepo;
    const application = kernelWorkflowRepo.findRecoveryItem(input.recoveryItemId);
    const effect = effectOutboxRepo.find(input.recoveryItemId);
    const configurationRevision = application?.decision.configurationRevision
      ?? (effect
        ? kernelDecisionRepo.listByTask(input.taskId)
            .find(record => record.id === effect.decisionId)
            ?.configurationRevision
        : null);
    if (!configurationRevision) {
      throw new Error(`recovery item has no persisted configuration revision: ${input.recoveryItemId}`);
    }
    const event: Extract<KernelEvent, { type: 'recovery_resolution_requested' }> = {
      schemaVersion: 5,
      configurationRevision,
      type: 'recovery_resolution_requested',
      id: `recovery_event_${input.recoveryItemId}_${generateInteractionId()}`,
      correlationId: input.taskId,
      causationId: null,
      occurredAt: new Date().toISOString(),
      sessionId: this.deps.plannerSessionId,
      taskId: input.taskId,
      recoveryItemId: input.recoveryItemId,
      resolution: input.resolution,
    };
    const workflow = new DurableKernelWorkflow({
      kernel: port.kernelServices.controlKernel,
      buildSnapshot: claimed => {
        const recovery = claimed as Extract<KernelEvent, { type: 'recovery_resolution_requested' }>;
        return this.buildRecoverySnapshot(recovery.taskId!, recovery.recoveryItemId);
      },
      store: kernelWorkflowRepo,
      clock: { now: () => new Date().toISOString() },
      runtime: {
        apply: async decision => {
          if (decision.action.type === 'resolve_recovery') {
            const now = new Date().toISOString();
            if (kernelWorkflowRepo.findRecoveryItem(decision.action.recoveryItemId)) {
              kernelWorkflowRepo.resolveRecoveryItem(
                decision.action.recoveryItemId, decision.action.resolution, now,
              );
            } else {
              effectOutboxRepo.resolve(
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

  private getCommandContext(): CommandContext {
    const port = this.deps.runtimePort;
    return {
      taskEngine: this.deps.taskEngine!,
      memoryEngine: this.deps.memoryEngine!,
      orchestration: this.deps.orchestration!,
      activeExecutions: port.executionServices!.executionRuntime,
      taskControl: this.kernelExecutionRuntime!,
      readServices: this.deps.commandReadServices!,
      refreshExecutors: agentClassNames => port.coordinatorServices!.executorRecoveryRefreshService.refresh({
        trigger: 'manual',
        agentClassNames,
      }),
      currentTaskId: this.getCurrentTaskId(),
      db: this.deps.db!,
      config: this.deps.config!,
      executorAgentClassNames: port.taskServices!.agentClassService.listExecutorAgentClassNames(),
    };
  }

  private async waitForBackgroundWork(): Promise<void> {
    while (this.backgroundWork.size > 0) {
      await Promise.allSettled(Array.from(this.backgroundWork));
    }
  }

  cancelTurn(requestId: string): boolean {
    return this.deps.mailbox.cancel(requestId);
  }

  isIdle(): boolean {
    return !this.deps.mailbox.isActive;
  }

  async dispose(): Promise<void> {
    await (this.deps.dispose ?? (async () => undefined))();
  }

  private notify(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
