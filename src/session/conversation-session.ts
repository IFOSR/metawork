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
import { buildExecutorDisplayFacts } from '../execution/execution-transparency.js';
import type { PlanningContextBuilder } from '../planning/planning-context-builder.js';
import type { PlannerImageAttachment, PlanningContext } from '../planning/planning-types.js';
import type { PlannerProposalResult } from '../planning/planner-proposal.js';
import {
  createPlannerProposalSubmissionId,
  plannerProposalFingerprint,
  type PlannerProposalPurpose,
  type PlannerProposalSubmission,
} from '../planning/planner-proposal.js';
import { PlannerProposalRepo } from '../storage/planner-proposal-repo.js';
import { PlanningAgentPlanSchema } from '../planning/planning-agent-plan-schema.js';
import { normalizePlanningAgentPlanInput } from '../planning/planning-agent-plan-normalizer.js';
import { validatePlanningAgentPlan } from '../planning/planning-agent-plan-validator.js';
import type Database from 'better-sqlite3';
import {
  resolvePublicRoutingIdentity,
  type KernelConfigurationView,
  type RuntimeConfigurationView,
} from '../configuration/index.js';
import { generateInteractionId } from '../utils/id.js';
import {
  buildCanonicalSubtaskIdentityMap,
  buildEligibleContextRefKeys,
} from '../work-graph/index.js';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';
import type {
  KernelExecutionRuntimeCallbacks,
  TaskExecutionApplicationCallbacks,
  SessionKernelRuntimeCallbacks,
} from '../account/account-kernel-execution-services.js';
import type { SessionKernelRuntime } from './session-kernel-runtime.js';
import type { SessionSnapshot, SessionSwitchingState } from './session-types.js';
import type { InteractionTrace } from '../management/interaction-trace.js';
import type { PlanningAgentPlan } from '../planning/planning-types.js';
import type { PlannerRunProgress } from '../planning/planner-progress.js';
import type { ExecutionTraceAppendInput } from '../execution/execution-trace.js';
import {
  ConversationInputMailbox,
  type MailboxCommand,
  type MailboxReceipt,
} from './conversation-input-mailbox.js';
import { InputController, type InputControllerSubmitOptions } from './input-controller.js';
import type { ConversationRuntimePort } from './conversation-runtime-port.js';
import type { GatewayCommand } from '../gateway/client-protocol.js';
import type { CommandCompletion } from '../commands/catalog.js';
import type {
  PlannerTuiCommandSubmissionResult,
  PlannerTuiExecutorResult,
  PlannerTuiPermissionRequest,
  PlannerTuiPermissionResolutionResult,
  PlannerTuiSnapshot,
} from './session-types.js';

export interface ConversationSessionSnapshot {
  readonly output: string[];
  readonly currentTaskId: string | null;
  readonly runtimeState: RuntimeState;
  readonly plannerState: { readonly status: 'idle' | 'running' };
}

export interface ConversationResultDelivery {
  readonly resultId: string;
  readonly content: string;
  readonly completeness: 'complete' | 'partial' | 'incomplete';
  readonly certification: 'certified' | 'uncertified';
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
  readonly getKernelConfiguration?: () => KernelConfigurationView | undefined;
  readonly getRuntimeConfiguration?: (revisionId: string) => RuntimeConfigurationView | null;
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
  readonly plannerProposalRepo?: PlannerProposalRepo;
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
  private blockedRecheckInFlight = false;
  private lastBlockedRecheckAt: number | null = null;
  private lastTaskPoolWatchdogFingerprint: string | null = null;
  private lastTaskPoolWatchdogReminderAt: number | null = null;
  private kernelExecutionRuntime: KernelExecutionRuntime | null = null;
  private sessionKernelRuntime: SessionKernelRuntime | null = null;
  private taskExecutionApplicationService: SessionTaskExecutionApplicationService | null = null;
  private readonly inputController: InputController;
  private listeners = new Set<(snapshot: SessionSnapshot) => void>();
  private resultDeliveries: ConversationResultDelivery[] = [];
  private attachedClients = 0;
  private disposePromise: Promise<void> | null = null;

