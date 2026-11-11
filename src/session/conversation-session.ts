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

import type { UsagePayerResolver } from '../metering/usage-payer.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { GuidanceProposal, RuntimeState } from '../core/types.js';
import type { Config } from '../core/types.js';
import type { Task, TaskRecoveryTrigger } from '../core/types.js';
import { buildTaskStatusLines } from './task-status-snapshot.js';
import {
  formatTaskResumeDecision,
  type SessionTaskExecutionApplicationService,
  type TaskExecutionStart,
} from './session-task-execution-application-service.js';
import type { QueuedExecutionRequest } from './session-helpers.js';
import type { TaskEngine } from '../task/task-engine.js';
import type { OrchestrationEngine } from '../guidance/orchestration.js';
import type { CommandCatalog, CommandContext } from '../commands/catalog.js';
import type { CommandReadServices } from '../commands/command-read-services.js';
import type { SessionPresentationService, GuidanceState } from './session-presentation-service.js';
import type { SessionStateRepo } from '../storage/session-state-repo.js';
import type { SessionPersistenceService } from './session-persistence-service.js';
import type { InteractionTraceStream } from './interaction-trace-stream.js';
import type { ControlDecision, ControlEvent, ControlSnapshot } from '../control/control-contracts.js';
import { PlanProposalUnavailableError, planAdmissionRequest, planProposalIdentity } from '../execution/plan-proposal-store.js';
import type { PlanAdmissionRequest } from '../execution/plan-admission-policy.js';
import {
  evaluatePlanAdmission,
  planAdmissionSnapshotFromControl,
} from '../execution/plan-admission-entry.js';
import type { PlanAdmissionResult } from '../execution/plan-admission-policy.js';
import type { PlanAdmissionAppliedResult } from '../execution/plan-admission-applier.js';
import { buildControlConfigurationView, buildPlannerConfigurationView, buildRuntimeConfigurationView } from '../configuration/projections.js';
import type { ConfigurationSnapshot } from '../configuration/types.js';
import { ControlApplicationInterruptedError, ControlApplicationRejectionError } from '../control/control-workflow.js';
import { SpanEvaluationAbortedError } from '../routing/span-routing-types.js';
import type { ControlExecutionRuntime } from '../execution/control-execution-runtime.js';
import { buildExecutorDisplayFacts } from '../execution/execution-transparency.js';
import type { PlanningContextBuilder } from '../planning/planning-context-builder.js';
import type {
  PlannerAttachmentView,
  PlannerImageAttachment,
  PlanningContext,
} from '../planning/planning-types.js';
import type { PlannerProposalResult } from '../planning/planner-proposal.js';
import type { WorkspaceWriteState } from '../core/workspace-execution.js';
import {
  createPlannerProposalSubmissionId,
  plannerProposalFingerprint,
  type PlannerProposalPurpose,
  type PlannerProposalSubmission,
} from '../planning/planner-proposal.js';
import { PlannerProposalRepo } from '../storage/planner-proposal-repo.js';
import {
  PlannerTurnInputRepo,
  plannerTurnInputHash,
} from '../storage/planner-turn-input-repo.js';
import { PlanningAgentPlanSchema } from '../planning/planning-agent-plan-schema.js';
import { normalizePlanningAgentPlanInput } from '../planning/planning-agent-plan-normalizer.js';
import { validatePlanningAgentPlan } from '../planning/planning-agent-plan-validator.js';
import type Database from 'better-sqlite3';
import {
  resolvePublicRoutingIdentity,
  type ControlConfigurationView,
  type RuntimeConfigurationView,
} from '../configuration/index.js';
import { generateInteractionId } from '../utils/id.js';
import { createHash } from 'node:crypto';
import {
  buildCanonicalSubtaskIdentityMap,
  buildEligibleContextRefKeys,
  contextRefKey,
} from '../work-graph/index.js';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';
import type {
  ControlExecutionRuntimeCallbacks,
  TaskExecutionApplicationCallbacks,
  SessionControlRuntimeCallbacks,
} from '../account/account-control-execution-services.js';
import type { SessionControlRuntime } from './session-control-runtime.js';
import { formatEmptyTaskRecovery } from '../task/task-blocker-guidance.js';
import type { SessionSnapshot, SessionSwitchingState } from './session-types.js';
import type { InteractionTrace } from '../management/interaction-trace.js';
import type { PlanningAgentPlan } from '../planning/planning-types.js';
import type { PlannerRunProgress } from '../planning/planner-progress.js';
import type { HarnessUsageEvent } from '../executor/harness-driver.js';
import type { RawUsageEvent } from '../metering/usage-normalizer.js';
import type { Payer } from '../metering/usage-payer.js';
import type { ExecutionTraceAppendInput } from '../execution/execution-trace.js';
import {
  ConversationInputMailbox,
  type MailboxCommand,
  type MailboxReceipt,
} from './conversation-input-mailbox.js';
import { InputController, type InputControllerSubmitOptions } from './input-controller.js';
import type { ConversationRuntimePort } from './conversation-runtime-port.js';
import type {
  ConversationWorkspaceSelection,
  ConversationWorkspacePort,
  WorkspaceCommandResult,
} from '../workspace/conversation-workspace-service.js';
import type { GatewayCommand } from '../gateway/client-protocol.js';
import type { QueryIngress } from '../metering/ports.js';
import type { QueryUsageLifecycle } from '../metering/query-lifecycle.js';
import type { BeginQueryResult } from '../metering/query-context-service.js';
import type { CommandCompletion } from '../commands/catalog.js';
import type {
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

/**
 * A Planner turn's input facts. The eligible attachment set belongs to the
 * Turn; every admission step reads it from here instead of from a locally
 * rebuilt context.
 */
interface PlannerTurnFacts {
  userInput: string;
  images?: PlannerImageAttachment[];
  attachments: PlannerAttachmentView[];
}

export interface ConversationSessionDeps {
  readonly onBackgroundResultDelivery?: (delivery: ConversationResultDelivery, originTurnId: string) => Promise<void>;
  readonly conversationId: string;
  readonly plannerSessionId: string;
  readonly plannerBindingFingerprint?: string;
  readonly plannerProviderRef?: string;
  readonly plannerModelId?: string;
  readonly runtimePort: ConversationRuntimePort;
  readonly mailbox: ConversationInputMailbox;
  readonly presentation?: SessionPresentationService;
  readonly sessionStateRepo?: SessionStateRepo;
  readonly persistenceService?: SessionPersistenceService;
  readonly interactionTraceStream?: InteractionTraceStream;
  readonly kernelExecutionRuntime?: ControlExecutionRuntime;
  readonly planningContextBuilder?: PlanningContextBuilder;
  readonly db?: Database.Database;
  readonly kernelConfiguration?: ControlConfigurationView;
  readonly getControlConfiguration?: () => ControlConfigurationView | undefined;
  readonly getRuntimeConfiguration?: (revisionId: string) => RuntimeConfigurationView | null;
  readonly resolveConfigurationSnapshot?: (revisionId: string) => Promise<ConfigurationSnapshot>;
  /** Shared Server advisor, also injected into detached recovery sessions. */
  /** Admission policy seam; production always uses the owner policy. */
  readonly evaluatePlanAdmission?: typeof evaluatePlanAdmission;
  readonly lifetimeSignal?: AbortSignal;
  readonly sessionControlRuntime?: SessionControlRuntime;
  /**
   * Scopes a whole Turn inside the account execution binding (ADR-0055 D10).
   * One mechanism: the shared services stay unproxied and every callback/runtime
   * call inside the Turn resolves through AsyncLocalStorage.
   */
  readonly runInBinding?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly executeUserInput?: (text: string) => Promise<{ exitRequested: boolean }>;
  readonly handleCommand?: (input: string) => Promise<boolean>;
  readonly commandCatalog?: CommandCatalog;
  readonly commandReadServices?: CommandReadServices;
  readonly taskEngine?: TaskEngine;
  /**
   * Long-term memory recall. The Server refreshes the Planner-facing candidate
   * set before a planning turn so that the Planner can reference a memory by
   * id. Failures never block the turn.
   */
  readonly refreshMemoryRecall?: (input: {
    conversationId: string;
    query: string;
  }) => Promise<void>;
  readonly orchestration?: OrchestrationEngine;
  readonly config?: Config;
  readonly taskExecutionApplicationService?: SessionTaskExecutionApplicationService;
  readonly directiveExecutor?: (directive: unknown, userInput: string) => Promise<void>;
  readonly plannerProposalRepo?: PlannerProposalRepo;
  readonly dispose?: () => Promise<void>;
  readonly workspace?: ConversationWorkspacePort;
  /**
   * Runtime-observed Workspace Git readiness for writes. Supplied by
   * composition; the Session never reads Git state itself.
   */
  readonly resolveWorkspaceWriteState?: (workspaceId: string) => WorkspaceWriteState | undefined;
  readonly queryUsage?: {
    readonly lifecycle: QueryUsageLifecycle;
    readonly ingress: QueryIngress;
    readonly usageObserver?: (event: RawUsageEvent) => void;
    readonly usagePayer?: Payer;
    readonly resolveUsagePayer?: UsagePayerResolver;
  };
  /**
   * Compatibility switch for historical low-level tests/replay fixtures.
   * Production semantic Planner ingress keeps this disabled.
   */
}

export class ConversationSession {
  private output: string[] = [];
  private currentTaskId: string | null = null;
  private runtimeState: RuntimeState = {
    runningTaskId: null,
    runningExecutorName: null,
    queuedTaskIds: [],
    needsActionTaskIds: [],
    lastEvent: null,
  };
  private focusContext: { kind: 'conversation' | 'task'; taskId: string | null } | null = null;
  private activePlannerRuns = 0;
  /** Interaction turn id of the turn currently being handled (Client-visible). */
  private activeInteractionTurnId: string | null = null;
  /**
   * Turns the user cancelled. A late Planner proposal for one of them must not
   * be admitted, even when the Planner process managed to submit before the
   * abort landed. Cleared when the next turn starts.
   */
  private readonly cancelledTurnIds = new Set<string>();
  /**
   * Current Planner turn input facts.
   *
   * The eligible attachment set belongs to the Turn, not to a call site: the
   * native Planner submits its proposal through the host bridge, so the plan
   * arrives after the local planning context is out of scope. Every path that
   * builds a proposal reads this one record (in memory while this
   * process ran the turn, otherwise the durable record written at turn start).
   */
  private activePlannerTurn: PlannerTurnFacts | null = null;
  private latestGuidance: GuidanceState | null = null;
  private runningExecutorsByAttempt = new Map<string, { taskId: string; subtaskId: string; name: string }>();
  private backgroundWork = new Set<Promise<void>>();
  private taskTraceTurnIds = new Map<string, string>();
  private pendingTaskTraceResumes = new Map<string, string>();
  private blockedRecheckInFlight = false;
  private lastBlockedRecheckAt: number | null = null;
  private lastTaskPoolWatchdogFingerprint: string | null = null;
  private lastTaskPoolWatchdogReminderAt: number | null = null;
  private kernelExecutionRuntime: ControlExecutionRuntime | null = null;
  private sessionControlRuntime: SessionControlRuntime | null = null;
  private runInBinding: (<T>(operation: () => Promise<T>) => Promise<T>) | null = null;
  private taskExecutionApplicationService: SessionTaskExecutionApplicationService | null = null;
  private workspacePath: string | null = null;
  private readonly inputController: InputController;
  private listeners = new Set<(snapshot: SessionSnapshot) => void>();
  private resultDeliveries: ConversationResultDelivery[] = [];
  private readonly submissionScope = new AsyncLocalStorage<{ turnId: string; detached: boolean }>();
  private readonly backgroundDeliveryScope = new AsyncLocalStorage<ConversationResultDelivery[]>();
  /**
   * Aborts in-flight external routing work for the current Turn. Replaced when a
   * new Turn starts and aborted by the Client stop control, so a Span request
   * cannot outlive the Turn that asked for it.
   */
  private turnCancellation = new AbortController();
  /**
   * Set once the Session is disposed. A disposed Session must never reset its
   * cancellation controller and never admit another proposal, even though the
   * abort above is also used as the live-Turn stop signal.
   */
  private disposed = false;
  private readonly configurationSnapshots = new Map<string, ConfigurationSnapshot>();
  private readonly preparations = new Map<string, {
    fingerprint: string;
    signal: AbortSignal;
    work: Promise<PlanAdmissionRequest | null>;
  }>();
  private attachedClients = 0;
  private disposePromise: Promise<void> | null = null;
  private readonly plannerTurnInputRepo: PlannerTurnInputRepo | null;
  private activeQueryId: string | null = null;

  constructor(private readonly deps: ConversationSessionDeps) {
    this.kernelExecutionRuntime = deps.kernelExecutionRuntime ?? null;
    this.sessionControlRuntime = deps.sessionControlRuntime ?? null;
    this.runInBinding = deps.runInBinding ?? null;
    this.taskExecutionApplicationService = deps.taskExecutionApplicationService ?? null;
    this.plannerTurnInputRepo = deps.db ? new PlannerTurnInputRepo(deps.db) : null;
    this.inputController = new InputController({
      appendUserInput: input => this.appendOutput('', `> ${input}`),
      handleCommand: (input, options) => this.handleCommand(input, options?.principalId),
      handleNaturalLanguageInput: (input, images, attachments, options) =>
        this.handleNaturalLanguageInput(input, images, attachments, options),
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

  async getWorkspace(): Promise<ConversationWorkspaceSelection | null> {
    return this.deps.workspace?.getWorkspace() ?? null;
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
    this.backgroundDeliveryScope.getStore()?.push({ ...delivery });
  }

  getResultDeliveries(): readonly ConversationResultDelivery[] {
    return this.resultDeliveries.map(delivery => ({ ...delivery }));
  }

  setCurrentTaskId(taskId: string | null): void {
    this.currentTaskId = taskId;
    const trace = this.deps.interactionTraceStream?.getSnapshot();
    if (taskId && trace && (trace.status === 'running' || trace.taskId === taskId)) {
      this.taskTraceTurnIds.set(taskId, trace.turnId);
    }
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
    return this.deps.runtimePort.proposals.find(eventId)?.request.requestText ?? '';
  }

  setRunningExecutorName(taskId: string, subtaskId: string, attemptId: string, name: string): void {
    this.runningExecutorsByAttempt.set(attemptId, { taskId, subtaskId, name });
  }

  bindControlExecutionRuntime(runtime: ControlExecutionRuntime): void {
    this.kernelExecutionRuntime = runtime;
  }

  bindSessionControlRuntime(runtime: SessionControlRuntime): void {
    this.sessionControlRuntime = runtime;
  }

  /** Scopes every Turn inside the account execution binding. */
  bindRunInBinding(run: <T>(operation: () => Promise<T>) => Promise<T>): void {
    this.runInBinding = run;
  }

  bindTaskExecutionApplicationService(service: SessionTaskExecutionApplicationService): void {
    this.taskExecutionApplicationService = service;
  }

  recordControlDecisionTrace(decision: ControlDecision): void {
    this.deps.interactionTraceStream?.append({
      phase: 'authorization',
      actor: 'kernel',
      kind: 'kernel_decision',
      title: decision.action.type === 'request_clarification'
        ? '需要补充信息'
        : `Control operation: ${decision.action.type}`,
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
        const routingAudit = action.routing?.[proposalSubtaskId]?.find(item => (
          item.agentClassRef === binding.agentClassRef
        ));
        this.deps.interactionTraceStream?.append({
          phase: 'routing',
          actor: 'kernel',
          kind: 'executor_routed',
          title: fallbackOrder === 0 ? 'Primary Executor authorized' : 'Fallback Executor authorized',
          summary: `${identity.executorDisplayName} via ${identity.harnessDisplayName}`
            + ` using ${identity.providerDisplayName}/${identity.modelDisplayName}`,
          details: {
            fallbackOrder,
            routingRole: fallbackOrder === 0 ? 'primary' : 'fallback',
            ...routedDisplay,
            ...(routingAudit?.spanRouting ? {
              spanRouting: {
                applied: routingAudit.spanRouting.applied,
                reason: routingAudit.spanRouting.reason,
                ...(routingAudit.spanRouting.probabilities?.[binding.modelRef] !== undefined
                  ? { selectedProbability: routingAudit.spanRouting.probabilities[binding.modelRef] }
                  : {}),
              },
            } : {}),
          },
          eventKey: `${decision.id}:${subtaskId}:${fallbackOrder}`,
          taskId: action.taskId,
        });
      });
    }
  }

  appendExecutionTrace(input: ExecutionTraceAppendInput): void {
    let current = this.deps.interactionTraceStream?.getSnapshot();
    if (current?.status !== 'running' && input.taskId) {
      const eventKey = this.pendingTaskTraceResumes.get(input.taskId);
      if (eventKey) {
        this.resumeTaskTrace(input.taskId, eventKey);
        current = this.deps.interactionTraceStream?.getSnapshot();
      }
    }
    if (!current || current.status !== 'running') return;
    if (input.taskId) {
      const ownerTurnId = this.taskTraceTurnIds.get(input.taskId);
      if (ownerTurnId && ownerTurnId !== current.turnId) return;
      if (!ownerTurnId && current.taskId && current.taskId !== input.taskId) return;
    }
    this.deps.interactionTraceStream?.append(input);
  }

  private resumeTaskTrace(taskId: string, eventKey: string): void {
    const stream = this.deps.interactionTraceStream;
    if (!stream) return;
    const current = stream.getSnapshot();
    const ownerTurnId = this.taskTraceTurnIds.get(taskId)
      ?? (current?.taskId === taskId ? current.turnId : null);
    if (!ownerTurnId) return;
    this.taskTraceTurnIds.set(taskId, ownerTurnId);
    stream.resumeTurn({ turnId: ownerTurnId, taskId });
    this.appendExecutionTrace({
      phase: 'execution',
      actor: 'runtime',
      kind: 'execution_resumed',
      title: '任务已重新执行',
      summary: '已在原任务视图中恢复执行，并保留此前的轨迹记录。',
      details: { taskId },
      eventKey,
      taskId,
      traceStatus: 'running',
    });
  }

  async cancelTask(taskId: string, reason: string): Promise<void> {
    await this.kernelExecutionRuntime?.cancelTask(taskId, reason);
  }

  /**
   * Records the Turn's input facts for every later admission step. The durable
   * copy is what makes a bridge resubmission survive a Server restart in the
   * middle of a Planner run; the in-memory copy is the fast path.
   */
  private beginPlannerTurn(
    userInput: string,
    images?: PlannerImageAttachment[],
    attachments?: PlannerAttachmentView[],
  ): void {
    this.activePlannerTurn = {
      userInput,
      ...(images && images.length > 0 ? { images } : {}),
      attachments: attachments ?? [],
    };
    this.plannerTurnInputRepo?.upsert({
      accountId: this.accountId,
      turnId: this.activeInteractionTurnId,
      plannerSessionId: this.deps.plannerSessionId,
      conversationId: this.deps.conversationId,
      userInput,
      attachmentViews: this.activePlannerTurn.attachments,
    });
  }

  private endPlannerTurn(): void {
    this.activePlannerTurn = null;
    this.plannerTurnInputRepo?.clear(this.deps.conversationId);
  }

  /**
   * Turn facts for `userInput`: the in-flight Turn when this process ran it,
   * otherwise the durable record verified against the submitted request text.
   */
  private turnFactsFor(userInput: string): PlannerTurnFacts | null {
    if (this.activePlannerTurn) return this.activePlannerTurn;
    const persisted = this.plannerTurnInputRepo?.read(this.deps.conversationId) ?? null;
    if (!persisted) return null;
    return persisted.userInputHash === plannerTurnInputHash(userInput)
      ? { userInput, attachments: persisted.attachmentViews }
      : null;
  }

  buildPlanningContext(
    userInput: string,
    images?: PlannerImageAttachment[],
    attachments?: PlannerAttachmentView[],
  ): PlanningContext | null {
    if (!this.deps.planningContextBuilder) return null;
    const pendingPermission = this.deps.runtimePort.queries.findOldestPendingPermission(
      this.deps.conversationId,
    );
    return this.deps.planningContextBuilder.build({
      userInput,
      ...(images && images.length > 0 ? { images } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
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
    event: PlanAdmissionRequest,
  ): Extract<ControlSnapshot, { type: 'plan_admission' }> | null {
    const port = this.deps.runtimePort;
    const pinned = this.configurationSnapshots.get(event.configurationRevision);
    const plannerConfiguration = pinned ? buildPlannerConfigurationView(pinned)
      : this.deps.planningContextBuilder?.getPlannerConfiguration();
    const kernelConfiguration = pinned ? buildControlConfigurationView(pinned)
      : this.deps.getControlConfiguration?.() ?? this.deps.kernelConfiguration;
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
      tasks: port.queries.listTasks().map(task => ({
        id: task.id,
        status: task.status,
        ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
        ...(task.executionMode ? { executionMode: task.executionMode } : {}),
        ...(task.workspaceDeliveryPolicy ? { deliveryPolicy: task.workspaceDeliveryPolicy } : {}),
      })),
      activeTaskByConversation: {
        [event.conversationId ?? this.deps.conversationId]: port.queries.getConversationTaskSlot?.(
          event.conversationId ?? this.deps.conversationId,
        )?.activeTaskId ?? null,
      },
      occupiedConversationIds: port.queries.getConversationTaskSlot?.(
        event.conversationId ?? this.deps.conversationId,
      )?.state === 'free'
        ? []
        : [event.conversationId ?? this.deps.conversationId],
      queuedTaskCountByConversation: {
        [event.conversationId ?? this.deps.conversationId]: port.queries.listQueuedTaskIds?.(
          event.conversationId ?? this.deps.conversationId,
        ).length ?? 0,
      },
      activeTaskCount: port.queries.listConversationTaskSlots?.()
        .filter(slot => slot.state === 'occupied' || slot.state === 'releasing').length ?? 0,
      runningTaskId: this.kernelExecutionRuntime?.getSingleActiveTaskId() ?? null,
      plannerConfiguration,
      kernelConfiguration,
      executorStatuses: port.queries.listExecutorStatuses(event.configurationRevision),
      v5WorkGraphTaskIds: port.queries.listWorkGraphTaskIds(),
      eligibleContextRefKeys: this.buildEligibleContextRefKeys(
        event.proposal as PlanningAgentPlan,
        event.requestText,
        event.attachmentIds,
      ),
      pendingAuthorizationRequest: (() => {
        const pending = port.queries.findOldestPendingPermission(this.deps.conversationId);
        return pending ? { requestId: pending.request.id, taskId: pending.request.taskId } : null;
      })(),
    };
  }

  /**
   * Attaches the bounded Span observation before saving the owner proposal. Absent advisor or disabled Span policy
   * leaves the proposal untouched so the deterministic resolver runs.
   *
   * Returns null for Turn cancellation. Replan preparation interrupted by
   * disposal/shutdown remains recoverable; initial submission is rejected.
   * A raw transport abort without a cancellation signal is a preparation
   * failure, not an abandoned proposal.
   */
  private async preparePlanProposal(
    event: PlanAdmissionRequest,
    signal = this.turnCancellation.signal,
    triggerOperationId?: string,
  ): Promise<PlanAdmissionRequest | null> {
    if (this.preparationCancelled(event, signal)) return null;
    const fingerprint = JSON.stringify([planProposalIdentity(event), triggerOperationId ?? null]);
    const persisted = this.deps.runtimePort.proposals.find(event.id);
    if (persisted) {
      if (JSON.stringify([planProposalIdentity(persisted.request), persisted.triggerOperationId]) !== fingerprint) {
        throw new Error('plan proposal identity conflict');
      }
      if (persisted.delivery === 'invalidated') throw new Error('plan proposal invalidated');
      this.preparations.delete(event.id);
      await this.loadConfigurationSnapshot(event.configurationRevision);
      if (this.preparationCancelled(persisted.request, signal)) return null;
      this.deps.runtimePort.proposals.assertAdmissionOpen(event.id);
      return persisted.request;
    }
    const existing = this.preparations.get(event.id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('plan proposal identity conflict');
      const result = await this.awaitPreparation(existing.work, event, signal);
      return existing.signal.aborted || this.preparationCancelled(event, signal) ? null : result;
    }
    for (const id of this.preparations.keys()) {
      if (this.deps.runtimePort.proposals.find(id)) this.preparations.delete(id);
    }
    if (this.preparations.size >= 64) throw new Error('plan preparation capacity exceeded');
    const work = (async () => {
      const result = await this.prepareNewPlanProposal(event, signal);
      if (!result || this.preparationCancelled(result, signal)) return null;
      // Coalesced callers must also await persistence. A failed save cannot
      // let another waiter hand an unrecorded proposal to admission.
      return this.deps.runtimePort.proposals.save({
        request: planAdmissionRequest(result),
        ...(triggerOperationId ? { triggerOperationId } : {}),
      }).request;
    })();
    this.preparations.set(event.id, { fingerprint, signal, work });
    try {
      const result = await this.awaitPreparation(work, event, signal);
      if (!result) this.preparations.delete(event.id);
      if (result && this.preparationCancelled(result, signal)) {
        this.preparations.delete(event.id);
        return null;
      }
      return result;
    } catch (error) {
      this.preparations.delete(event.id);
      throw error;
    }
  }

  /**
   * Preparation seams that honour the Turn signal report cancellation by
   * aborting. An abandoned Turn has nothing to admit, so the abort settles as
   * `null`; disposal or Server shutdown keeps a replan recoverable through
   * `ControlApplicationInterruptedError`. Every other failure, including an
   * adapter-side abort with no cancellation in effect, stays a real error and
   * must never be read as a cancelled proposal.
   */
  private async awaitPreparation(
    work: Promise<PlanAdmissionRequest | null>,
    event: PlanAdmissionRequest,
    signal: AbortSignal,
  ): Promise<PlanAdmissionRequest | null> {
    try {
      return await work;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'AbortError') throw error;
      if (this.preparationCancelled(event, signal)) return null;
      throw error;
    }
  }

  private async loadConfigurationSnapshot(revisionId: string): Promise<ConfigurationSnapshot | undefined> {
    const cached = this.configurationSnapshots.get(revisionId);
    if (cached || !this.deps.resolveConfigurationSnapshot) return cached;
    const snapshot = await this.deps.resolveConfigurationSnapshot(revisionId);
    if (snapshot.revisionId !== revisionId) throw new Error('plan configuration revision mismatch');
    this.configurationSnapshots.set(revisionId, snapshot);
    return snapshot;
  }

  private async prepareNewPlanProposal(original: PlanAdmissionRequest, signal: AbortSignal): Promise<PlanAdmissionRequest | null> {
    if (this.preparationCancelled(original, signal)) return null;
    await this.loadConfigurationSnapshot(original.configurationRevision);
    if (this.preparationCancelled(original, signal)) return null;
    const event = await this.attachWorkspaceAdmission(original);
    return this.preparationCancelled(event, signal) ? null : event;
  }

  /**
   * Resolves the Conversation-bound Workspace into the facts Kernel validates.
   * A missing or unavailable binding is projected as `null` so admission asks
   * for a Workspace instead of guessing one.
   */
  private async attachWorkspaceAdmission(
    event: PlanAdmissionRequest,
  ): Promise<PlanAdmissionRequest> {
    if (event.workspaceAdmission) return event;
    const workspace = await this.deps.workspace?.getWorkspace() ?? null;
    // Runtime owns write readiness: a broken Workspace Git root fails admission
    // with its own reason instead of becoming a user-facing capability question.
    const writeState = workspace
      ? this.deps.resolveWorkspaceWriteState?.(workspace.workspaceId)
      : undefined;
    const targetWorkspace = workspace
      ? {
        workspaceId: workspace.workspaceId,
        canonicalPath: workspace.path,
        ...(writeState ? { writeState } : {}),
      }
      : null;
    return {
      ...event,
      workspaceAdmission: {
        targetWorkspace,
      },
    };
  }

  /**
   * True when this Turn can no longer admit work: the client asked to stop it,
   * or the Session was disposed while external preparation was in flight.
   */
  private preparationCancelled(
    event: Pick<PlanAdmissionRequest, 'proposalSource' | 'sourceTurnId' | 'conversationId'>,
    signal: AbortSignal,
  ): boolean {
    if (this.disposed || this.deps.lifetimeSignal?.aborted) {
      if (event.proposalSource !== 'initial') throw new ControlApplicationInterruptedError();
      return true;
    }
    return signal.aborted || (event.sourceTurnId !== undefined
      && this.deps.runtimePort.turnCancellations.isRequested(
        event.conversationId ?? this.deps.conversationId, event.sourceTurnId,
      ));
  }

  private isCancellationRequested(): boolean {
    return this.disposed || this.deps.lifetimeSignal?.aborted === true
      || this.turnCancellation.signal.aborted || this.isCancelledTurn();
  }

  /**
   * The user cancelled this Turn; a proposal that raced the abort must not create
   * or modify a Task, and must not be admitted on the strength of a late Span
   * observation that arrived after the cancellation.
   */
  private cancelledProposalResult(
    eventId: string,
    planId: string | null,
  ): PlannerProposalResult {
    return {
      status: 'rejected',
      turnId: eventId,
      submissionId: eventId,
      planId,
      rejectionType: 'validation',
      issues: ['turn cancelled by user'],
      kernel: null,
    };
  }

  /**
   * Refresh the long-term memory candidates for this turn. Memory is an
   * optional capability: when it is unavailable the Planner simply plans
   * without it.
   */
  private async refreshMemoryRecall(userInput: string): Promise<void> {
    const refresh = this.deps.refreshMemoryRecall;
    if (!refresh) return;
    try {
      await refresh({ conversationId: this.deps.conversationId, query: userInput });
    } catch {
      // A recall failure must never block the turn.
    }
  }

  /** Releases stale admission state for this Conversation before planning. */
  private async reconcileAdmissionBeforePlanning(): Promise<void> {
    const conversationId = this.deps.conversationId;
    if (!conversationId || !this.kernelExecutionRuntime) return;
    const slot = this.deps.runtimePort.queries.getConversationTaskSlot?.(conversationId);
    if (!slot?.activeTaskId || slot.state === 'free') return;
    try {
      this.kernelExecutionRuntime.reconcileConversationAdmission(conversationId);
    } catch {
      // Reconciliation is best-effort here; the Kernel admission gate and
      // explicit abandon_task control remain the fail-closed safety net.
    }
  }

  async handleNaturalLanguageInput(
    userInput: string,
    images?: PlannerImageAttachment[],
    attachments?: PlannerAttachmentView[],
    options?: InputControllerSubmitOptions,
  ): Promise<void> {
    if (this.deps.workspace && !(await this.deps.workspace.getWorkspace())) {
      throw workspaceError(
        'workspace_required',
        '请先使用 `/workspace /absolute/path` 设置当前 Conversation 的 Workspace。',
      );
    }
    const query = this.beginQuery(userInput, images, attachments, options);
    try {
      const handled = await this.handlePlanningControlDecision(userInput, images, attachments);
      if (handled) return;
      this.appendOutput(
        '-> Task Runtime produced no action for this turn.',
        'Please clarify whether you want to chat, create a new task, resume an existing task, or dispatch an executor.',
      );
    } finally {
      if (query) {
        const lifecycle = this.deps.queryUsage?.lifecycle;
        // Planner returns before a bound Task finishes. Task terminal
        // recovery owns finalization for that asynchronous path.
        if (!lifecycle || lifecycle.getTaskId(query.context.queryId) === null) {
          lifecycle?.finalizeQuery({
            queryId: query.context.queryId,
            finalizedAt: new Date().toISOString(),
          });
        }
        if (this.activeQueryId === query.context.queryId) this.activeQueryId = null;
      }
    }
  }

  private beginQuery(
    userInput: string,
    images: PlannerImageAttachment[] | undefined,
    attachments: PlannerAttachmentView[] | undefined,
    options: InputControllerSubmitOptions | undefined,
  ): Extract<BeginQueryResult, { status: 'created' | 'reused' }> | null {
    const usage = this.deps.queryUsage;
    if (!usage) return null;
    const requestId = options?.requestId ?? `request_${generateInteractionId()}`;
    const requestKey = options?.idempotencyKey ?? requestId;
    const payloadDigest = createHash('sha256')
      .update(JSON.stringify({
        text: userInput,
        images: images ?? [],
        attachments: (attachments ?? []).map(attachment => ({
          attachmentId: attachment.attachmentId,
          mime: attachment.mime,
        })),
      }))
      .digest('hex');
    const result = usage.lifecycle.beginQuery({
      accountId: this.accountId,
      ingress: options?.usageIngress ?? usage.ingress,
      requestKey,
      requestPayloadDigest: payloadDigest,
      conversationId: this.deps.conversationId,
      requestId,
      turnId: this.activeInteractionTurnId,
      executionSegmentId: null,
      acceptedAt: new Date().toISOString(),
    });
    if (result.status === 'conflict') {
      throw new Error('query_request_payload_conflict');
    }
    this.activeQueryId = result.context.queryId;
    return result;
  }

  private async handlePlanningControlDecision(
    userInput: string,
    images?: PlannerImageAttachment[],
    attachments?: PlannerAttachmentView[],
  ): Promise<boolean> {
    const planningAgent = this.deps.runtimePort.planning;
    if (!planningAgent) return false;
    // §5.3.6 pre-admission reconciliation: release legacy blocked+occupied
    // combinations (uncertain cancellations) before the Planner classifies a
    // same-topic conflict, so explicit new work is not held by dead state.
    await this.reconcileAdmissionBeforePlanning();
    this.beginPlannerTurn(userInput, images, attachments);
    await this.refreshMemoryRecall(userInput);
    const context = this.buildPlanningContext(userInput, images, attachments);
    if (!context) {
      this.endPlannerTurn();
      return false;
    }
    this.appendTrace({
      phase: 'planning',
      actor: 'planner',
      kind: 'planner_started',
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
        submit: async rawPlan => {
          // The Runtime owns identity/plumbing: schemaVersion, source and the
          // proposal id come from here, so the model cannot get them wrong.
          const plan = normalizePlanningAgentPlanInput(rawPlan, {
            configurationRevision: context.configuration.revisionId,
            id: `plan_${context.request.sessionId}_${this.activeInteractionTurnId ?? 'turn'}`,
          });
          // Cancellation/disposal wins over validation: the late proposal must
          // report the cancelled Turn, not a schema complaint.
          if (this.isCancelledTurn() || this.disposed) {
            return this.submitValidatedPlannerProposal(userInput, plan as PlanningAgentPlan);
          }
          // One validation point; failures become repair feedback instead of a
          // raw storage error or a fatal turn.
          const normalizedPlan = plan;
          const validation = validatePlanningAgentPlan(
            normalizedPlan,
            context.configuration,
            context.pendingAuthorizationRequest,
            context.replan,
          );
          if (!validation.valid) {
            return {
              status: 'rejected',
              turnId: `plan_event_${String((plan as { id?: unknown } | null)?.id ?? 'unknown')}`,
              submissionId: `plan_submission_${generateInteractionId()}`,
              planId: typeof (plan as { id?: unknown } | null)?.id === 'string'
                ? (plan as { id: string }).id : null,
              rejectionType: 'validation',
              issues: validation.errors,
              kernel: null,
            };
          }
          return this.submitValidatedPlannerProposal(userInput, plan as PlanningAgentPlan);
        },
        onProgress: progress => this.recordPlannerProgressTrace(progress),
        onUsage: usage => this.recordPlannerUsage(usage, context.configuration.revisionId),
      });
    } catch (error) {
      if (this.isCancelledTurn()) {
        // The user cancelled the turn; the aborted Planner process is an
        // expected consequence, not a failure to report.
        this.appendTurnCancelledTrace('本轮到用户取消为止，未创建任务。');
        return true;
      }
      this.appendTrace({
        phase: 'planning',
        actor: 'planner',
        kind: 'planner_failed',
        title: 'Planner failed',
        summary: (error as Error).message,
        details: {},
        eventKey: 'planner_failed',
        traceStatus: 'failed',
      });
      throw error;
    } finally {
      this.activePlannerRuns = Math.max(0, this.activePlannerRuns - 1);
      this.endPlannerTurn();
      this.notify();
    }
    if (this.isCancelledTurn()) {
      this.appendTurnCancelledTrace('用户取消了本轮；Planner 结果未被采纳。');
      return true;
    }
    this.recordPlannerProposalTerminalTrace(result);
    if (result.status === 'accepted' && result.outcome === 'no_action') {
      this.appendOutput(result.displayText);
    }
    if (result.status === 'convergence_exhausted') {
      const label = result.reason === 'processing_cycles'
        ? '处理轮次'
        : result.reason === 'non_proposal_tool_calls' ? '非提案工具调用' : '重复被拒';
      const cause = result.issues && result.issues.length > 0
        ? `被拒原因：${result.issues.join('；')}。`
        : '';
      this.appendOutput(
        `错误: Planner 未能在限定的规划预算内完成方案（${label} ${result.observed}/${result.limit}）。`
        + `${cause}本轮未创建任务，请重试或缩小请求范围。`,
      );
      return true;
    }
    if (result.status === 'transport_uncertain' || result.status === 'conflict') {
      throw new Error(result.message);
    }
    return result.status === 'accepted' || result.status === 'rejected';
  }

  private recordPlannerUsage(usage: HarnessUsageEvent, configurationRevision: string): void {
    const queryId = this.activeQueryId;
    const observer = this.deps.queryUsage?.usageObserver;
    if (!queryId || !observer) return;
    const now = new Date().toISOString();
    observer({
      sourceId: 'planner',
      // Pi may omit a message id and the supervisor then uses a turn-local
      // fallback. Scope that fallback to the Query before SQLite's global
      // metering uniqueness constraint is applied.
      sourceEventKey: `${queryId}:${usage.sourceEventKey}`,
      sourceScope: 'model_request',
      callId: `${queryId}:${usage.callId}`,
      queryId,
      executionSegmentId: null,
      taskId: null,
      stage: 'planning',
      reason: 'primary',
      payer: this.deps.queryUsage?.resolveUsagePayer?.(usage.providerRef ?? this.deps.plannerProviderRef, configurationRevision)
        ?? this.deps.queryUsage?.usagePayer ?? 'unknown',
      capturedAt: usage.occurredAtUtc ?? now,
      providerResponseId: usage.providerResponseId,
      providerBindingVersion: this.deps.plannerBindingFingerprint ?? null,
      evidenceRef: `query:${queryId}`,
      agentClassRef: usage.agentClassRef ?? 'planner',
      providerRef: usage.providerRef ?? this.deps.plannerProviderRef ?? null,
      modelId: usage.modelId ?? this.deps.plannerModelId ?? null,
      counters: usage.counters,
      missing: usage.missing,
    });
  }

  /**
   * The single admission path for a Planner proposal, shared by the in-process
   * submitter callback and by the host-bridge submission. It takes no context:
   * the Turn facts (attachments, request text) come from one record, so the two
   * entry points cannot drift apart.
   */
  private async submitValidatedPlannerProposal(
    userInput: string,
    plan: PlanningAgentPlan,
    eventId = `plan_event_${plan.id}_${generateInteractionId()}`,
  ): Promise<PlannerProposalResult> {
    const signal = this.turnCancellation.signal;
    if (this.isCancelledTurn() || this.disposed) {
      return this.cancelledProposalResult(eventId, plan.id);
    }
    // Invalid model-generated references are repair feedback, not a question
    // for the user. Validate before saving/admitting the proposal so the same
    // bounded Manager turn can correct it without creating a waiting Task.
    const eligible = new Set(this.buildEligibleContextRefKeys(plan, userInput,
      (this.turnFactsFor(userInput)?.attachments ?? []).map(item => item.attachmentId)));
    const invalidRefs = [...new Set((plan.workGraph?.subtasks ?? []).flatMap(subtask =>
      subtask.contextRefs.map(contextRefKey).filter(key => !eligible.has(key))))];
    if (invalidRefs.length) {
      return {
        status: 'rejected', turnId: plan.id, submissionId: eventId, planId: plan.id,
        rejectionType: 'validation', kernel: null,
        issues: [`Unavailable context references: ${invalidRefs.join(', ')}. Use current_user_input for this request. For history, read the context tool and copy an exact eligible interaction ID; a Conversation ID is not an interaction ID. Do not ask the user to repair internal references.`],
      };
    }
    const port = this.deps.runtimePort;
    const sessionControlRuntime = this.sessionControlRuntime;
    if (!sessionControlRuntime) {
      if (this.deps.executeUserInput) {
        await this.deps.executeUserInput(userInput);
      }
      return { status: 'accepted' } as PlannerProposalResult;
    }

    let event: PlanAdmissionRequest | null;
    try {
      event = await this.preparePlanProposal(this.buildPlanProposal({
        plan,
        configurationRevision: this.deps.planningContextBuilder
          ?.getPlannerConfiguration().revisionId ?? null,
        attachmentIds: (this.turnFactsFor(userInput)?.attachments ?? [])
          .map(attachment => attachment.attachmentId),
        proposalSource: 'initial',
        eventId,
        workspaceId: (await this.getWorkspace())?.workspaceId,
        taskId: plan.task.taskId ?? undefined,
        requestText: userInput,
        generationId: `generation_${eventId}`,
        targetGraphRevision: 1,
      }), signal);
    } catch (error) {
      // External preparation is abortable; a cancelled Turn must fail closed
      // instead of surfacing as an uncertain transport failure.
      if (this.isCancellationRequested()) return this.cancelledProposalResult(eventId, plan.id);
      throw error;
    }
    if (!event || signal.aborted || this.isCancellationRequested()) {
      // Cancellation can arrive while the external advisor is still running and
      // does not always abort it; never admit the proposal in that window.
      return this.cancelledProposalResult(eventId, plan.id);
    }

    port.proposals.assertAdmissionOpen(event.id);
    const kernelSnapshot = this.buildPlanAdmissionSnapshot(event);
    if (!kernelSnapshot) {
      return {
        status: 'transport_uncertain',
        turnId: plan.id,
        submissionId: eventId,
        retryableByReplay: true,
        message: 'Admission snapshot is unavailable for this configuration revision.',
      };
    }
    // One admission policy, evaluated here: no Kernel event, decision or
    // application record is created for a plan proposal any more.
    const admission = (this.deps.evaluatePlanAdmission ?? evaluatePlanAdmission)(
      event,
      planAdmissionSnapshotFromControl(kernelSnapshot),
    );
    const applied = await sessionControlRuntime.applyPlanAdmission(admission, {
      proposalId: event.id,
      userInput: event.requestText,
      ...(event.conversationId ? { conversationId: event.conversationId } : {}),
      queryId: event.queryId ?? null,
    });
    // A failed application leaves the proposal pending so the same submission
    // can be replayed; only a durable outcome records the hand-off.
    port.proposals.markForwarded(event.id, new Date().toISOString());
    if (applied.status === 'rejected') {
      return {
        status: 'rejected',
        turnId: plan.id,
        submissionId: eventId,
        planId: plan.id,
        rejectionType: 'kernel',
        issues: [admission.reason],
        kernel: {
          decisionId: applied.operationId,
          action: 'reject_request',
          reason: admission.reason,
        },
      };
    }
    const taskId = applied.taskId ?? plan.task.taskId ?? null;
    if (this.activeQueryId && taskId) {
      const binding = this.deps.queryUsage?.lifecycle.bindTask({
        queryId: this.activeQueryId,
        taskId,
        decisionId: applied.operationId,
        basis: 'authorized_application',
        linkedAt: new Date().toISOString(),
      });
      if (binding?.status === 'conflict') {
        throw new Error('query_task_attribution_conflict');
      }
    }
    return {
      status: 'accepted',
      turnId: plan.id,
      submissionId: eventId,
      planId: plan.id,
      outcome: plannerAdmissionOutcome(applied.status),
      displayText: plannerAdmissionDisplayText(applied, admission, this.output.at(-1)),
      taskId,
      kernel: {
        decisionId: applied.operationId,
        action: plannerAdmissionAction(applied.status),
        reason: admission.reason,
      },
    };
  }

  clearRunningExecutorName(_taskId: string, attemptId?: string): void {
    if (attemptId) this.runningExecutorsByAttempt.delete(attemptId);
  }

  startBackgroundExecution(taskId: string, launch: () => Promise<void>): Promise<void> {
    const submission = this.submissionScope.getStore();
    const deliveries: ConversationResultDelivery[] = [];
    const trace = this.deps.interactionTraceStream?.getSnapshot();
    if (trace?.status === 'running') {
      this.taskTraceTurnIds.set(taskId, trace.turnId);
    }
    let promise!: Promise<void>;
    promise = Promise.resolve()
      .then(() => this.backgroundDeliveryScope.run(deliveries, launch))
      .catch(() => undefined)
      .finally(async () => {
        this.backgroundWork.delete(promise);
        if (submission?.detached && this.deps.onBackgroundResultDelivery) {
          for (const delivery of deliveries) {
            try {
              await this.deps.onBackgroundResultDelivery(delivery, submission.turnId);
            } catch {
              this.appendOutput('后台结果交付失败；执行回执已保留，请刷新任务查看结果。');
            }
          }
        }
      });
    this.backgroundWork.add(promise);
    return promise;
  }

  hasBackgroundWork(): boolean {
    if (this.backgroundWork.size > 0) return true;
    if (!this.currentTaskId) return false;
    if (this.deps.runtimePort.queries.listQueuedTaskIds(this.conversationId).includes(this.currentTaskId)) return true;
    const task = this.deps.runtimePort.queries.findTask(this.currentTaskId);
    return task?.status === 'running'
      || Boolean(
        task?.status === 'needs_action'
        && task.dependencies.some(dependency =>
          dependency.type === 'kernel_retry' && dependency.status === 'waiting'
        ),
      );
  }

  refreshRuntimeState(): void {
    const tasks = this.deps.runtimePort.queries.listTasks()
      .filter(task => task.conversationId === this.deps.conversationId);
    const runningTask = tasks.find(task => task.status === 'running') ?? null;
    this.runtimeState = {
      runningTaskId: runningTask?.id ?? null,
      runningExecutorName: null,
      queuedTaskIds: tasks.filter(task => task.status === 'queued').map(task => task.id),
      needsActionTaskIds: tasks.filter(task => task.status === 'needs_action').map(task => task.id),
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
        queuedTaskIds: [...this.runtimeState.queuedTaskIds],
        needsActionTaskIds: [...this.runtimeState.needsActionTaskIds],
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
    options: InputControllerSubmitOptions & { principalId?: string } = {},
  ): Promise<WorkspaceCommandResult | void> {
    switch (command.kind) {
      case 'user_message':
        await this.submitUserInput(command.text, options);
        return;
      case 'slash_command':
        if (/^\/task\s+(?:dashboard|show|list)(?:\s|$)/iu.test(command.text.trim())) {
          // A concurrent read must not replace the active turn's cancellation
          // controller or trace, as submitUserInput would do.
          await this.handleCommand(command.text.trim(), options.principalId ?? 'unknown');
          return;
        }
        if (/^\/status(?:\s|$)/u.test(command.text.trim())) {
          // L5: instant status snapshot — answered locally from the live
          // interaction trace, never routed to the Planner (works mid-turn).
          this.appendOutput(...this.buildTaskStatusLines());
          return;
        }
        if (
          'workspaceMutation' in command
          && (command as unknown as { workspaceMutation?: unknown }).workspaceMutation
        ) {
          throw new Error('Workspace selection must be handled by ClientGateway');
        }
        await this.submitUserInput(command.text, options);
        return;
      case 'permission_resolution':
        await this.resolvePermission(command.requestId, command.resolution, 'button', null, undefined,
          { principalId: options.principalId ?? 'unknown', commandRequestId: options.requestId ?? null });
        return;
      case 'permission_resolution_v2':
        await this.resolvePermission(command.requestId, command.resolution, 'button', null,
          { expectedRevision: command.requestRevision, expectedGenerationId: command.expectedExecutionGeneration },
          { principalId: options.principalId ?? 'unknown', commandRequestId: options.requestId ?? null });
        return;
      case 'cancel_turn':
        await this.cancelActiveTurn(command.turnId);
        return;
      case 'accept_task_result':
      case 'retry_task_attempt': {
        const expected = command.expectedResult;
        const task = this.deps.runtimePort.queries.findTask(expected.taskId);
        if (!task || task.accountId !== this.deps.runtimePort.accountId || task.conversationId !== this.deps.conversationId) {
          throw new Error('task_scope_mismatch');
        }
        if (!this.kernelExecutionRuntime) throw new Error('task_control_unavailable');
        if (command.kind === 'accept_task_result') await this.kernelExecutionRuntime.acceptPartialResult(task.id, expected);
        else {
          const eventKey = `retry:${expected.attemptId}:${expected.resultId}`;
          this.pendingTaskTraceResumes.set(task.id, eventKey);
          try {
            await this.kernelExecutionRuntime.retryTaskResult(task.id, expected);
            this.resumeTaskTrace(task.id, eventKey);
          } finally {
            this.pendingTaskTraceResumes.delete(task.id);
          }
        }
        this.refreshRuntimeState();
        this.appendOutput(command.kind === 'accept_task_result' ? '已接受结果，正在检查并交付。' : '已请求重新执行，原结果和历史记录保留。');
        if (command.kind === 'accept_task_result') this.settleTurnAfterTaskControl(task.id);
        return;
      }
      case 'cancel_task': {
        const task = this.deps.runtimePort.queries.findTask(command.taskId);
        if (!task || task.accountId !== this.deps.runtimePort.accountId || task.conversationId !== this.deps.conversationId) {
          throw new Error('task_scope_mismatch');
        }
        const generation = this.deps.runtimePort.queries.findActiveWorkGraphRevision(task.id)?.generationId
          ?? `unplanned:${task.id}`;
        if (generation !== command.expectedExecutionGeneration) throw new Error('task_generation_conflict');
        if (!this.kernelExecutionRuntime) throw new Error('task_control_unavailable');
        await this.kernelExecutionRuntime.cancelTask(task.id, '用户请求停止此任务');
        this.appendOutput(`已请求停止任务 ${task.id}；等待执行清理完成。`);
        this.settleTurnAfterTaskControl(task.id);
        return;
      }
    }
  }

  private isCancelledTurn(): boolean {
    return this.activeInteractionTurnId !== null
      && (this.cancelledTurnIds.has(this.activeInteractionTurnId)
        || this.deps.runtimePort.turnCancellations.isRequested(
          this.deps.conversationId, this.activeInteractionTurnId,
        ));
  }

  /**
   * Turn cancellation: latch the turn, abort the in-flight Planner process
   * without closing its session, and stop work that already became a Task in
   * this Conversation. Late proposals are dropped by `isCancelledTurn()`.
   */
  private async cancelActiveTurn(requestedTurnId: string): Promise<void> {
    const active = this.deps.interactionTraceStream?.getSnapshot() ?? null;
    const targetTurnId = active?.status === 'running' ? active.turnId : null;
    if (!targetTurnId) {
      this.appendOutput('该轮次已不在执行中；后台任务请按任务目标停止。');
      return;
    }
    if (requestedTurnId && requestedTurnId !== targetTurnId) {
      this.appendOutput('该轮次已不在执行中。');
      return;
    }
    // Persist before acknowledging or aborting. A restarted Session must fence
    // late proposals even though the in-memory controller and latch are gone.
    this.deps.runtimePort.turnCancellations.request(
      this.deps.conversationId, targetTurnId, new Date().toISOString(),
    );
    this.cancelledTurnIds.add(targetTurnId);
    // Abort external routing work still in flight for this Turn.
    this.turnCancellation.abort();
    this.appendTrace({
      phase: 'planning',
      actor: 'runtime',
      kind: 'turn_cancel_requested',
      title: 'Turn cancellation requested',
      summary: '用户请求取消当前轮。',
      details: {},
      eventKey: 'turn_cancel_requested',
    });
    this.appendOutput('-> 已请求取消当前轮。');
    let plannerCancellationRequested = false;
    const cancelPlannerTurn = this.deps.runtimePort.commands.cancelPlannerTurn;
    if (cancelPlannerTurn && this.activePlannerRuns > 0) {
      try {
        await cancelPlannerTurn(this.deps.plannerSessionId);
        plannerCancellationRequested = true;
      } catch (error) {
        this.appendOutput(`终止 Planner 进程失败：${(error as Error).message}`);
      }
    }
    const taskId = active?.taskId
      ?? [...this.taskTraceTurnIds].find(([, turnId]) => turnId === targetTurnId)?.[0]
      ?? (this.activePlannerRuns > 0
        ? this.getCurrentTaskId()
          ?? this.deps.runtimePort.queries.getConversationTaskSlot?.(this.deps.conversationId)?.activeTaskId
        : null);
    const taskCancellationRequested = taskId
      ? await this.cancelConversationWork(taskId, '用户取消了当前轮') : false;
    if (plannerCancellationRequested || taskCancellationRequested || (!taskId && this.activePlannerRuns === 0)) {
      // Closing the Turn is a presentation fact. Executor cleanup continues
      // asynchronously and keeps the Conversation admission slot occupied
      // until the durable cancellation drain converges.
      this.appendTurnCancelledTrace('用户已请求取消本轮；后台清理继续进行。');
    }
    this.notify();
  }

  private async cancelConversationWork(taskId: string, reason: string): Promise<boolean> {
    const runtime = this.kernelExecutionRuntime;
    if (!runtime) return false;
    try {
      await runtime.cancelTask(taskId, reason);
      this.appendOutput(`已取消任务 ${taskId} 的后续执行。`);
      return true;
    } catch (error) {
      this.appendOutput(`取消任务失败：${(error as Error).message}`);
      return false;
    }
  }

  private appendTurnCancelledTrace(summary: string): void {
    this.appendTrace({
      phase: 'planning',
      actor: 'runtime',
      kind: 'turn_cancelled',
      title: 'Turn cancelled',
      summary,
      details: {},
      eventKey: 'turn_cancelled',
      traceStatus: 'cancelled',
    });
  }

  /** Close a user control Turn when the durable Task has already reached a terminal conclusion. */
  private settleTurnAfterTaskControl(taskId: string): void {
    this.settleRunningTurnForFinishedTask(taskId, { maxIdleMs: null });
  }

  /** Repair stale running Turns left by an earlier process or asynchronous control completion. */
  private settleStaleTurnAfterRestart(nowMs = Date.now()): void {
    const taskId = this.currentTaskId;
    if (!taskId) return;
    this.settleRunningTurnForFinishedTask(taskId, { maxIdleMs: 15_000, nowMs });
  }

  private settleRunningTurnForFinishedTask(
    taskId: string,
    options: { maxIdleMs: number | null; nowMs?: number },
  ): void {
    const trace = this.deps.interactionTraceStream?.getSnapshot() ?? null;
    if (!trace || trace.status !== 'running' || trace.taskId !== taskId) return;
    if (options.maxIdleMs !== null) {
      const lastAt = trace.events.at(-1)?.occurredAt ?? trace.startedAt;
      const idleMs = (options.nowMs ?? Date.now()) - Date.parse(lastAt);
      if (!Number.isFinite(idleMs) || idleMs < options.maxIdleMs) return;
    }
    const task = this.deps.runtimePort.queries.findTask(taskId);
    if (!task) return;
    const traceStatus = task.status === 'cancelled' ? 'cancelled'
      : task.status === 'succeeded' ? 'completed'
        : task.status === 'failed' ? 'failed' : null;
    if (!traceStatus) return;
    this.appendTrace({
      phase: 'delivery', actor: 'runtime', kind: 'turn_settled',
      title: traceStatus === 'completed' ? 'Turn completed' : `Turn ${traceStatus}`,
      summary: traceStatus === 'completed' ? '任务已完成，用户决策已应用。' : `任务已结束：${task.status}。`,
      details: { taskId, taskStatus: task.status }, eventKey: 'turn_settled', traceStatus,
    });
  }

  private buildTaskStatusLines(): string[] {
    const taskId = this.getSnapshot().currentTaskId;
    const task = taskId ? this.deps.runtimePort.queries.findTask(taskId) : null;
    const trace = this.deps.interactionTraceStream?.getSnapshot() ?? null;
    return buildTaskStatusLines({
      taskTitle: task?.title ?? null,
      taskStatus: task?.status ?? null,
      startedAt: trace?.startedAt ?? null,
      traceEvents: trace?.events ?? [],
    });
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

  private async resolvePermission(
    requestId: string,
    resolution: 'approve' | 'deny',
    source: 'button' | 'planner',
    plannerPlanId: string | null = null,
    expected?: { expectedRevision: string; expectedGenerationId: string },
    actor?: { readonly principalId: string; readonly commandRequestId: string | null },
  ) {
    const permissionService = this.deps.runtimePort.permissions;
    if (!permissionService) throw new Error('Account permission service is unavailable');
    const result = await permissionService.resolve({
      sessionId: this.plannerSessionId,
      requestId,
      resolution,
      source,
      plannerPlanId,
      ...expected,
      ...(actor ? { actor } : {}),
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

  async submitPlannerProposal(
    submission: PlannerProposalSubmission,
    purpose: PlannerProposalPurpose = 'kernel',
  ): Promise<PlannerProposalResult> {
    const run = this.runInBinding;
    return run ? run(() => this.runPlannerProposal(submission, purpose))
      : this.runPlannerProposal(submission, purpose);
  }

  private async runPlannerProposal(
    submission: PlannerProposalSubmission,
    purpose: PlannerProposalPurpose,
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
    const turnFacts = this.turnFactsFor(userInput);
    const context = this.buildPlanningContext(
      userInput,
      turnFacts?.images,
      turnFacts?.attachments,
    );
    // The active revision is authoritative: the proposal declares it, so the
    // Runtime supplies it instead of trusting a copied string.
    const normalizedPlan = normalizePlanningAgentPlanInput(submission.plan, {
      configurationRevision: context?.configuration.revisionId,
    });
    const parsed = PlanningAgentPlanSchema.safeParse(normalizedPlan);
    // Validation uses the same Turn facts the Planner was given. The admission
    // event itself no longer takes this context: `submitValidatedPlannerProposal`
    // reads the Turn record, so both submission paths share one source.
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
          context.replan,
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
    const turn = repo.ensureTurn(sessionId, turnId, userInput, this.activeInteractionTurnId);
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
        displayText: 'PlanningAgentPlan v9 proposal validated by MetaWork.',
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
        eventId!,
      );
      if (result.status === 'accepted' || result.status === 'rejected') {
        if (
          result.status === 'accepted'
          && result.kernel?.action === 'record_permission_resolution'
          && parsed.data.authorizationResolution
        ) {
          await this.resolvePermission(
            parsed.data.authorizationResolution.requestId,
            parsed.data.authorizationResolution.resolution,
            'planner',
            parsed.data.id,
          );
        }
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
      if (result.status === 'convergence_exhausted') {
        return result;
      }
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
    const run = this.runInBinding;
    return run ? run(() => this.runUserInput(text, options)) : this.runUserInput(text, options);
  }

  private async runUserInput(
    text: string,
    options: InputControllerSubmitOptions,
  ): Promise<{ exitRequested: boolean }> {
    const userInput = text.trim();
    this.workspacePath = (await this.getWorkspace())?.path ?? this.workspacePath;
    const startsTrace = shouldStartInteractionTrace(userInput);
    const interactionTurnId = options.interactionTurnId ?? `turn_${generateInteractionId()}`;
    // A new turn supersedes any cancellation latch from the previous one.
    this.cancelledTurnIds.clear();
    this.turnCancellation = new AbortController();
    this.activeInteractionTurnId = interactionTurnId;
    if (startsTrace) {
      this.deps.interactionTraceStream?.beginTurn({
        turnId: interactionTurnId,
        userInput,
      });
    }
    const result = await this.submissionScope.run({
      turnId: interactionTurnId,
      detached: userInput.startsWith('/') && !options.awaitAsyncWork,
    }, () => this.inputController.submit(text, options));
    this.workspacePath = (await this.getWorkspace())?.path ?? this.workspacePath;
    if (
      startsTrace
      && userInput.startsWith('/')
    ) {
      const current = this.deps.interactionTraceStream?.getSnapshot();
      if (current?.turnId === interactionTurnId && current.status === 'running') {
        this.deps.interactionTraceStream?.append({
          phase: 'delivery',
          actor: 'runtime',
          kind: 'command_completed',
          title: 'Command completed',
          summary: 'The control command replied; continuing execution is tracked by Task activity.',
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
          title: 'Planner handoff confirmed',
          summary: 'Planner completed the structured proposal handoff.',
        });
    }
  }

  private recordPlannerProposalTerminalTrace(result: PlannerProposalResult): void {
    const current = this.deps.interactionTraceStream?.getSnapshot();
    if (!current || current.status !== 'running') return;
    if (result.status === 'accepted') {
      if (result.outcome !== 'clarification_requested') return;
      this.appendTrace({
        phase: 'delivery',
        actor: 'runtime',
        kind: 'clarification_requested',
        title: 'Clarification requested',
        summary: result.displayText,
        details: {
          plannerTurnId: result.turnId,
          submissionId: result.submissionId,
          decisionId: result.kernel?.decisionId ?? null,
        },
        eventKey: `${result.submissionId}:clarification`,
        traceStatus: 'completed',
      });
      return;
    }
    const status = result.status === 'rejected' ? 'failed' : 'blocked';
    this.appendTrace({
      phase: 'planning',
      actor: 'planner',
      kind: result.status === 'transport_uncertain'
        ? 'proposal_transport_uncertain'
        : result.status === 'conflict'
          ? 'proposal_conflict'
          : result.status === 'convergence_exhausted'
            ? 'planner_convergence_exhausted'
            : 'proposal_rejected',
      title: result.status === 'transport_uncertain'
        ? 'Planner handoff blocked'
        : result.status === 'conflict'
          ? 'Planner proposal conflict'
          : result.status === 'convergence_exhausted'
            ? 'Planner convergence exhausted'
            : 'Planner proposal rejected',
      summary: result.status === 'rejected' ? result.issues.join('; ') : result.message,
      details: {
        plannerTurnId: result.turnId,
        ...(result.status === 'convergence_exhausted'
          ? {
              convergenceReason: result.reason,
              limit: result.limit,
              observed: result.observed,
            }
          : { submissionId: result.submissionId }),
      },
      eventKey: result.status === 'convergence_exhausted'
        ? `convergence:${result.reason}`
        : result.submissionId,
      traceStatus: status,
    });
  }

  private async handleCommand(input: string, principalId = 'unknown'): Promise<boolean> {
    if (/^\/workspace(?:\s|$)/u.test(input)) {
      throw workspaceError(
        'workspace_command_invalid',
        `Workspace selection for ${principalId} must be handled by ClientGateway`,
      );
    }
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
    if (result.type === 'error') {
      throw commandError(result.code, result.content);
    }
    if (!(result.type === 'directive' && result.directive.kind === 'resume-task')) {
      this.appendOutput(result.content);
    }
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
      expectedGenerationId?: string;
      expectedGraphRevision?: number;
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
      expectedGenerationId?: string;
      expectedGraphRevision?: number;
      newlyProvidedResources?: string[];
      blockedReason?: string;
    },
  ): Promise<void> {
    const taskExecutionApplicationService = this.taskExecutionApplicationService;
    if (!taskExecutionApplicationService) return;
    const resumedTask = this.deps.runtimePort.queries.findTask(taskId);
    if (!resumedTask) return;
    this.setCurrentTaskId(resumedTask.id);
    const started = taskExecutionApplicationService.prepareTaskExecution(resumedTask.id, {
      userPrompt: resumedTask.goal,
      contextTaskId: resumedTask.id,
      expectedGenerationId: directive.expectedGenerationId,
      expectedGraphRevision: directive.expectedGraphRevision,
      executionMode: directive.mode ?? 'resume-parked',
      schedulingReason: directive.mode === 'resume-blocked' ? '继续处理' : '恢复已暂停任务',
      newlyProvidedResources: directive.newlyProvidedResources,
      recoveryTrigger: directive.mode === 'resume-blocked'
        ? this.buildRecoveryTrigger(resumedTask, {
            kind: 'explicit-task-command',
            blockedReason: directive.blockedReason,
            triggerReason: directive.newlyProvidedResources?.length ? '显式继续处理并补充材料' : '显式继续处理',
            sourceInput: userInput,
            newlyProvidedResources: directive.newlyProvidedResources,
          })
        : undefined,
    });
    const decision = await started.decision;
    if (!decision) {
      await started.completion;
      this.appendOutput(`任务 #${taskId} 恢复请求未产生权威控制操作`);
      return;
    }
    this.appendOutput(formatTaskResumeDecision(taskId, decision, resumedTask.status));
    if (decision.action.type !== 'resume_task') await started.completion;
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
    const task = port.queries.findTask(taskId);
    const applications = port.queries.listRecoveryApplications(taskId).map(item => {
      // The user-facing diagnostic must name the declared postcondition verdict
      // that recovery itself acts on, not just a raw application status.
      const diagnosis = port.queries.diagnoseRecoveryApplication(item.decisionId);
      const detail = diagnosis
        ? ` -> ${diagnosis.family}/${diagnosis.verdict}: ${diagnosis.reason}`
        : '';
      return `- ${item.id} [application/${item.status}] ${item.decision.action.type}: `
        + `${item.errorSummary ?? 'no error summary'}${detail}`;
    });
    const effects = port.queries.listRecoveryEffects(taskId).map(item =>
      `- ${item.id} [effect/${item.status}] ${item.effectType}: ${item.errorSummary ?? 'no error summary'}`
    );
    const items = [...applications, ...effects];
    if (items.length === 0) {
      const emptyRecovery = formatEmptyTaskRecovery(taskId, {
        status: task?.status,
        blockerReason: task?.dependencies
          .filter(dependency => dependency.status === 'waiting')
          .map(dependency => dependency.description)
          .filter(Boolean)
          .join('；'),
      });
      if (emptyRecovery) return emptyRecovery;
    }
    return items.length > 0
      ? `Task #${taskId} recovery items:\n${items.join('\n')}`
      : `Task #${taskId} has no uncertain or failed recovery items.`;
  }

  private buildRecoverySnapshot(
    taskId: string,
    recoveryItemId: string,
  ): Extract<ControlSnapshot, { type: 'recovery' }> {
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
    // The recovery item pins the configuration it was applied with; the effect
    // row carries no revision and there is no ledger row to consult.
    const configurationRevision = application?.decision.configurationRevision ?? null;
    if (!configurationRevision) {
      throw new Error(`recovery item has no persisted configuration revision: ${input.recoveryItemId}`);
    }
    const event: Extract<ControlEvent, { type: 'recovery_resolution_requested' }> = {
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
    await port.commands.submitControl(event, {
      buildSnapshot: claimed => {
        const recovery = claimed as Extract<ControlEvent, { type: 'recovery_resolution_requested' }>;
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

  private buildEligibleContextRefKeys(
    plan: PlanningAgentPlan,
    userInput: string,
    attachmentIds: readonly string[] = [],
  ): string[] {
    return buildEligibleContextRefKeys({
      db: this.deps.db ?? null,
      sessionId: this.deps.plannerSessionId,
      conversationId: this.deps.conversationId,
      accountId: this.deps.runtimePort.accountId,
      refs: (plan.workGraph?.subtasks ?? []).flatMap(subtask => subtask.contextRefs),
      attachmentIds,
      targetTask: plan.task.taskId
        ? this.deps.runtimePort.queries.findTask(plan.task.taskId)
        : null,
      userInput,
    });
  }

  /**
   * The only place a Conversation admission request is constructed.
   *
   * `attachmentIds` is a required input so no call site can silently drop the
   * Turn's eligible attachment set: an omitted set makes every
   * `{ kind: 'attachment' }` ContextRef fail Kernel admission, which is how the
   * bridge submission path used to lose current-Turn attachments.
   */
  private buildPlanProposal(input: {
    plan: PlanningAgentPlan;
    configurationRevision: string | null;
    attachmentIds: readonly string[];
    proposalSource: 'initial' | 'replan' | 'conflict_replan';
    eventId: string;
    taskId?: string;
    workspaceId?: string;
    requestText: string;
    generationId: string;
    targetGraphRevision: number;
    availabilityExplanation?: string | null;
  }): PlanAdmissionRequest {
    if (!input.configurationRevision) throw new Error('plan configuration revision is missing');
    return {
      configurationRevision: input.configurationRevision,
      ...(this.activeInteractionTurnId ? { sourceTurnId: this.activeInteractionTurnId } : {}),
      ...(this.activeQueryId ? { queryId: this.activeQueryId } : {}),
      id: input.eventId,
      occurredAt: new Date().toISOString(),
      sessionId: this.deps.plannerSessionId,
      conversationId: this.deps.conversationId,
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      proposal: input.plan,
      requestText: input.requestText.slice(0, 24_000),
      generationId: input.generationId,
      proposalSource: input.proposalSource,
      targetGraphRevision: input.targetGraphRevision,
      attachmentIds: [...input.attachmentIds],
      ...(input.availabilityExplanation !== undefined
        ? { availabilityExplanation: input.availabilityExplanation }
        : {}),
    };
  }

  /**
   * Attachment IDs a replan of this Task may still reference: the ones its
   * originating proposal carried. The proposal owner is the durable
   * source, so a replan cannot invent new attachment references after a
   * restart and cannot silently lose the original ones.
   */
  private resolveTaskTurnAttachmentIds(taskId: string): string[] {
    return [...(this.deps.runtimePort.proposals.findInitialForTask(taskId)?.request.attachmentIds ?? [])];
  }

  private async requestControlReplan(
    decision: ControlDecision & {
      action: Extract<ControlDecision['action'], { type: 'request_replan' }>;
    },
  ): Promise<Extract<ControlEvent, { type: 'plan_proposed' }> | null> {
    const signal = this.turnCancellation.signal;
    if (this.preparationCancelled({ proposalSource: 'replan' }, signal)) return null;
    const replay = await this.findDurableReplan(`replan_event_${decision.id}`, decision);
    if (this.preparationCancelled({ proposalSource: 'replan' }, signal)) return null;
    if (replay) {

      await this.admitPreparedReplan(replay);
      return null;
    }
    const pinned = await this.loadConfigurationSnapshot(decision.configurationRevision);
    if (this.preparationCancelled({ proposalSource: 'replan' }, signal)) return null;
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
      'Do not bind the remaining work back to an Executor candidate that already failed in this generation unless you explain why this attempt would behave differently.',
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
    context.replan = { taskId: task.id, taskEvidenceIds: evidence.map(item => item.id) };
    if (pinned) context.configuration = buildPlannerConfigurationView(pinned);
    if (context.configuration.revisionId !== decision.configurationRevision) {
      throw new Error('replan configuration revision mismatch');
    }
    const plan = await this.runPlanningAgent(context);
    const prepared = await this.preparePlanProposal(this.buildPlanProposal({
      plan,
      configurationRevision: context.configuration.revisionId,
      attachmentIds: this.resolveTaskTurnAttachmentIds(task.id),
      proposalSource: 'replan',
      eventId: `replan_event_${decision.id}`,
      taskId: task.id,
      requestText: redactSensitiveText(request),
      generationId: decision.action.generationId,
      targetGraphRevision: decision.action.sourceRevision + 1,
      availabilityExplanation: null,
    }), signal, decision.id);
    if (prepared) {

      await this.admitPreparedReplan(prepared);
    }
    return null;
  }

  /**
   * A replan effect still originates in a D5 Kernel decision, but its proposal
   * is admitted directly: no plan event or plan decision is created.
   */
  private async admitPreparedReplan(prepared: PlanAdmissionRequest): Promise<void> {
    const snapshot = this.buildPlanAdmissionSnapshot(prepared);
    if (!snapshot) throw new Error('plan admission snapshot is unavailable for the replan');
    const admission = (this.deps.evaluatePlanAdmission ?? evaluatePlanAdmission)(
      prepared,
      planAdmissionSnapshotFromControl(snapshot),
    );
    const runtime = this.sessionControlRuntime;
    if (!runtime) throw new Error('session kernel runtime is unavailable for the replan');
    await runtime.applyPlanAdmission(admission, {
      proposalId: prepared.id,
      userInput: prepared.requestText,
      ...(prepared.conversationId ? { conversationId: prepared.conversationId } : {}),
      queryId: prepared.queryId ?? null,
    });
    this.deps.runtimePort.proposals.markForwarded(prepared.id, new Date().toISOString());
  }

  private async findDurableReplan(
    eventId: string,
    decision: ControlDecision,
  ): Promise<PlanAdmissionRequest | null> {
    const saved = this.deps.runtimePort.proposals.find(eventId);
    if (!saved) return null;
    const persisted = saved.request;
    if (saved.delivery === 'invalidated' || saved.triggerOperationId !== decision.id
      || persisted.configurationRevision !== decision.configurationRevision
      || persisted.sessionId !== this.deps.plannerSessionId
      || persisted.conversationId !== this.deps.conversationId
      || persisted.proposalSource !== (decision.action.type === 'request_merge_replan' ? 'conflict_replan' : 'replan')
      || (decision.action.type === 'request_replan'
        && (persisted.generationId !== decision.action.generationId
          || persisted.targetGraphRevision !== decision.action.sourceRevision + 1))
      || !('taskId' in decision.action) || persisted.taskId !== decision.action.taskId) {
      throw new Error('replan proposal identity conflict');
    }
    await this.loadConfigurationSnapshot(persisted.configurationRevision);
    try {
      this.deps.runtimePort.proposals.assertAdmissionOpen(eventId);
    } catch (error) {
      if (!(error instanceof PlanProposalUnavailableError)) throw error;
      throw new ControlApplicationRejectionError(error.message, error.code);
    }
    return persisted;
  }

  private async requestControlMergeReplan(
    decision: ControlDecision & {
      action: Extract<ControlDecision['action'], { type: 'request_merge_replan' }>;
    },
  ): Promise<Extract<ControlEvent, { type: 'plan_proposed' }> | null> {
    const signal = this.turnCancellation.signal;
    if (this.preparationCancelled({ proposalSource: 'conflict_replan' }, signal)) return null;
    const replay = await this.findDurableReplan(`merge_replan_event_${decision.id}`, decision);
    if (this.preparationCancelled({ proposalSource: 'conflict_replan' }, signal)) return null;
    if (replay) {

      await this.admitPreparedReplan(replay);
      return null;
    }
    const pinned = await this.loadConfigurationSnapshot(decision.configurationRevision);
    if (this.preparationCancelled({ proposalSource: 'conflict_replan' }, signal)) return null;
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
    if (pinned) context.configuration = buildPlannerConfigurationView(pinned);
    if (context.configuration.revisionId !== decision.configurationRevision) {
      throw new Error('replan configuration revision mismatch');
    }
    const plan = await this.runPlanningAgent(context);
    const prepared = await this.preparePlanProposal(this.buildPlanProposal({
      plan,
      configurationRevision: context.configuration.revisionId,
      attachmentIds: this.resolveTaskTurnAttachmentIds(task.id),
      proposalSource: 'conflict_replan',
      eventId: `merge_replan_event_${decision.id}`,
      taskId: task.id,
      requestText: redactSensitiveText(request),
      generationId: revision.generationId,
      targetGraphRevision: revision.revision + 1,
      availabilityExplanation: null,
    }), signal, decision.id);
    if (prepared) {

      await this.admitPreparedReplan(prepared);
    }
    return null;
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
    this.settleStaleTurnAfterRestart(nowMs);
    for (const task of this.deps.runtimePort.queries.listTasksByStatus('needs_action')) {
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
    // A capacity wait is an owner fact: the Task carries a `kernel_capacity`
    // blocker, and its ready Subtask is the one to re-dispatch.
    const candidates = this.deps.runtimePort.queries.listCapacityBlockedTasks();
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
        blockedDecisionId: `capacity_wait:${target.taskId}:${target.blockedAt}`,
        blockedAt: target.blockedAt,
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
    const needsActionTasks = tasks.filter(task => task.status === 'needs_action');
    if (needsActionTasks.length === 0) return false;
    // One state, one reminder fingerprint: the waiting reason and the last
    // progress hint are the durable facts a user needs to act on.
    const fingerprint = needsActionTasks.map(task =>
      `n:${task.id}:${this.getWaitingBlockReason(task)}:${task.stateDetail.reason.code}`
    ).join('|');
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
      needsActionTasks,
      getWaitingBlockReason: task => this.getWaitingBlockReason(task),
    }));
    return true;
  }

  prepareTaskExecution(taskId: string, request: QueuedExecutionRequest): TaskExecutionStart | null {
    return this.taskExecutionApplicationService?.prepareTaskExecution(taskId, {
      ...request,
      workspacePath: request.workspacePath ?? this.workspacePath ?? undefined,
    }) ?? null;
  }

  /** 装配账户级 Kernel 执行服务所需的三个 callbacks 对象（ADR-0031）。 */
  getControlExecutionCallbacks(): {
    kernelExecutionCallbacks: ControlExecutionRuntimeCallbacks;
    taskExecutionCallbacks: TaskExecutionApplicationCallbacks;
    sessionControlCallbacks: SessionControlRuntimeCallbacks;
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
        requestReplan: decision => this.requestControlReplan(decision),
        requestMergeReplan: decision => this.requestControlMergeReplan(decision),
        buildPlanAdmissionSnapshot: event => this.buildPlanAdmissionSnapshot(event)!,
      },
      taskExecutionCallbacks: {
        appendOutput: (...lines: string[]) => this.appendOutput(...lines),
        appendExecutionTrace: input => this.appendExecutionTrace(input),
        appendGuidance: (scene, suggestion) => this.appendGuidance(scene, suggestion),
        refreshRuntimeState: () => this.refreshRuntimeState(),
        startBackgroundExecution: (taskId, work) => this.startBackgroundExecution(taskId, work),
      },
      sessionControlCallbacks: {
        appendOutput: (...lines: string[]) => this.appendOutput(...lines),
        onDecisionApplying: decision => this.recordControlDecisionTrace(decision),
        prepareTaskExecution: (taskId, request) => this.prepareTaskExecution(taskId, request),
        refreshRuntimeState: () => this.refreshRuntimeState(),
        setCurrentTaskId: taskId => this.setCurrentTaskId(taskId),
        getCurrentTaskId: () => this.getCurrentTaskId(),
        setFocusContext: focus => this.setFocusContext(focus),
        resolveRequestText: eventId => this.resolveRequestText(eventId),
        cancelTask: async (taskId, reason) => {
          const runtime = this.kernelExecutionRuntime;
          if (!runtime) {
            throw new Error('Control execution runtime is unavailable');
          }
          return runtime.cancelTaskWithOutcome(taskId, reason);
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
      orchestration: this.deps.orchestration!,
      activeExecutions: port.execution.activeExecutions,
      conversationId: this.deps.conversationId,
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
      // Stop external routing work before waiting: a disposed Session must not
      // leave a Span request running, and a late observation must not admit a
      // proposal.
      this.disposed = true;
      this.turnCancellation.abort();
      this.preparations.clear();
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

function workspaceError(code: string, message: string): Error & { code: string } {
  const error = new Error(`${code}: ${message}`) as Error & { code: string };
  error.code = code;
  return error;
}

function commandError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function shouldStartInteractionTrace(userInput: string): boolean {
  if (!userInput) return false;
  if (!userInput.startsWith('/')) return true;
  return /^\/task\s+(?:resume|unblock|recover)\b/iu.test(userInput);
}

function plannerOutcome(
  action: ControlDecision['action']['type'],
): Extract<PlannerProposalResult, { status: 'accepted' }>['outcome'] {
  switch (action) {
    case 'authorize_task_plan':
      return 'task_authorized';
    case 'authorize_task_control':
      return 'task_control_authorized';
    case 'request_clarification':
      return 'clarification_requested';
    case 'record_permission_resolution':
      return 'authorization_recorded';
    default:
      return 'no_action';
  }
}

function plannerAdmissionOutcome(
  status: PlanAdmissionAppliedResult['status'],
): Extract<PlannerProposalResult, { status: 'accepted' }>['outcome'] {
  switch (status) {
    case 'authorized':
    case 'queued':
    case 'deferred':
      return 'task_authorized';
    case 'task_control':
      return 'task_control_authorized';
    case 'clarification':
      return 'clarification_requested';
    case 'permission_resolution':
      return 'authorization_recorded';
    default:
      return 'no_action';
  }
}

function plannerAdmissionAction(
  status: PlanAdmissionAppliedResult['status'],
): ControlDecision['action']['type'] {
  switch (status) {
    case 'authorized':
    case 'queued':
    case 'deferred':
      return 'authorize_task_plan';
    case 'task_control':
      return 'authorize_task_control';
    case 'clarification':
      return 'request_clarification';
    case 'permission_resolution':
      return 'record_permission_resolution';
    default:
      return 'no_op';
  }
}

function plannerAdmissionDisplayText(
  applied: PlanAdmissionAppliedResult,
  admission: PlanAdmissionResult,
  latestOutput: string | undefined,
): string {
  if (admission.status === 'clarification') return admission.question;
  return latestOutput ?? applied.reason;
}

function plannerDecisionDisplayText(
  decision: ControlDecision,
  latestOutput: string | undefined,
): string {
  if (decision.action.type === 'request_clarification') return decision.action.question;
  return latestOutput ?? decision.reason;
}
