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
import {
  ConversationInputMailbox,
  type MailboxCommand,
  type MailboxReceipt,
} from './conversation-input-mailbox.js';
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
  readonly executeUserInput?: (text: string) => Promise<{ exitRequested: boolean }>;
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
  private listeners = new Set<(snapshot: ConversationSessionSnapshot) => void>();
  private attachedClients = 0;

  constructor(private readonly deps: ConversationSessionDeps) {
    this.kernelExecutionRuntime = deps.kernelExecutionRuntime ?? null;
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
      submit: async () => {
        await this.submitPlannerProposal(userInput, context);
        return { status: 'accepted' } as PlannerProposalResult;
      },
    });
    return result.status === 'accepted';
  }

  private async submitPlannerProposal(
    _userInput: string,
    _context: PlanningContext,
  ): Promise<void> {
    // 完整提案提交链路（buildPlanAdmissionSnapshot + workflow + kernel runtime）
    // 由后续步骤内联；当前由 executeUserInput 委托桥接 MetaclawSession。
    if (this.deps.executeUserInput) {
      await this.deps.executeUserInput(_userInput);
    }
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
    if (this.deps.executeUserInput) {
      return this.deps.executeUserInput(text);
    }
    return { exitRequested: false };
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