  constructor(private readonly deps: ConversationSessionDeps) {
    this.kernelExecutionRuntime = deps.kernelExecutionRuntime ?? null;
    this.sessionKernelRuntime = deps.sessionKernelRuntime ?? null;
    this.taskExecutionApplicationService = deps.taskExecutionApplicationService ?? null;
    this.inputController = new InputController({
      appendUserInput: input => this.appendOutput('', `> ${input}`),
      handleCommand: input => this.handleCommand(input),
      handleNaturalLanguageInput: (input, images) => this.handleNaturalLanguageInput(input, images),
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

  recordResultDelivery(delivery: ConversationResultDelivery): void {
    this.resultDeliveries.push({ ...delivery });
  }

  getResultDeliveries(): readonly ConversationResultDelivery[] {
    return this.resultDeliveries.map(delivery => ({ ...delivery }));
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
      this.deps.runtimePort.queries.findTask(suggestion.taskId)?.title ?? '',
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
        ? this.deps.runtimePort.queries.findTask(proposal.taskId)?.title ?? ''
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
    const event = this.deps.runtimePort.queries.findKernelEvent(eventId);
    return event?.type === 'plan_proposed' ? event.requestText : '';
  }

  setRunningExecutorName(taskId: string, subtaskId: string, attemptId: string, name: string): void {
    this.runningExecutorsByAttempt.set(attemptId, { taskId, subtaskId, name });
  }

  bindKernelExecutionRuntime(runtime: KernelExecutionRuntime): void {
    this.kernelExecutionRuntime = runtime;
  }

  bindSessionKernelRuntime(runtime: SessionKernelRuntime): void {
    this.sessionKernelRuntime = runtime;
  }

  bindTaskExecutionApplicationService(service: SessionTaskExecutionApplicationService): void {
    this.taskExecutionApplicationService = service;
  }

  recordKernelDecisionTrace(decision: KernelDecision): void {
    this.deps.interactionTraceStream?.append({
      phase: 'authorization',
      actor: 'kernel',
      kind: 'kernel_decision',
      status: 'completed',
      title: decision.action.type === 'request_clarification'
        ? '需要补充信息'
        : `Kernel decision: ${decision.action.type}`,
      summary: decision.action.type === 'request_clarification'
        ? decision.action.question
        : decision.reason,
      details: {
        decisionId: decision.id,
        action: decision.action.type,
        eventId: decision.eventId,
        configurationRevision: decision.configurationRevision,
        ...(decision.action.type === 'request_clarification'
          ? { question: decision.action.question }
          : {}),
      },
      eventKey: decision.id,
      taskId: 'taskId' in decision.action && typeof decision.action.taskId === 'string'
        ? decision.action.taskId
        : null,
    });
    if (decision.action.type !== 'authorize_task_plan') return;
    const action = decision.action;
    const aliases = buildCanonicalSubtaskIdentityMap(
      action.taskId,
      action.graphRevision,
      action.workGraph.subtasks,
    );
    const subtaskTitles = new Map(
      this.deps.runtimePort.queries
        .listSubtasks(action.taskId)
        .map(subtask => [subtask.id, subtask.title]),
    );
    for (const proposalSubtaskId of Object.keys(action.authorizedBindingsBySubtask).sort()) {
      const subtaskId = aliases.get(proposalSubtaskId) ?? proposalSubtaskId;
      const bindings = action.authorizedBindingsBySubtask[proposalSubtaskId] ?? [];
      bindings.forEach((binding, fallbackOrder) => {
        const identity = resolvePublicRoutingIdentity(
          this.deps.getRuntimeConfiguration?.(binding.configurationRevision),
          binding,
        );
        const routedDisplay = buildExecutorDisplayFacts({
          identity,
          subtaskId,
          subtaskTitle: subtaskTitles.get(subtaskId),
        });
        this.deps.interactionTraceStream?.append({
          phase: 'routing',
          actor: 'kernel',
          kind: 'executor_routed',
          status: 'completed',
          title: fallbackOrder === 0 ? 'Primary Executor authorized' : 'Fallback Executor authorized',
          summary: `${identity.executorDisplayName} via ${identity.harnessDisplayName}`
            + ` using ${identity.providerDisplayName}/${identity.modelDisplayName}`,
          details: {
            fallbackOrder,
            routingRole: fallbackOrder === 0 ? 'primary' : 'fallback',
            ...routedDisplay,
          },
          eventKey: `${decision.id}:${subtaskId}:${fallbackOrder}`,
          taskId: action.taskId,
        });
      });
    }
  }

  appendExecutionTrace(input: ExecutionTraceAppendInput): void {
    const current = this.deps.interactionTraceStream?.getSnapshot();
    if (!current || current.status !== 'running') return;
    this.deps.interactionTraceStream?.append(input);
  }

  async cancelTask(taskId: string, reason: string): Promise<void> {
    await this.kernelExecutionRuntime?.cancelTask(taskId, reason);
  }

  buildPlanningContext(
    userInput: string,
    images?: PlannerImageAttachment[],
  ): PlanningContext | null {
    if (!this.deps.planningContextBuilder) return null;
    const pendingPermission = this.deps.runtimePort.queries.findOldestPendingPermission();
    return this.deps.planningContextBuilder.build({
      userInput,
      ...(images && images.length > 0 ? { images } : {}),
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
    const kernelConfiguration = this.deps.getKernelConfiguration?.()
      ?? this.deps.kernelConfiguration;
    if (!plannerConfiguration || !kernelConfiguration) return null;
    if (
      event.configurationRevision !== plannerConfiguration.revisionId
      || event.configurationRevision !== kernelConfiguration.revisionId
    ) {
      throw new Error(`plan admission configuration revision mismatch: ${event.configurationRevision}`);
    }
    return {
      schemaVersion: 5,
      type: 'plan_admission',
      tasks: port.queries.listTasks().map(task => ({ id: task.id, status: task.status })),
      runningTaskId: this.kernelExecutionRuntime?.getSingleActiveTaskId() ?? null,
      plannerConfiguration,
      kernelConfiguration,
      executorStatuses: port.queries.listExecutorStatuses(event.configurationRevision),
      v5WorkGraphTaskIds: port.queries.listWorkGraphTaskIds(),
      eligibleContextRefKeys: this.buildEligibleContextRefKeys(
        event.proposal as PlanningAgentPlan,
        event.requestText,
      ),
      pendingAuthorizationRequest: (() => {
        const pending = port.queries.findOldestPendingPermission();
        return pending ? { requestId: pending.request.id, taskId: pending.request.taskId } : null;
      })(),
    };
  }

  async handleNaturalLanguageInput(
    userInput: string,
    images?: PlannerImageAttachment[],
  ): Promise<void> {
    const handled = await this.handlePlanningKernelDecision(userInput, images);
    if (handled) return;
    this.appendOutput(
      '-> ControlKernel did not produce a runtime action.',
      'Please clarify whether you want to chat, create a new task, resume an existing task, or dispatch an executor.',
    );
  }

  private async handlePlanningKernelDecision(
    userInput: string,
    images?: PlannerImageAttachment[],
  ): Promise<boolean> {
    const planningAgent = this.deps.runtimePort.planning;
    if (!planningAgent) return false;
    const context = this.buildPlanningContext(userInput, images);
    if (!context) return false;
    this.appendTrace({
      phase: 'planning',
      actor: 'planner',
      kind: 'planner_started',
      status: 'running',
      title: 'Planner started',
      summary: 'Parsing the request and preparing a structured proposal.',
      details: { configurationRevision: context.configuration.revisionId },
      eventKey: 'planner',
    });
    this.activePlannerRuns += 1;
    this.notify();
    let result: PlannerProposalResult;
    try {
      result = await planningAgent.submit(context, {
        submit: async plan => this.submitValidatedPlannerProposal(userInput, plan, context),
        onProgress: progress => this.recordPlannerProgressTrace(progress),
      });
    } catch (error) {
      this.appendTrace({
        phase: 'planning',
        actor: 'planner',
        kind: 'planner_failed',
        status: 'failed',
        title: 'Planner failed',
        summary: (error as Error).message,
        details: {},
        eventKey: 'planner_failed',
        traceStatus: 'failed',
      });
      throw error;
    } finally {
      this.activePlannerRuns = Math.max(0, this.activePlannerRuns - 1);
      this.notify();
    }
    this.recordPlannerProposalTerminalTrace(result);
    if (result.status === 'transport_uncertain' || result.status === 'conflict') {
      throw new Error(result.message);
    }
    return result.status === 'accepted' || result.status === 'rejected';
  }

  private async submitValidatedPlannerProposal(
    userInput: string,
    plan: PlanningAgentPlan,
    context: PlanningContext,
    eventId = `plan_event_${plan.id}_${generateInteractionId()}`,
  ): Promise<PlannerProposalResult> {
    const port = this.deps.runtimePort;
    const sessionKernelRuntime = this.sessionKernelRuntime;
    if (!sessionKernelRuntime) {
      if (this.deps.executeUserInput) {
        await this.deps.executeUserInput(userInput);
      }
      return { status: 'accepted' } as PlannerProposalResult;
    }

    const event: KernelEvent = {
      schemaVersion: 5,
      configurationRevision: context?.configuration.revisionId ?? null,
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
    const result = await port.commands.submitKernel(event, {
      buildSnapshot: claimed => this.buildPlanAdmissionSnapshot(
        claimed as Extract<KernelEvent, { type: 'plan_proposed' }>,
      )!,
      runtime: sessionKernelRuntime.forInput(userInput),
    });
    const decision = result.decisions.find(item => item.eventId === eventId)
      ?? port.queries.listKernelDecisionsBySession(this.deps.plannerSessionId)
        .find(item => item.eventId === eventId)?.decision
      ?? null;
    if (!decision) {
      return {
        status: 'transport_uncertain',
        turnId: event.correlationId,
        submissionId: eventId,
        retryableByReplay: true,
        message: 'Kernel application did not produce an authoritative decision.',
      };
    }
    const application = port.queries.findKernelApplicationByDecisionId(decision.id);
    if (application?.status !== 'applied') {
      return {
        status: 'transport_uncertain',
        turnId: event.correlationId,
        submissionId: eventId,
        retryableByReplay: true,
        message: application?.errorSummary
          ? `Kernel application is uncertain: ${application.errorSummary}`
          : 'Kernel application did not reach the applied state.',
      };
    }
    if (decision.action.type === 'reject_request') {
      return {
        status: 'rejected',
        turnId: event.correlationId,
        submissionId: eventId,
        planId: plan.id,
        rejectionType: 'kernel',
        issues: [decision.reason],
        kernel: {
          decisionId: decision.id,
          action: 'reject_request',
          reason: decision.reason,
        },
      };
    }
    return {
      status: 'accepted',
      turnId: event.correlationId,
      submissionId: eventId,
      planId: plan.id,
      outcome: plannerOutcome(decision.action.type),
      displayText: plannerDecisionDisplayText(decision, this.output.at(-1)),
      taskId: plan.task.taskId
        ?? ('taskId' in decision.action && typeof decision.action.taskId === 'string'
          ? decision.action.taskId
          : null),
      kernel: {
        decisionId: decision.id,
        action: decision.action.type,
        reason: decision.reason,
      },
    };
  }

  clearRunningExecutorName(_taskId: string, attemptId?: string): void {
    if (attemptId) this.runningExecutorsByAttempt.delete(attemptId);
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
    const tasks = this.deps.runtimePort.queries.listTasks();
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

  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): SessionSnapshot {
    const currentTask = this.currentTaskId
      ? this.deps.runtimePort.queries.findTask(this.currentTaskId)
      : null;
    return {
      output: [...this.output],
      currentTaskId: this.currentTaskId,
      currentTask: currentTask
        ? { id: currentTask.id, title: currentTask.title, status: currentTask.status }
        : null,
      runtimeState: {
        ...this.runtimeState,
        readyTaskIds: [...this.runtimeState.readyTaskIds],
        blockedTaskIds: [...this.runtimeState.blockedTaskIds],
        parkedTaskIds: [...this.runtimeState.parkedTaskIds],
      },
      plannerState: {
        status: this.activePlannerRuns > 0 ? 'running' : 'idle',
      },
      latestGuidance: this.latestGuidance,
    };
  }

  subscribeInteractionTrace(
    listener: (trace: InteractionTrace | null) => void,
  ): () => void {
    return this.deps.interactionTraceStream?.subscribe(listener) ?? (() => undefined);
  }

  getInteractionTrace(): InteractionTrace | null {
    return this.deps.interactionTraceStream?.getSnapshot() ?? null;
  }

  getSwitchingState(): SessionSwitchingState {
    return {
      plannerTurnActive: this.activePlannerRuns > 0,
      taskRuntimeActive: this.runtimeState.runningTaskId !== null,
    };
  }

  submitCommand(command: MailboxCommand): MailboxReceipt {
    return this.deps.mailbox.submit(command);
  }

  bindMailboxExecutor(
    execute: (command: MailboxCommand) => Promise<void>,
  ): void {
    this.deps.mailbox.bindExecutor(execute);
  }

  async executeGatewayCommand(
    command: GatewayCommand,
    options: InputControllerSubmitOptions = {},
  ): Promise<void> {
    switch (command.kind) {
      case 'user_message':
      case 'slash_command':
        await this.submitUserInput(command.text, options);
        return;
      case 'permission_resolution':
        await this.resolvePermission(command.requestId, command.resolution, 'button');
        return;
      case 'cancel_turn':
        throw new Error(`turn cancellation is not available for completed admission: ${command.turnId}`);
    }
  }

  completeCommand(text: string, cursor = text.length): CommandCompletion {
    return this.deps.commandCatalog?.complete({
      text,
      cursor,
      context: this.getCommandContext(),
    }) ?? {
      state: 'inactive',
      suggestions: [],
      hint: null,
      error: null,
    };
  }

  getPlannerTuiSnapshot(): PlannerTuiSnapshot {
    const snapshot = this.getSnapshot();
    const port = this.deps.runtimePort;
    return {
      schemaVersion: 1,
      session: {
        id: this.plannerSessionId,
        focusedTask: snapshot.currentTask,
        runtimeState: snapshot.runtimeState,
        plannerState: snapshot.plannerState,
        recentOutput: snapshot.output.slice(-100),
      },
      taskPool: port.queries.listTasks().slice(0, 100).map(task => ({
        id: task.id,
        title: task.title,
        goal: task.goal,
        status: task.status,
        blockingReason: (
          task.lastInterruptionReason
          || task.dependencies.find(dependency => dependency.status === 'waiting')?.description
          || ''
        ).slice(0, 500) || null,
        subtasks: port.queries.listSubtasks(task.id).slice(0, 100).map(subtask => ({
          id: subtask.id,
          title: subtask.title,
          status: subtask.status,
          preferredAgentClassList: subtask.executorBindings.map(binding => binding.agentClassRef),
        })),
      })),
      executorStatuses: port.queries.listExecutorStatuses(
        (this.deps.getKernelConfiguration?.() ?? this.deps.kernelConfiguration)?.revisionId ?? '',
      ),
    };
  }

  getPlannerTuiExecutorResults(): PlannerTuiExecutorResult[] {
    const port = this.deps.runtimePort;
    const taskIds = [...new Set(
      port.queries.listKernelDecisionsBySession(this.plannerSessionId)
        .map(decision => decision.taskId)
        .filter((taskId): taskId is string => Boolean(taskId)),
    )];
    return port.queries.listIntegratedPublications(taskIds)
      .map(publication => {
        const task = port.queries.findTask(publication.taskId);
        const subtask = port.queries.findSubtask(publication.subtaskId);
        return {
          schemaVersion: 1,
          publicationId: publication.id,
          taskId: publication.taskId,
          taskTitle: task?.title ?? publication.taskId,
          subtaskId: publication.subtaskId,
          subtaskTitle: subtask?.title ?? publication.subtaskId,
          attemptId: publication.sourceAttemptId,
          executorName: publication.agentClassName,
          report: publication.originalCompletion.body,
          artifacts: [...publication.originalCompletion.artifacts],
          warnings: [...publication.originalCompletion.warnings],
          integrationCommit: publication.integrationCommit,
          completedAt: publication.updatedAt,
          reportTruncated: false,
        };
      });
  }

  getPlannerTuiPermissionRequests(): PlannerTuiPermissionRequest[] {
    return this.deps.runtimePort.permissions?.listForSession(this.plannerSessionId) ?? [];
  }

  async resolvePlannerTuiPermission(
    permissionRequestId: string,
    resolution: 'approve' | 'deny',
  ): Promise<PlannerTuiPermissionResolutionResult> {
    try {
      const result = await this.resolvePermission(permissionRequestId, resolution, 'button');
      if (result.status === 'conflict' || result.resolution === null) {
        return { status: 'conflict', resolution: null, message: result.message };
      }
      return {
        status: result.status,
        resolution: result.resolution,
        message: result.message,
      };
    } catch (error) {
      return {
        status: 'conflict',
        resolution: null,
        message: (error as Error).message,
      };
    }
  }

  private async resolvePermission(
    requestId: string,
    resolution: 'approve' | 'deny',
    source: 'button' | 'planner',
    plannerPlanId: string | null = null,
  ) {
    const permissionService = this.deps.runtimePort.permissions;
    if (!permissionService) throw new Error('Account permission service is unavailable');
    const result = await permissionService.resolve({
      sessionId: this.plannerSessionId,
      requestId,
      resolution,
      source,
      plannerPlanId,
    });
    if (result.status === 'conflict') throw new Error(result.message);
    if (result.recoveryTaskId) {
      await this.prepareTaskExecution(result.recoveryTaskId, {
        userPrompt: this.deps.runtimePort.queries.findTask(result.recoveryTaskId)?.goal ?? '',
        contextTaskId: result.recoveryTaskId,
        executionMode: 'resume-blocked',
        schedulingReason: `permission ${requestId} approved; recover persistent workspace`,
      });
    }
    return result;
  }

  async submitPlannerTuiCommand(rawCommand: string): Promise<PlannerTuiCommandSubmissionResult> {
    const command = rawCommand.trim();
    if (!/^\/\S/u.test(command)) {
      throw new Error('Planner TUI commands must start with /');
    }
    const outputStart = this.output.length;
    const result = await this.submitUserInput(command);
    await this.waitForBackgroundWork();
    return {
      exitRequested: result.exitRequested,
      output: this.output.slice(outputStart),
    };
  }

  async submitPlannerProposal(
    submission: PlannerProposalSubmission,
    purpose: PlannerProposalPurpose = 'kernel',
  ): Promise<PlannerProposalResult> {
    const sessionId = submission.sessionId.trim();
    const turnId = submission.turnId.trim();
    const userInput = submission.userInput.trim();
    if (!sessionId || !turnId || !userInput || sessionId !== this.plannerSessionId) {
      return {
        status: 'conflict',
        turnId,
        submissionId: submission.submissionId,
        acceptedSubmissionId: null,
        message: 'Planner proposal identity does not match the bound Conversation.',
      };
    }
    const normalizedPlan = normalizePlanningAgentPlanInput(submission.plan);
    const parsed = PlanningAgentPlanSchema.safeParse(normalizedPlan);
    const context = this.buildPlanningContext(userInput);
    const validation = context
      ? validatePlanningAgentPlan(
          normalizedPlan,
          context.configuration,
          context.pendingAuthorizationRequest
            ? {
                requestId: context.pendingAuthorizationRequest.requestId,
                taskId: context.pendingAuthorizationRequest.taskId,
              }
            : null,
        )
      : { valid: false, errors: ['Planner context is unavailable'] };
    const expectedSubmissionId = createPlannerProposalSubmissionId(sessionId, turnId, submission.plan);
    if (submission.submissionId !== expectedSubmissionId) {
      return {
        status: 'conflict',
        turnId,
        submissionId: submission.submissionId,
        acceptedSubmissionId: null,
        message: 'Planner proposal submissionId does not match the runtime-derived fingerprint.',
      };
    }
    const repo = this.deps.plannerProposalRepo;
    if (!repo) throw new Error('Planner proposal repository is unavailable');
    const turn = repo.ensureTurn(sessionId, turnId, userInput);
    if (turn.conflict) {
      return {
        status: 'conflict',
        turnId,
        submissionId: submission.submissionId,
        acceptedSubmissionId: null,
        message: 'Planner turn is already bound to different user input.',
      };
    }
    const planId = parsed.success ? parsed.data.id : null;
    const eventId = parsed.success && purpose === 'kernel'
      ? `plan_event_${submission.submissionId}`
      : null;
    const reservation = repo.reserveSubmission({
      sessionId,
      turnId,
      submissionId: submission.submissionId,
      planFingerprint: plannerProposalFingerprint(submission.plan),
      planId,
      eventId,
      configurationRevision: context?.configuration.revisionId ?? null,
    });
    if (reservation.kind === 'replay') return reservation.result;
    if (reservation.kind === 'conflict') {
      return {
        status: 'conflict',
        turnId,
        submissionId: submission.submissionId,
        acceptedSubmissionId: reservation.acceptedSubmissionId,
        message: 'This Planner turn already has a different authoritative submission.',
      };
    }
    if (reservation.kind === 'in_flight') {
      return {
        status: 'transport_uncertain',
        turnId,
        submissionId: submission.submissionId,
        retryableByReplay: true,
        message: 'The same Planner proposal is still being durably applied; replay it.',
      };
    }
    if (!parsed.success || !validation.valid || !context) {
      const rejected: Extract<PlannerProposalResult, { status: 'rejected' }> = {
        status: 'rejected',
        turnId,
        submissionId: submission.submissionId,
        planId,
        rejectionType: 'validation',
        issues: parsed.success ? validation.errors : parsed.error.issues.map(issue => issue.message),
        kernel: null,
      };
      repo.completeSubmission(sessionId, turnId, submission.submissionId, rejected);
      return rejected;
    }
    if (purpose === 'validation') {
      const accepted: Extract<PlannerProposalResult, { status: 'accepted' }> = {
        status: 'accepted',
        turnId,
        submissionId: submission.submissionId,
        planId: parsed.data.id,
        outcome: 'proposal_validated',
        displayText: 'PlanningAgentPlan v8 proposal validated by MetaWork.',
        taskId: parsed.data.task.taskId,
        kernel: null,
      };
      repo.completeSubmission(sessionId, turnId, submission.submissionId, accepted);
      return accepted;
    }
    try {
      const result = await this.submitValidatedPlannerProposal(
        userInput,
        parsed.data as PlanningAgentPlan,
        context,
        eventId!,
      );
      if (result.status === 'accepted' || result.status === 'rejected') {
        repo.completeSubmission(sessionId, turnId, submission.submissionId, {
          ...result,
          turnId,
          submissionId: submission.submissionId,
        });
        return {
          ...result,
          turnId,
          submissionId: submission.submissionId,
        };
      }
      repo.markUncertain(sessionId, turnId, submission.submissionId);
      return { ...result, turnId, submissionId: submission.submissionId };
    } catch (error) {
      repo.markUncertain(sessionId, turnId, submission.submissionId);
      return {
        status: 'transport_uncertain',
        turnId,
        submissionId: submission.submissionId,
        retryableByReplay: true,
        message: `Planner proposal transport is uncertain: ${(error as Error).message}`,
      };
    }
  }

  /** GatewaySession 兼容：提交用户文本并触发 Planner 回合。 */
  async submit(text: string): Promise<{ exitRequested: boolean }> {
    return this.submitUserInput(text);
  }

  initialize(_options?: { showDashboard?: boolean }): void {
    // Conversation 外壳无需初始化；账户级恢复由 AccountRuntime 负责。
  }

  appendSystemMessage(...lines: string[]): void {
    this.appendOutput(...lines);
  }

  /**
   * 提交用户输入并触发 Planner 回合（通过注入的执行委托）。委托由调用方
   * （当前 MetaclawSession，未来 AccountRuntime 内联）提供。
   */
  async submitUserInput(
    text: string,
    options: InputControllerSubmitOptions = {},
  ): Promise<{ exitRequested: boolean }> {
    const userInput = text.trim();
    const startsTrace = shouldStartInteractionTrace(userInput);
    const interactionTurnId = options.interactionTurnId ?? `turn_${generateInteractionId()}`;
    if (startsTrace) {
      this.deps.interactionTraceStream?.beginTurn({
        turnId: interactionTurnId,
        userInput,
      });
    }
    const result = await this.inputController.submit(text, options);
    if (
      startsTrace
      && userInput.startsWith('/')
      && (options.awaitAsyncWork || this.backgroundWork.size === 0)
    ) {
      const current = this.deps.interactionTraceStream?.getSnapshot();
      if (current?.turnId === interactionTurnId && current.status === 'running') {
        this.deps.interactionTraceStream?.append({
          phase: 'delivery',
          actor: 'runtime',
          kind: 'command_completed',
          status: 'completed',
          title: 'Command completed',
          summary: 'The task control command completed without active Executor work.',
          details: {},
          eventKey: 'command_completed',
          traceStatus: 'completed',
        });
      }
    }
    return result;
  }

  private appendTrace(
    input: Parameters<InteractionTraceStream['append']>[0],
  ): void {
    if (!this.deps.interactionTraceStream?.getSnapshot()) return;
    this.deps.interactionTraceStream.append(input);
  }

  private recordPlannerProgressTrace(progress: PlannerRunProgress): void {
    const current = this.deps.interactionTraceStream?.getSnapshot();
    if (!current || current.status !== 'running') return;
    const details = {
      progressSequence: progress.sequence,
      elapsedMs: progress.elapsedMs,
    };
    const eventKey = `rpc:${progress.sequence}`;
    const common = {
      phase: 'planning' as const,
      actor: 'planner' as const,
      status: 'running' as const,
      details,
      eventKey,
    };
    switch (progress.kind) {
      case 'process_started':
        this.appendTrace({
          ...common,
          kind: 'planner_process_started',
          title: 'Planner process started',
          summary: 'The isolated Planner RPC process is running.',
        });
        return;
      case 'prompt_accepted':
        this.appendTrace({
          ...common,
          kind: 'planner_prompt_accepted',
          title: 'Planner accepted the request',
          summary: 'The request entered the Planner agent loop.',
        });
        return;
      case 'agent_started':
        this.appendTrace({
          ...common,
          kind: 'planner_agent_started',
          title: 'Planner agent loop started',
          summary: 'Planner is preparing the next structured action.',
        });
        return;
      case 'turn_started':
        this.appendTrace({
          ...common,
          kind: 'planner_turn_started',
          title: `Planner processing cycle ${progress.turn}`,
          summary: 'Planner is evaluating context and the next tool action.',
          details: { ...details, turn: progress.turn },
        });
        return;
      case 'model_stream_started':
        this.appendTrace({
          ...common,
          kind: 'planner_model_stream_started',
          title: 'Planner model response started',
          summary: 'The model is generating a structured action.',
          details: { ...details, turn: progress.turn },
        });
        return;
      case 'model_waiting':
        this.appendTrace({
          ...common,
          kind: 'planner_model_waiting',
          title: 'Planner is waiting for the model',
          summary: 'The Planner request is still active, but no model output has arrived yet.',
          details: {
            ...details,
            turn: progress.turn,
            idleMs: progress.idleMs,
          },
        });
        return;
      case 'tool_started':
        this.appendTrace({
          ...common,
          kind: 'planner_tool_started',
          title: `Planner tool started: ${progress.toolName}`,
          summary: `Planner started ${progress.toolName}.`,
          details: {
            ...details,
            toolSequence: progress.toolSequence,
            toolName: progress.toolName,
            argumentFields: progress.argumentFields,
          },
        });
        return;
      case 'tool_completed':
        this.appendTrace({
          ...common,
          kind: 'planner_tool_completed',
          status: progress.status,
          title: `Planner tool ${progress.status}: ${progress.toolName}`,
          summary: `Planner ${progress.status} ${progress.toolName}.`,
          details: {
            ...details,
            toolSequence: progress.toolSequence,
            toolName: progress.toolName,
            argumentFields: progress.argumentFields,
            resultFields: progress.resultFields,
          },
        });
        return;
      case 'agent_completed':
        this.appendTrace({
          ...common,
          kind: 'planner_agent_completed',
          status: 'completed',
          title: 'Planner handoff confirmed',
          summary: 'Planner completed the structured proposal handoff.',
        });
    }
  }

  private recordPlannerProposalTerminalTrace(result: PlannerProposalResult): void {
    const current = this.deps.interactionTraceStream?.getSnapshot();
    if (!current || current.status !== 'running') return;
    if (result.status === 'accepted') return;
    const status = result.status === 'rejected' ? 'failed' : 'blocked';
    this.appendTrace({
      phase: 'planning',
      actor: 'planner',
      kind: result.status === 'transport_uncertain'
        ? 'proposal_transport_uncertain'
        : result.status === 'conflict'
          ? 'proposal_conflict'
          : 'proposal_rejected',
      status,
      title: result.status === 'transport_uncertain'
        ? 'Planner handoff blocked'
        : result.status === 'conflict'
          ? 'Planner proposal conflict'
          : 'Planner proposal rejected',
      summary: result.status === 'rejected' ? result.issues.join('; ') : result.message,
      details: {
        plannerTurnId: result.turnId,
        submissionId: result.submissionId,
      },
      eventKey: result.submissionId,
      traceStatus: status,
    });
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
    if (/^\/task\s+(resume|recover|recovery)\b/iu.test(input)) {
      await this.deps.runtimePort.commands.refreshExecutors({ trigger: 'task_recovery' });
    }
    const result = await commandCatalog.execute(input, this.getCommandContext());
    this.appendOutput(result.content);
    if (/^\/executor\s+(register|unregister)\b/iu.test(input)) {
      await this.deps.runtimePort.commands.refreshExecutors({ trigger: 'executor_changed' });
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
    const taskExecutionApplicationService = this.taskExecutionApplicationService;
    if (!taskExecutionApplicationService) return;
    const resumedTask = this.deps.runtimePort.queries.findTask(taskId);
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
    const applications = port.queries.listRecoveryApplications(taskId).map(item =>
      `- ${item.id} [application/${item.status}] ${item.decision.action.type}: ${item.errorSummary ?? 'no error summary'}`
    );
    const effects = port.queries.listRecoveryEffects(taskId).map(item =>
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
    const task = port.queries.findTask(taskId);
    const application = port.queries.findRecoveryApplication(recoveryItemId);
    const effect = port.queries.findRecoveryEffect(recoveryItemId);
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
    const application = port.queries.findRecoveryApplication(input.recoveryItemId);
    const effect = port.queries.findRecoveryEffect(input.recoveryItemId);
    const configurationRevision = application?.decision.configurationRevision
      ?? (effect
        ? port.queries.listKernelDecisionsByTask(input.taskId)
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
    await port.commands.submitKernel(event, {
      buildSnapshot: claimed => {
        const recovery = claimed as Extract<KernelEvent, { type: 'recovery_resolution_requested' }>;
        return this.buildRecoverySnapshot(recovery.taskId!, recovery.recoveryItemId);
      },
      runtime: {
        apply: async decision => {
          if (decision.action.type === 'resolve_recovery') {
            const now = new Date().toISOString();
            if (port.queries.findRecoveryApplication(decision.action.recoveryItemId)) {
              port.commands.resolveRecoveryApplication(
                decision.action.recoveryItemId, decision.action.resolution, now,
              );
            } else {
              port.commands.resolveRecoveryEffect(
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
    });
    this.appendOutput(this.formatTaskRecovery(input.taskId));
  }

  private async runPlanningAgent(context: PlanningContext): Promise<PlanningAgentPlan> {
    const planningAgent = this.deps.runtimePort.planning;
    if (!planningAgent) throw new Error('planning agent is unavailable');
    this.activePlannerRuns += 1;
    this.notify();
    try {
      return await planningAgent.plan(context);
    } finally {
      this.activePlannerRuns = Math.max(0, this.activePlannerRuns - 1);
      this.notify();
    }
  }

  private buildEligibleContextRefKeys(plan: PlanningAgentPlan, userInput: string): string[] {
    return buildEligibleContextRefKeys({
      db: this.deps.db ?? null,
      sessionId: this.deps.plannerSessionId,
      refs: (plan.workGraph?.subtasks ?? []).flatMap(subtask => subtask.contextRefs),
      targetTask: plan.task.taskId
        ? this.deps.runtimePort.queries.findTask(plan.task.taskId)
        : null,
      userInput,
    });
  }

  private async requestKernelReplan(
    decision: KernelDecision & {
      action: Extract<KernelDecision['action'], { type: 'request_replan' }>;
    },
  ): Promise<Extract<KernelEvent, { type: 'plan_proposed' }>> {
    const port = this.deps.runtimePort;
    const task = port.queries.findTask(decision.action.taskId);
    if (!task) throw new Error(`replan Task not found: ${decision.action.taskId}`);
    port.commands.materializeCompletedEvidence(task.id, decision.action.sourceRevision);
    const evidence = port.queries.listTaskEvidence(
      task.id,
      decision.action.generationId,
    );
    const failures = port.queries.listAttemptReceipts(task.id)
      .filter(item =>
        item.generationId === decision.action.generationId
        && item.graphRevision === decision.action.sourceRevision
        && item.terminalState !== 'completed'
      )
      .sort((left, right) =>
        left.completedAt.localeCompare(right.completedAt)
        || left.attemptId.localeCompare(right.attemptId)
      );
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
        attemptId: item.attemptId,
        agentClassName: item.agentClassName,
        terminalState: item.terminalState,
        failure: item.failure,
        code: item.errorCode,
        summary: String(item.errorDetail ?? '').slice(0, 1_000),
      })))}`,
      'Bind the proposal to the exact existing Task id. Do not include raw Executor responses.',
    ].join('\n\n').slice(0, 24_000);
    const context = this.deps.planningContextBuilder!.build({ userInput: request });
    const plan = await this.runPlanningAgent(context);
    return {
      schemaVersion: 5,
      configurationRevision: context.configuration.revisionId,
      type: 'plan_proposed',
      id: `replan_event_${decision.id}`,
      correlationId: decision.eventId,
      causationId: decision.id,
      occurredAt: new Date().toISOString(),
      sessionId: this.deps.plannerSessionId,
      taskId: task.id,
      proposal: plan,
      requestText: redactSensitiveText(request).slice(0, 24_000),
      generationId: decision.action.generationId,
      proposalSource: 'replan',
      targetGraphRevision: decision.action.sourceRevision + 1,
      availabilityExplanation: null,
    };
  }

  private async requestKernelMergeReplan(
    decision: KernelDecision & {
      action: Extract<KernelDecision['action'], { type: 'request_merge_replan' }>;
    },
  ): Promise<Extract<KernelEvent, { type: 'plan_proposed' }> | null> {
    const port = this.deps.runtimePort;
    const task = port.queries.findTask(decision.action.taskId);
    const revision = port.queries.findActiveWorkGraphRevision(decision.action.taskId);
    if (!task || !revision) return null;
    const request = [
      'Replan only the remaining semantic work after a Git publication conflict.',
      'Do not create a dedicated conflict-resolution Subtask.',
      'Return plan_work_graph bound to the exact existing Task and preserve completed facts.',
      `Task id: ${task.id}`,
      `Task goal: ${task.goal}`,
      `Conflicted Subtask id: ${decision.action.subtaskId}`,
      `Publication id: ${decision.action.publicationId}`,
      `Conflict chain id: ${decision.action.conflictChainId}`,
      'The revised remaining work must let the original delivery intent publish without choosing or silently overwriting a conflicting version.',
    ].join('\n\n').slice(0, 24_000);
    const context = this.deps.planningContextBuilder!.build({ userInput: request });
    const plan = await this.runPlanningAgent(context);
    return {
      schemaVersion: 5,
      configurationRevision: context.configuration.revisionId,
      type: 'plan_proposed',
      id: `merge_replan_event_${decision.id}`,
      correlationId: decision.eventId,
      causationId: decision.id,
      occurredAt: new Date().toISOString(),
      sessionId: this.deps.plannerSessionId,
      taskId: task.id,
      proposal: plan,
      requestText: redactSensitiveText(request).slice(0, 24_000),
      generationId: revision.generationId,
      proposalSource: 'conflict_replan',
      targetGraphRevision: revision.revision + 1,
      availabilityExplanation: null,
    };
  }

  private appendTaskQueueSnapshot(trigger: string): void {
    const entries = this.buildTaskQueueSnapshotEntries();
    if (entries.length === 0) return;
    this.appendOutput(...this.deps.presentation!.formatTaskQueueSnapshot({
      trigger,
      runtimeState: this.runtimeState,
      entries,
    }));
  }

  private buildTaskQueueSnapshotEntries() {
    return this.deps.presentation!.buildTaskQueueSnapshotEntries({
      tasks: this.deps.runtimePort.queries.listTasks(),
      runningTaskId: this.runtimeState.runningTaskId,
      evaluateTask: task => this.deps.orchestration!.evaluateTask(task),
    });
  }

  private formatRunningExecutors(taskId: string): string | null {
    const names = [...this.runningExecutorsByAttempt.values()]
      .filter(active => active.taskId === taskId)
      .map(active => active.name);
    return names.length > 0 ? names.join('、') : null;
  }

  getBlockedRecheckIntervalMs(): number {
    const seconds = this.deps.config?.orchestration.blocked_recheck_interval ?? 60;
    return Math.max(seconds, 5) * 1000;
  }

  async maybeReviewTaskPoolOnTimer(nowMs = Date.now()): Promise<boolean> {
    for (const task of this.deps.runtimePort.queries.listTasksByStatus('blocked')) {
      if (await this.kernelExecutionRuntime?.recoverDue(task.id, 'timer durable recovery drain')) return true;
    }
    if (await this.maybeReconcileBlockedTasksOnTimer(nowMs)) {
      return true;
    }
    this.refreshRuntimeState();
    return this.maybeEmitTaskPoolWatchdogReminder(nowMs);
  }

  private async maybeReconcileBlockedTasksOnTimer(nowMs = Date.now()): Promise<boolean> {
    if (this.blockedRecheckInFlight) return false;
    const orchestrationConfig = this.deps.config?.orchestration;
    if (orchestrationConfig?.blocked_recheck_enabled === false) return false;
    const intervalMs = Math.max(orchestrationConfig?.blocked_recheck_interval ?? 60, 5) * 1000;
    if (this.lastBlockedRecheckAt !== null && nowMs - this.lastBlockedRecheckAt < intervalMs) {
      return false;
    }
    const candidates = this.deps.runtimePort.queries.listCurrentKernelDecisions('wait_for_capacity');
    if (candidates.length === 0) {
      this.lastBlockedRecheckAt = nowMs;
      return false;
    }
    this.lastBlockedRecheckAt = nowMs;
    this.blockedRecheckInFlight = true;
    try {
      const target = candidates[0];
      if (!target?.taskId || !target.subtaskId) return false;
      return await this.kernelExecutionRuntime!.recheckCapacity({
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

  private maybeEmitTaskPoolWatchdogReminder(nowMs: number): boolean {
    if (!this.deps.config?.orchestration.reminder_enabled) return false;
    const tasks = this.deps.runtimePort.queries.listTasks();
    const blockedTasks = tasks.filter(task => task.status === 'blocked');
    const parkedTasks = tasks.filter(task => task.status === 'parked');
    if (blockedTasks.length === 0 && parkedTasks.length === 0) return false;
    const fingerprint = [
      ...blockedTasks.map(task => `b:${task.id}:${this.getWaitingBlockReason(task)}`),
      ...parkedTasks.map(task => `p:${task.id}:${task.lastInterruptionReason}:${task.snapshots.at(-1)?.nextStep ?? ''}`),
    ].join('|');
    const throttleMs = (this.deps.config?.orchestration.reminder_throttle ?? 0) * 1000;
    if (
      this.lastTaskPoolWatchdogFingerprint === fingerprint
      && this.lastTaskPoolWatchdogReminderAt !== null
      && nowMs - this.lastTaskPoolWatchdogReminderAt < throttleMs
    ) {
      return false;
    }
    this.lastTaskPoolWatchdogFingerprint = fingerprint;
    this.lastTaskPoolWatchdogReminderAt = nowMs;
    this.appendOutput(...this.deps.presentation!.formatTaskPoolWatchdogReminder({
      blockedTasks,
      parkedTasks,
      getWaitingBlockReason: task => this.getWaitingBlockReason(task),
    }));
    return true;
  }

  prepareTaskExecution(taskId: string, request: QueuedExecutionRequest): void {
    this.taskExecutionApplicationService?.prepareTaskExecution(taskId, request);
  }

  /** 装配账户级 Kernel 执行服务所需的三个 callbacks 对象（ADR-0031）。 */
  getKernelExecutionCallbacks(): {
    kernelExecutionCallbacks: KernelExecutionRuntimeCallbacks;
    taskExecutionCallbacks: TaskExecutionApplicationCallbacks;
    sessionKernelCallbacks: SessionKernelRuntimeCallbacks;
  } {
    return {
      kernelExecutionCallbacks: {
        appendOutput: (...lines: string[]) => this.appendOutput(...lines),
        recordResultDelivery: delivery => this.recordResultDelivery(delivery),
        appendExecutionTrace: input => this.appendExecutionTrace(input),
        refreshRuntimeState: () => this.refreshRuntimeState(),
        appendTaskQueueSnapshot: trigger => this.appendTaskQueueSnapshot(trigger),
        setFocusContext: focus => this.setFocusContext(focus),
        setRunningExecutorName: (taskId, subtaskId, attemptId, name) => (
          this.setRunningExecutorName(taskId, subtaskId, attemptId, name)
        ),
        clearRunningExecutorName: (taskId, attemptId) => this.clearRunningExecutorName(taskId, attemptId),
        persistSessionState: changes => this.persistSessionState(changes),
        setLatestGuidance: (scene, suggestion) => this.setLatestGuidance(scene, suggestion)!,
        queueProposal: (scene, proposal) => this.queueProposal(scene, proposal),
        requestReplan: decision => this.requestKernelReplan(decision),
        requestMergeReplan: decision => this.requestKernelMergeReplan(decision),
        buildPlanAdmissionSnapshot: event => this.buildPlanAdmissionSnapshot(event)!,
      },
      taskExecutionCallbacks: {
        appendOutput: (...lines: string[]) => this.appendOutput(...lines),
        appendGuidance: (scene, suggestion) => this.appendGuidance(scene, suggestion),
        refreshRuntimeState: () => this.refreshRuntimeState(),
        startBackgroundExecution: (taskId, work) => this.startBackgroundExecution(taskId, work),
      },
      sessionKernelCallbacks: {
        appendOutput: (...lines: string[]) => this.appendOutput(...lines),
        onDecisionApplying: decision => this.recordKernelDecisionTrace(decision),
        deliverDirectReply: (userInput, reply) => this.deliverDirectReply(userInput, reply),
        prepareTaskExecution: (taskId, request) => this.prepareTaskExecution(taskId, request),
        refreshRuntimeState: () => this.refreshRuntimeState(),
        setCurrentTaskId: taskId => this.setCurrentTaskId(taskId),
        getCurrentTaskId: () => this.getCurrentTaskId(),
        setFocusContext: focus => this.setFocusContext(focus),
        resolveRequestText: eventId => this.resolveRequestText(eventId),
        cancelTask: async (taskId, reason) => {
          await this.kernelExecutionRuntime?.cancelTask(taskId, reason);
        },
      },
    };
  }

  private getCommandContext(): CommandContext {
    const port = this.deps.runtimePort;
    if (!port.execution) {
      throw new Error('Account execution facade is unavailable');
    }
    return {
      taskEngine: this.deps.taskEngine!,
      memoryEngine: this.deps.memoryEngine!,
      orchestration: this.deps.orchestration!,
      activeExecutions: port.execution.activeExecutions,
      taskControl: this.kernelExecutionRuntime!,
      readServices: this.deps.commandReadServices!,
      refreshExecutors: agentClassNames => port.commands.refreshExecutors({
        trigger: 'manual',
        agentClassNames,
      }),
      currentTaskId: this.getCurrentTaskId(),
      db: this.deps.db!,
      config: this.deps.config!,
      executorAgentClassNames: port.execution.listExecutorAgentClassNames(),
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
    return this.deps.mailbox.isIdle && this.backgroundWork.size === 0;
  }

  async dispose(): Promise<void> {
    this.disposePromise ??= (async () => {
      this.deps.mailbox.closeAdmission();
      await this.deps.mailbox.waitForIdle();
      await this.waitForBackgroundWork();
      this.listeners.clear();
      await (this.deps.dispose ?? (async () => undefined))();
    })();
    await this.disposePromise;
  }

  private notify(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

function shouldStartInteractionTrace(userInput: string): boolean {
  if (!userInput) return false;
  if (!userInput.startsWith('/')) return true;
  return /^\/task\s+(?:resume|unblock|recover)\b/iu.test(userInput);
}

function plannerOutcome(
  action: KernelDecision['action']['type'],
): Extract<PlannerProposalResult, { status: 'accepted' }>['outcome'] {
  switch (action) {
    case 'authorize_task_plan':
      return 'task_authorized';
    case 'authorize_task_control':
      return 'task_control_authorized';
    case 'deliver_direct_reply':
      return 'direct_reply_delivered';
    case 'request_clarification':
      return 'clarification_requested';
    case 'record_permission_resolution':
      return 'authorization_recorded';
    default:
      return 'no_action';
  }
}

function plannerDecisionDisplayText(
  decision: KernelDecision,
  latestOutput: string | undefined,
): string {
  if (decision.action.type === 'deliver_direct_reply') return decision.action.response;
  if (decision.action.type === 'request_clarification') return decision.action.question;
  return latestOutput ?? decision.reason;
}
