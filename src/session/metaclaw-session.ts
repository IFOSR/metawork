import {
  evaluatePlanAdmission,
  planAdmissionSnapshotFromControl,
} from '../execution/plan-admission-entry.js';
import type { PlanAdmissionAppliedResult } from '../execution/plan-admission-applier.js';
import type { PlanAdmissionRequest } from '../execution/plan-admission-policy.js';
import { planAdmissionRequest, planProposalIdentity } from '../execution/plan-proposal-store.js';
import type { ControlDecider } from '../control/control-workflow.js';
// Session facade that wires MetaClaw's task OS modules and exposes the user-facing session snapshot.
import type Database from 'better-sqlite3';
import { join, resolve } from 'node:path';
import type {
  Config,
  GuidanceProposal,
  RuntimeState,
  Subtask,
  Task,
  TaskRecoveryTrigger,
} from '../core/types.js';
import type { TaskEngine } from '../task/task-engine.js';
import type { OrchestrationEngine } from '../guidance/orchestration.js';
import { NoopNotificationService, type NotificationService } from '../notifications/types.js';
import { SessionPersistenceService } from './session-persistence-service.js';
import { createDefaultCommandCatalog } from '../commands/command-tree.js';
import { CommandReadServices } from '../commands/command-read-services.js';
import type { CommandCatalog, CommandCompletion, CommandContext } from '../commands/catalog.js';
import { SessionStateRepo } from '../storage/session-state-repo.js';
import { TaskRuntimeService } from '../task/task-runtime-service.js';
import { ExecutionRuntime, ExecutorRegistry } from '../execution/execution-runtime.js';
import { ExecutorRecoveryRefreshService } from '../execution/executor-recovery-refresh-service.js';
import { UserArtifactPublicationService } from '../delivery/user-artifact-publication-service.js';
import { TaskArtifactRepo } from '../storage/task-artifact-repo.js';
import { VerificationAndDeliveryService } from '../delivery/verification-and-delivery-service.js';
import { AgentClassService } from '../executor/agent-class-service.js';
import { ExecutionProgressService } from '../execution/execution-progress-service.js';
import { WorkUnitClaimService } from '../execution/work-unit-claim-service.js';
import { WorkspaceStore } from '../execution/workspace-store.js';
import { canonicalizeWorkspacePath } from '../workspace/workspace-path.js';
import { WorkspaceRetentionService } from '../execution/workspace-retention-service.js';
import { NativeAttemptExecutionBackend } from '../execution/native-attempt-execution-backend.js';
import type { AttemptExecutionBackend } from '../execution/attempt-execution-backend.js';
import { ResourceLeaseService } from '../execution/resource-lease-service.js';
import { WorkspacePublicationWorker } from '../execution/workspace-publication-worker.js';
import { SqliteResourceLeaseRepository } from '../storage/resource-lease-repo.js';
import { SqlitePermissionRepository } from '../storage/permission-repo.js';
import { SqliteAttemptExecutionRepository } from '../storage/attempt-execution-backend-repo.js';
import { SqliteWorkspaceRepository } from '../storage/workspace-repo.js';
import { resolveMetaclawDir } from '../utils/paths.js';
import {
  isPermissionRequestActive,
  permissionRequestExpiresAt,
  PermissionWorkflowService,
  type ManagerPermissionJudge,
} from '../execution/permission-workflow-service.js';
import { RegisteredCapabilityResourceResolver } from '../execution/capability-resource-resolver.js';
import { buildPermissionRules } from '../resource/index.js';
import { AttemptExecutionBackendReconciler } from '../execution/attempt-execution-backend-reconciler.js';
import { InputController } from './input-controller.js';
import { SessionPresentationService, type GuidanceState } from './session-presentation-service.js';
import { formatEmptyTaskRecovery } from '../task/task-blocker-guidance.js';
import { ControlExecutionRuntime } from '../execution/control-execution-runtime.js';
import {
  formatTaskResumeDecision,
  SessionTaskExecutionApplicationService,
  type TaskExecutionStart,
} from './session-task-execution-application-service.js';
import { type QueuedExecutionRequest } from './session-helpers.js';
import { SubtaskRepo } from '../storage/subtask-repo.js';
import { TaskEventRepo } from '../storage/task-event-repo.js';
import { WorkUnitRepo } from '../storage/work-unit-repo.js';
import { WorkGraphRuntimeService } from '../execution/work-graph-runtime-service.js';
import { WorkGraphRevisionRepo } from '../storage/work-graph-revision-repo.js';
import { TaskExecutionEvidenceRepo } from '../execution/execution-evidence-port.js';
import { SubtaskAttemptRunner } from '../execution/subtask-attempt-runner.js';
import { buildEligibleContextRefKeys } from '../work-graph/index.js';
import { SubtaskHandoffRepo } from '../storage/subtask-handoff-repo.js';
import type { PlanningAgent } from '../planning/planning-agent.js';
import { PlanningContextBuilder } from '../planning/planning-context-builder.js';
import type { ManagerTransportInput } from '../planning/manager-host/session-transport.js';
import {
  collectDecompositionRejections,
  collectWorkGraphQualityWarnings,
  validatePlanningAgentPlan,
} from '../planning/planning-agent-plan-validator.js';
import { PlanningAgentPlanSchema } from '../planning/planning-agent-plan-schema.js';
import { normalizePlanningAgentPlanInput } from '../planning/planning-agent-plan-normalizer.js';
import type {
  PlanningAgentPlan,
  PlanningContext,
  PlannerImageAttachment,
} from '../planning/planning-types.js';
import type {
  ControlConfigurationView,
  PlannerConfigurationView,
  RuntimePrivateConfigurationBinding,
} from '../configuration/index.js';
import { buildRuntimeConfigurationView } from '../configuration/index.js';
import {
  buildStagedLegacyConfiguration,
  type StagedLegacyConfiguration,
} from '../configuration/staged-legacy-configuration.js';
import {
  authorizedExecutorBindingFingerprint,
  type AuthorizedExecutorBinding,
  type RevisionedAgentBinding,
} from '../core/authorized-executor-binding.js';
import type { ControlExecutorStatusProjection } from '../control/executor-status-projection.js';
import {
  type ControlAttemptKind,
  type ControlDecision,
  type ControlEvent,
  type ControlSnapshot,
} from '../control/control-contracts.js';
import { AccountControlCoordinator } from '../account/account-control-coordinator.js';
import { parseApplicationSettlement } from '../control/control-application-settlement.js';
import { TaskControlWorkflow } from '../execution/task-control-workflow.js';
import { TaskRecoveryItemRepo } from '../storage/task-recovery-item-repo.js';
import { buildAccountControlServices, type AccountControlServices } from '../account/account-control-services.js';
import { buildAccountRepositories, type AccountRepositories } from '../account/account-repositories.js';
import { buildAccountWorkspaceServices, type AccountWorkspaceServices } from '../account/account-workspace-services.js';
import { buildAccountExecutionServices, type AccountExecutionServices } from '../account/account-execution-services.js';
import { buildAccountTaskServices, type AccountTaskServices } from '../account/account-task-services.js';
import {
  createTaskLifecyclePort as createSessionTaskLifecyclePort,
  createTaskStateAuthority,
} from '../account/task-state-composition.js';
import { TaskOperationResultRepo } from '../storage/task-operation-result-repo.js';
import { buildAccountCoordinatorServices, type AccountCoordinatorServices } from '../account/account-coordinator-services.js';
import { buildAccountRuntimeExecutionServices, type AccountRuntimeExecutionServices } from '../account/account-runtime-execution-services.js';
import { buildAccountControlExecutionServices, type AccountControlExecutionServices } from '../account/account-control-execution-services.js';
import { buildAccountPlannerServices, type AccountPlannerServices } from '../account/account-planner-services.js';
import { ConversationSession } from './conversation-session.js';
import { ConversationInputMailbox } from './conversation-input-mailbox.js';
import type { ConversationRuntimePort } from './conversation-runtime-port.js';
import type { GatewaySession } from './session-transport-adapter.js';
import { ControlDispatchItemRepo } from '../storage/dispatch-item-repo.js';
import { WorkspacePublicationRepo } from '../storage/workspace-publication-repo.js';
import { GenerationReplanRequestRepo } from '../storage/generation-replan-request-repo.js';
import {
  GenerationReplanWorker,
  type GenerationReplanWorkerReport,
} from '../account/generation-replan-worker.js';
import { RetryWakeWorker } from '../account/retry-wake-worker.js';
import type { RetryWakeRepo } from '../storage/retry-wake-repo.js';
import { inspectApplicationAgainstSources } from '../execution/control-application-recovery.js';
import {
  createTaskLifecycleTransitionPort,
  type TaskLifecycleTransitionPort,
} from '../task/task-lifecycle-transition-port.js';
import { TaskCancellationCoordinator } from '../execution/task-cancellation-coordinator.js';
import { SessionControlRuntime } from './session-control-runtime.js';
import { PlannerRunRepo } from '../storage/planner-run-repo.js';
import { PlannerProposalRepo } from '../storage/planner-proposal-repo.js';
import {
  createPlannerProposalSubmissionId,
  plannerProposalFingerprint,
  type PlannerProposalPurpose,
  type PlannerProposalResult,
  type PlannerProposalSubmission,
} from '../planning/planner-proposal.js';
import { ControlExecutorStatusRepo } from '../storage/executor-status-repo.js';
import { ControlExecutorStatusProjector } from '../execution/control-executor-status-projector.js';
import { generateInteractionId } from '../utils/id.js';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';
import { ControlEffectOutboxRepo } from '../storage/effect-outbox-repo.js';
import { ExecutorAttemptReceiptRepo } from '../storage/executor-attempt-receipt-repo.js';
import { ConfigurationRevisionRepo } from '../storage/configuration-revision-repo.js';
import { HarnessDriverRegistry } from '../executor/harness-driver-registry.js';
import { PiCliDriver } from '../executor/pi-cli-driver.js';
import type { ProbeCommandRunner } from '../executor/harness-driver.js';
import { LocalCliExecutorAdapter } from '../executor/local-cli-executor-adapter.js';
import { LOCAL_DEFAULT_ACCOUNT_ID } from '../account/account-id.js';
import { resolveAccountPaths } from '../account/account-paths.js';
import type { InteractionTrace, InteractionTraceStatus } from '../management/interaction-trace.js';
import { InteractionTraceStream } from './interaction-trace-stream.js';
import type { ExecutionTraceAppendInput } from '../execution/execution-trace.js';
import type { PlannerRunProgress } from '../planning/planner-progress.js';
import { taskBelongsToConversation } from '../task/task-ownership.js';

export interface PlannerHostRegistrar {
  registerSession(sessionId: string, session: MetaclawSession): () => void;
}

export interface MetaclawSessionDeps {
  taskEngine: TaskEngine;
  orchestration: OrchestrationEngine;
  db: Database.Database;
  config: Config;
  sessionId: string;
  planningAgent?: PlanningAgent;
  notifier?: NotificationService;
  sourceRoot?: string;
  resultsRoot?: string;
  userArtifactPublication?: UserArtifactPublicationService;
  managedLocalServices?: import('../execution/managed-local-service.js').ManagedLocalServices;
  attemptExecutionBackend?: AttemptExecutionBackend;
  plannerHost?: PlannerHostRegistrar;
  stagedConfiguration?: StagedLegacyConfiguration;
  probeCommand?: ProbeCommandRunner;
  kernelCoordinator?: AccountControlCoordinator;
  kernelServices?: AccountControlServices;
  accountRepositories?: AccountRepositories;
  accountWorkspaceServices?: AccountWorkspaceServices;
  accountExecutionServices?: AccountExecutionServices;
  accountTaskServices?: AccountTaskServices;
  /** Durable Task state entry. Composed once per session/account. */
  taskLifecyclePort?: import('../task/task-lifecycle-transition-port.js').TaskLifecycleTransitionPort;
  taskStateAuthority?: import('../task/task-state-authority.js').TaskStateAuthority;
  accountCoordinatorServices?: AccountCoordinatorServices;
  accountRuntimeExecutionServices?: AccountRuntimeExecutionServices;
  accountControlExecutionServices?: AccountControlExecutionServices;
  accountPlannerServices?: AccountPlannerServices;
  /**
   * Router decision adapter (ADR-0055 D1). Server composition injects the Span
   * advisor; the legacy facade has no credential of its own, so a caller states
   * the decision model it wants instead of the Router silently defaulting.
   */
  spanRoutingEvaluator?: import('../routing/span-routing-types.js').SpanRoutingEvaluator | null;
  /**
   * Upstream-Pi Manager transport (ADR-0055 D6). Supplied by composition when
   * `METAWORK_MANAGER_TRANSPORT=upstream-pi`; the session only forwards it.
   */
  managerTransport?: ManagerTransportInput;
  managerPermissionJudge?: ManagerPermissionJudge;
  /**
   * Compatibility switch for historical low-level tests/replay fixtures.
   * Production semantic Planner ingress keeps this disabled.
   */
  getRuntimeBinding?(
    binding: AuthorizedExecutorBinding,
  ): Promise<RuntimePrivateConfigurationBinding> | RuntimePrivateConfigurationBinding;
}

type RuntimeBindingResolver = NonNullable<MetaclawSessionDeps['getRuntimeBinding']>;

function resolveRuntimeBindingResolver(deps: MetaclawSessionDeps): RuntimeBindingResolver {
  if (deps.getRuntimeBinding) return deps.getRuntimeBinding;
  if (process.env.NODE_ENV === 'test') {
    return binding => ({
      revisionId: binding.configurationRevision,
      bindingFingerprint: authorizedExecutorBindingFingerprint(binding),
    });
  }
  throw new Error('runtime binding resolver is required');
}

function boundedControlRequestText(value: string): string {
  return redactSensitiveText(value).slice(0, 24_000);
}

function plannerToolSummary(
  toolName: string,
  state: 'started' | 'completed' | 'failed',
): string {
  const action = toolName === 'submit_planning_proposal'
    ? 'the structured proposal submission'
    : toolName === 'get_planning_context'
      ? 'the authoritative planning context query'
      : toolName === 'get_runtime_state'
        ? 'the current runtime-state query'
        : toolName === 'list_executor_status'
          ? 'the Executor status query'
          : `the ${toolName} operation`;
  return state === 'started'
    ? `Planner started ${action}.`
    : `Planner ${state} ${action}.`;
}

function startupOrphanEvent(input: {
  sessionId: string;
  task: Task;
  subtaskId: string;
  attemptId: string;
  authorizedBinding: AuthorizedExecutorBinding;
  bindingFingerprint: string;
  attemptKind: ControlAttemptKind;
  sourceAttemptId: string | null;
  occurredAt: string;
}): Extract<ControlEvent, { type: 'execution_outcome' }> {
  return {
    schemaVersion: 5,
    configurationRevision: input.authorizedBinding.configurationRevision,
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
    authorizedBinding: input.authorizedBinding,
    bindingFingerprint: input.bindingFingerprint,
    attemptKind: input.attemptKind,
    sourceAttemptId: input.sourceAttemptId,
    failure: {
      kind: 'heartbeat_lost',
      scope: 'agent_class',
      code: 'startup_orphaned_work',
      summary: 'Metaclaw restarted with orphaned active work; explicit recovery is required',
    },
  };
}

import type {
  SessionSnapshot,
  SessionSwitchingState,
} from './session-types.js';

export type {
  SessionSnapshot,
  SessionSwitchingState,
};

interface FocusContext {
  kind: 'conversation' | 'task';
  taskId: string | null;
}

// Reasoning models (e.g. gpt-5.6-terra) can take ~24s per response; a planning
// turn may issue several model calls, so 60s was too tight. 180s leaves headroom
// while still surfacing a genuinely stuck Planner within a bounded window.
const DEFAULT_PLANNER_TIMEOUT_MS = 180_000;

function createDefaultAttemptExecutionBackend(): AttemptExecutionBackend {
  const backend = (process.env.METAWORK_EXECUTOR_BACKEND ?? 'native').trim().toLowerCase();
  if (backend === 'in_place' || backend === 'native' || backend === '') return new NativeAttemptExecutionBackend();
  if (backend === 'worktree') throw new Error('METAWORK_EXECUTOR_BACKEND=worktree has been retired; use native');
  throw new Error(`Unsupported METAWORK_EXECUTOR_BACKEND: ${backend}`);
}

/** Wires the session-facing services and exposes the server-side session API. */
export class MetaclawSession {
  private output: string[] = [];
  private runtimeState: RuntimeState = {
    runningTaskId: null,
    runningExecutorName: null,
    queuedTaskIds: [],
    needsActionTaskIds: [],
    lastEvent: null,
  };
  private latestGuidance: GuidanceState | null = null;
  private activePlannerRuns = 0;
  private initialized = false;
  private initialization: Promise<void> | null = null;
  private listeners = new Set<(snapshot: SessionSnapshot) => void>();
  private runningExecutorsByAttempt = new Map<string, {
    taskId: string;
    subtaskId: string;
    name: string;
  }>();
  private lastReminderAt: number | null = null;
  private lastReminderFingerprint: string | null = null;
  private lastTaskPoolWatchdogReminderAt: number | null = null;
  private lastTaskPoolWatchdogFingerprint: string | null = null;
  private lastBlockedRecheckAt: number | null = null;
  private blockedRecheckInFlight = false;
  private backgroundWork = new Set<Promise<void>>();
  private currentTaskId: string | null = null;
  private focusContext: FocusContext | null = null;
  private readonly commandCatalog: CommandCatalog;
  private readonly sessionStateRepo: SessionStateRepo;
  private readonly notifier: NotificationService;
  private readonly inputController: InputController;
  private readonly taskRuntimeService: TaskRuntimeService;
  private readonly executionRuntime: ExecutionRuntime;
  private readonly commandReadServices: CommandReadServices;
  private readonly verificationAndDeliveryService: VerificationAndDeliveryService;
  private readonly persistenceService: SessionPersistenceService;
  private readonly presentation: SessionPresentationService;
  private readonly agentClassService: AgentClassService;
  private readonly executionProgressService: ExecutionProgressService;
  private readonly planningContextBuilder: PlanningContextBuilder;
  private readonly planningAgent: PlanningAgent;

  private readonly controlLoop: ControlDecider;
  private readonly recoveryItems: TaskRecoveryItemRepo;
  private readonly kernelCoordinator: AccountControlCoordinator;
  private readonly workGraphRuntimeService: WorkGraphRuntimeService;
  private readonly workGraphRevisionRepo: WorkGraphRevisionRepo;
  private readonly effectOutboxRepo: ControlEffectOutboxRepo;
  private readonly taskExecutionEvidenceRepo: TaskExecutionEvidenceRepo;
  private readonly attemptReceiptRepo: ExecutorAttemptReceiptRepo;
  private readonly subtaskRepo: SubtaskRepo;
  private readonly taskEventRepo: TaskEventRepo;
  private readonly workUnitClaimService: WorkUnitClaimService;
  private readonly attemptRunner: SubtaskAttemptRunner;
  private readonly workspaceStore: WorkspaceStore;
  /** Read-only Workspace root this legacy facade executes against. */
  private readonly sourceRoot: string;
  private readonly workspaceRetentionService: WorkspaceRetentionService;
  private readonly workspaceGitRepo: AccountWorkspaceServices['workspaceGitRepo'];
  private workspaceRetentionSweep: Promise<void> | null = null;
  private readonly attemptExecutionBackend: AttemptExecutionBackend;
  private readonly permissionRepository: SqlitePermissionRepository;
  private readonly attemptExecutionRepository: SqliteAttemptExecutionRepository;
  private readonly workspaceRepository: SqliteWorkspaceRepository;
  private readonly kernelExecutionRuntime: ControlExecutionRuntime;
  private readonly taskExecutionApplicationService: SessionTaskExecutionApplicationService;
  private readonly sessionControlRuntime: SessionControlRuntime;
  private readonly kernelExecutorStatusRepo: ControlExecutorStatusRepo;
  private readonly conversationTaskSchedulerRepo: AccountRepositories['conversationTaskSchedulerRepo'];
  private readonly executorRecoveryRefreshService: ExecutorRecoveryRefreshService;
  private readonly plannerProposalRepo: PlannerProposalRepo;
  private readonly publicationRepo: WorkspacePublicationRepo;
  private readonly generationReplanRepo: GenerationReplanRequestRepo;
  private readonly retryWakeRepo: RetryWakeRepo;
  private readonly dispatchItemRepo: ControlDispatchItemRepo;
  private lifecycle: TaskLifecycleTransitionPort | null = null;
  private readonly plannerConfiguration: PlannerConfigurationView;
  private readonly kernelConfiguration: ControlConfigurationView;
  private readonly plannerBinding: RevisionedAgentBinding;
  private readonly plannerBindingFingerprint: string;
  /** Turns that already got one repairable decomposition rejection. */
  private readonly decompositionRejectedTurns = new Set<string>();
  private readonly interactionTraceStream: InteractionTraceStream;
  private unregisterPlannerHost: (() => void) | null = null;
  private disposePromise: Promise<void> | null = null;
  private retryWakeWorker: RetryWakeWorker | null = null;
  private readonly taskLifecyclePort: import('../task/task-lifecycle-transition-port.js').TaskLifecycleTransitionPort;
  private readonly taskOperationResults: import('../storage/task-operation-result-repo.js').TaskOperationResultRepo;
  private cancellationCoordinator: import('../execution/task-cancellation-coordinator.js').TaskCancellationCoordinator | null = null;
  private taskStateAuthority!: import('../task/task-state-authority.js').TaskStateAuthority;

  constructor(private deps: MetaclawSessionDeps) {
    const getRuntimeBinding = resolveRuntimeBindingResolver(deps);
    const stagedConfiguration = deps.stagedConfiguration
      ?? buildStagedLegacyConfiguration();
    new ConfigurationRevisionRepo(deps.db).ensure({
      revisionId: stagedConfiguration.snapshot.revisionId,
      contentHash: stagedConfiguration.snapshot.contentHash,
      sourceKind: 'schema-30-import',
      importedAt: new Date().toISOString(),
    });
    this.plannerConfiguration = stagedConfiguration.planner;
    this.kernelConfiguration = stagedConfiguration.kernel;
    if (!stagedConfiguration.plannerBinding) throw new Error('Planner is not configured; open Settings in MetaWork.');
    this.plannerBinding = stagedConfiguration.plannerBinding;
    this.plannerBindingFingerprint = stagedConfiguration.plannerBindingFingerprint;
    this.notifier = deps.notifier ?? new NoopNotificationService();
    this.interactionTraceStream = new InteractionTraceStream(deps.sessionId);
    this.sessionStateRepo = new SessionStateRepo(deps.db);
    this.plannerProposalRepo = new PlannerProposalRepo(deps.db);
    this.taskLifecyclePort = deps.taskLifecyclePort ?? createSessionTaskLifecyclePort(deps.db);
    this.taskOperationResults = new TaskOperationResultRepo(deps.db);
    const taskServices = deps.accountTaskServices ?? buildAccountTaskServices({
      nativeStateRoot: join(resolveMetaclawDir(), 'native-processes'),
      taskEngine: deps.taskEngine,
      lifecyclePort: this.taskLifecyclePort,
      agentClasses: stagedConfiguration.snapshot.config.agentClasses,
      attemptExecutionBackend: deps.attemptExecutionBackend,
    });
    this.taskRuntimeService = taskServices.taskRuntimeService;
    this.agentClassService = taskServices.agentClassService;
    this.attemptExecutionBackend = taskServices.attemptExecutionBackend;
    const workspaceServices = deps.accountWorkspaceServices
      ?? buildAccountWorkspaceServices(deps.db, resolveMetaclawDir());
    this.permissionRepository = workspaceServices.permissionRepository;
    this.attemptExecutionRepository = workspaceServices.attemptExecutionRepository;
    this.workspaceRepository = workspaceServices.workspaceRepository;
    this.workspaceStore = workspaceServices.workspaceStore;
    this.workspaceRetentionService = workspaceServices.workspaceRetentionService;
    this.workspaceGitRepo = workspaceServices.workspaceGitRepo;
    const executionServices = deps.accountExecutionServices ?? buildAccountExecutionServices({
      stagedConfiguration,
      getRuntimeBinding,
      probeCommand: deps.probeCommand,
      attemptExecutionBackend: this.attemptExecutionBackend,
      attemptExecutionRepository: this.attemptExecutionRepository,
      attemptsRoot: resolve(resolveMetaclawDir(), 'attempts'),
    });
    const executorRegistry = executionServices.executorRegistry;
    this.executionRuntime = executionServices.executionRuntime;
    this.commandReadServices = new CommandReadServices(deps.db, this.executionRuntime, {
      getConfigurationRevision: () => this.kernelConfiguration.revisionId,
    });
    this.verificationAndDeliveryService = new VerificationAndDeliveryService();
    this.persistenceService = new SessionPersistenceService(deps.db);
    this.presentation = new SessionPresentationService();
    const repositories = deps.accountRepositories ?? buildAccountRepositories(deps.db, LOCAL_DEFAULT_ACCOUNT_ID);
    this.executionProgressService = repositories.executionProgressService;
    this.subtaskRepo = repositories.subtaskRepo;
    this.taskEventRepo = repositories.taskEventRepo;
    this.workGraphRevisionRepo = repositories.workGraphRevisionRepo;
    this.effectOutboxRepo = repositories.effectOutboxRepo;
    this.taskExecutionEvidenceRepo = repositories.taskExecutionEvidenceRepo;
    this.attemptReceiptRepo = repositories.attemptReceiptRepo;
    this.workGraphRuntimeService = repositories.workGraphRuntimeService;
    this.kernelExecutorStatusRepo = repositories.kernelExecutorStatusRepo;
    this.conversationTaskSchedulerRepo = repositories.conversationTaskSchedulerRepo;
    const coordinatorServices = deps.accountCoordinatorServices ?? buildAccountCoordinatorServices({
      db: deps.db,
      executionRuntime: this.executionRuntime,
      executorRegistry,
      kernelExecutorStatusRepo: this.kernelExecutorStatusRepo,
      getConfigurationRevision: () => this.kernelConfiguration.revisionId,
    });
    this.workUnitClaimService = coordinatorServices.workUnitClaimService;
    this.taskStateAuthority = deps.taskStateAuthority ?? createTaskStateAuthority({
      db: deps.db,
      taskRepo: deps.taskEngine.getTaskRepo(),
      subtaskRepo: this.subtaskRepo,
      workGraphRevisionRepo: this.workGraphRevisionRepo,
      workUnitClaimService: this.workUnitClaimService,
      // Release the Conversation slot as soon as the Task starts waiting for the
      // user, so their next answer is admitted instead of queued behind it.
      onWaitingForUser: task => {
        void this.releasePausedTaskSlot(task.id);
      },
    });
    this.executorRecoveryRefreshService = coordinatorServices.executorRecoveryRefreshService;
    const kernelExecutorStatusProjector = new ControlExecutorStatusProjector(this.kernelExecutorStatusRepo);
    const plannerModel = stagedConfiguration.snapshot.config.models[this.plannerBinding.modelRef];
    if (!plannerModel) {
      throw new Error(`Planner Model is unavailable: ${this.plannerBinding.modelRef}`);
    }
    const plannerServices = deps.accountPlannerServices ?? buildAccountPlannerServices({
      ...(deps.planningAgent ? { planningAgent: deps.planningAgent } : {}),
      ...(deps.managerTransport ? { managerTransport: deps.managerTransport } : {}),
    });
    this.planningContextBuilder = new PlanningContextBuilder({
      sessionId: deps.sessionId,
      conversationId: deps.sessionId,
      requestSource: 'session',
      getTimeoutMs: () => this.getPlannerTimeoutMs(),
      getPlannerConfiguration: () => this.plannerConfiguration,
    });
    this.planningAgent = plannerServices.planningAgent;
    const kernelServices = deps.kernelServices ?? buildAccountControlServices(deps.db);
    this.controlLoop = kernelServices.controlLoop;
    this.recoveryItems = kernelServices.recoveryItems;
    this.kernelCoordinator = deps.kernelCoordinator ?? new AccountControlCoordinator({
      kernel: this.controlLoop,
      clock: { now: () => new Date().toISOString() },
      acceptedEventTypes: ['plan_proposed'],
      acceptedActions: [
        'reject_request', 'request_clarification', 'no_op',
        'authorize_task_plan', 'authorize_task_control', 'block_work', 'park_for_replan',
        'record_permission_resolution',
      ],
    });
    this.commandCatalog = createDefaultCommandCatalog();
    this.inputController = new InputController({
      appendUserInput: (input: string) => this.appendUserInput(input),
      handleCommand: (input: string) => this.handleCommand(input),
      handleNaturalLanguageInput: (input: string, images?: PlannerImageAttachment[]) =>
        this.handleNaturalLanguageInput(input, images),
      waitForAsyncWork: () => this.waitForAsyncWork(),
      handleSubmitError: (error: unknown) => this.appendOutput(`错误: ${(error as Error).message}`),
    });
    const sourceRoot = deps.sourceRoot
      ?? (process.env.NODE_ENV === 'test' && process.env.ANYFUSION_TEST_WORKSPACE_SOURCE
        ? resolve(process.env.ANYFUSION_TEST_WORKSPACE_SOURCE)
        : process.cwd());
    this.sourceRoot = sourceRoot;
    const resultsRoot = deps.resultsRoot
      ?? resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID).results;
    const runtimeExecutionServices = deps.accountRuntimeExecutionServices ?? buildAccountRuntimeExecutionServices({
      db: deps.db,
      sessionId: deps.sessionId,
      resultRoot: resultsRoot,
      sourceRoot,
      taskRuntimeService: this.taskRuntimeService,
      taskStateAuthority: this.taskStateAuthority,
      taskLifecyclePort: this.taskLifecyclePort,
      subtaskRepo: this.subtaskRepo,
      taskEventRepo: this.taskEventRepo,
      workGraphRevisionRepo: this.workGraphRevisionRepo,
      workUnitClaimService: this.workUnitClaimService,
      executionRuntime: this.executionRuntime,
      agentClassService: this.agentClassService,
      workspaceStore: this.workspaceStore,
      attemptExecutionBackend: this.attemptExecutionBackend,
      conversationWorktrees: workspaceServices.conversationWorktrees,
      serviceWorktrees: workspaceServices.serviceWorktrees,
      workspaceMergeWorker: workspaceServices.workspaceMergeWorker,
      managerPermissionJudge: deps.managerPermissionJudge ?? deps.accountPlannerServices?.managerPermissionJudge,
      permissionRepository: this.permissionRepository,
      workspaceRepository: this.workspaceRepository,
      attemptExecutionRepository: this.attemptExecutionRepository,
      conversationTaskSchedulerRepo: this.conversationTaskSchedulerRepo,
      ...(deps.userArtifactPublication ? { userArtifactPublication: deps.userArtifactPublication } : {}),
    });
    const resourceLeaseService = runtimeExecutionServices.resourceLeaseService;
    const dispatchItemRepo = runtimeExecutionServices.dispatchItemRepo;
    this.publicationRepo = runtimeExecutionServices.publicationRepo;
    const generationReplanRepo = runtimeExecutionServices.generationReplanRepo;
    this.generationReplanRepo = generationReplanRepo;
    this.retryWakeRepo = runtimeExecutionServices.retryWakeRepo;
    this.dispatchItemRepo = runtimeExecutionServices.dispatchItemRepo;
    const cancellationCoordinator = runtimeExecutionServices.cancellationCoordinator;
    this.cancellationCoordinator = cancellationCoordinator;
    this.attemptRunner = runtimeExecutionServices.attemptRunner;
    const kernelExecutionServices = deps.accountControlExecutionServices ?? buildAccountControlExecutionServices({
      recoveryItems: this.recoveryItems,
      accountId: LOCAL_DEFAULT_ACCOUNT_ID,
      managedLocalServices: deps.managedLocalServices,
      userArtifactPublication: deps.userArtifactPublication ?? new UserArtifactPublicationService({
        userWorkspaceRoot: sourceRoot, taskArtifactRepo: new TaskArtifactRepo(deps.db),
      }),
      resolveWorkspacePath: async () => sourceRoot,
      resolveUserWorkspaceRoot: async () => deps.userArtifactPublication?.userWorkspaceRoot || sourceRoot,
      db: deps.db,
      sessionId: deps.sessionId,
      legacyCompatibility: true,
      resultRoot: resultsRoot,
      sourceRoot,
      orchestration: deps.orchestration,
      notifier: this.notifier,
      maxAttemptsPerTask: deps.config.orchestration.max_concurrent_attempts,
      getConfigurationRevision: () => this.kernelConfiguration.revisionId,
      // The Kernel projects executor display names from the pinned revision; without
      // this it falls back to a ref-derived name for any class the public catalog
      // does not know.
      getRuntimeConfiguration: (revisionId: string) => (
        revisionId === stagedConfiguration.snapshot.revisionId
          ? buildRuntimeConfigurationView(stagedConfiguration.snapshot)
          : null
      ),
      taskRuntimeService: this.taskRuntimeService,
      taskStateAuthority: this.taskStateAuthority,
      conversationTaskSchedulerRepo: this.conversationTaskSchedulerRepo,
      agentClassService: this.agentClassService,
      workGraphRuntimeService: this.workGraphRuntimeService,
      subtaskRepo: this.subtaskRepo,
      workGraphRevisionRepo: this.workGraphRevisionRepo,
      effectOutboxRepo: this.effectOutboxRepo,
      attemptReceiptRepo: this.attemptReceiptRepo,
      taskEventRepo: this.taskEventRepo,
      workUnitClaimService: this.workUnitClaimService,
      attemptRunner: this.attemptRunner,
      controlLoop: this.controlLoop,
      ...(deps.spanRoutingEvaluator ? { spanRoutingEvaluator: deps.spanRoutingEvaluator } : {}),
      dispatchItemRepo,
      publicationRepo: this.publicationRepo,
      generationReplanRepo,
      retryWakeRepo: runtimeExecutionServices.retryWakeRepo,
      cancellationCoordinator,
      executionProgressService: this.executionProgressService,
      verificationAndDeliveryService: this.verificationAndDeliveryService,
      persistenceService: this.persistenceService,
      kernelExecutorStatusProjector,
      presentation: this.presentation,
      workspaceStore: this.workspaceStore,
      workspaceRepository: this.workspaceRepository,
      conversationWorktrees: workspaceServices.conversationWorktrees,
      serviceWorktrees: workspaceServices.serviceWorktrees,
      workspaceMergeWorker: workspaceServices.workspaceMergeWorker,
      resourceLeaseService,
      executionRuntime: this.executionRuntime,
      kernelExecutionCallbacks: {
        appendOutput: (...lines: string[]) => this.appendOutput(...lines),
        recordResultDelivery: () => undefined,
        appendExecutionTrace: input => this.appendExecutionTrace(input),
        refreshRuntimeState: () => this.refreshRuntimeState(),
        appendTaskQueueSnapshot: trigger => this.appendTaskQueueSnapshot(trigger),
        setFocusContext: focus => this.setFocusContext(focus),
        setRunningExecutorName: (taskId, subtaskId, attemptId, name) => (
          this.setRunningExecutorName(taskId, subtaskId, attemptId, name)
        ),
        clearRunningExecutorName: (taskId, attemptId) => this.clearRunningExecutorName(taskId, attemptId),
        persistSessionState: changes => this.persistSessionState(changes),
        setLatestGuidance: (scene, suggestion) => this.setLatestGuidance(scene, suggestion),
        queueProposal: (scene, proposal) => this.queueProposal(scene, proposal),
        requestReplan: async () => {
          throw new Error('legacy request_replan requires the ConversationSession Planner boundary');
        },
        requestMergeReplan: decision => this.requestControlMergeReplan(decision),
        buildPlanAdmissionSnapshot: event => this.buildPlanAdmissionSnapshot(event),
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
        resolveRequestText: eventId => {
          return this.generationReplanRepo.proposals.find(eventId)?.request.requestText ?? '';
        },
        cancelTask: (taskId, reason) =>
          this.kernelExecutionRuntime.cancelTaskWithOutcome(taskId, reason),
        onWaitingForUser: taskId => {
          void this.releasePausedTaskSlot(taskId);
        },
      },
    });
    this.kernelExecutionRuntime = kernelExecutionServices.kernelExecutionRuntime;
    coordinatorServices.bindControlExecutionRuntime(this.kernelExecutionRuntime);
    this.taskExecutionApplicationService = kernelExecutionServices.taskExecutionApplicationService;
    this.sessionControlRuntime = kernelExecutionServices.sessionControlRuntime;

    this.unregisterPlannerHost = deps.plannerHost?.registerSession(deps.sessionId, this) ?? null;
  }

  async dispose(): Promise<void> {
    this.disposePromise ??= (async () => {
      // Startup recovery owns the session's repositories until it settles.
      // Wait for it before unregistering the host so callers can safely close
      // the account database after dispose, even when recovery failed.
      await this.initialization?.catch(() => undefined);
      this.unregisterPlannerHost?.();
      this.unregisterPlannerHost = null;
    })();
    await this.disposePromise;
  }

  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeInteractionTrace(
    listener: (trace: InteractionTrace | null) => void,
  ): () => void {
    return this.interactionTraceStream.subscribe(listener);
  }

  getInteractionTrace(): InteractionTrace | null {
    return this.interactionTraceStream.getSnapshot();
  }

  getSnapshot(): SessionSnapshot {
    this.reconcileLatestGuidance();
    const currentTaskId = this.getCurrentTaskId();
    const currentTask = currentTaskId ? this.findLocalTask(currentTaskId) : null;
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
      plannerState: {
        status: this.activePlannerRuns > 0 ? 'running' : 'idle',
      },
      latestGuidance: this.latestGuidance
        ? {
            ...this.latestGuidance,
            reasons: [...this.latestGuidance.reasons],
          }
        : null,
    };
  }

  getSwitchingState(): SessionSwitchingState {
    const snapshot = this.getSnapshot();
    return {
      plannerTurnActive: this.activePlannerRuns > 0,
      taskRuntimeActive: Boolean(
        this.backgroundWork.size > 0
        || snapshot.runtimeState.runningTaskId
        || (snapshot.currentTask
          && !['done', 'archived', 'cancelled'].includes(snapshot.currentTask.status)),
      ),
    };
  }

  completeCommand(text: string, cursor = text.length): CommandCompletion {
    return this.commandCatalog.complete({ text, cursor, context: this.getCommandContext() });
  }

  /**
   * Accepts a Planner proposal emitted by the AnyFusion-Pi host protocol. The Planner
   * remains untrusted with respect to state: schema and semantic validation happen
   * here, then the existing plan_proposed -> TaskControlWorkflow path remains the
   * only state-changing route.
   */
  async submitPlannerProposal(
    submission: PlannerProposalSubmission,
    purpose: PlannerProposalPurpose = 'kernel',
  ): Promise<PlannerProposalResult> {
    await this.initialization;
    const normalizedInput = submission.userInput.trim();
    const normalizedSessionId = submission.sessionId.trim();
    const normalizedTurnId = submission.turnId.trim();
    if (!normalizedInput || !normalizedSessionId || !normalizedTurnId) {
      return {
        status: 'rejected',
        turnId: normalizedTurnId || submission.turnId,
        submissionId: submission.submissionId,
        planId: null,
        rejectionType: 'validation',
        issues: ['sessionId, turnId, and userInput must not be empty'],
        kernel: null,
      };
    }
    if (normalizedSessionId !== this.deps.sessionId) {
      return {
        status: 'conflict',
        turnId: normalizedTurnId,
        submissionId: submission.submissionId,
        acceptedSubmissionId: null,
        message: 'Planner proposal session does not match the bound MetaClaw session.',
      };
    }
    this.interactionTraceStream.beginTurn({
      turnId: normalizedTurnId,
      userInput: normalizedInput,
    });
    const expectedSubmissionId = createPlannerProposalSubmissionId(
      normalizedSessionId, normalizedTurnId, submission.plan,
    );
    if (submission.submissionId !== expectedSubmissionId) {
      const conflict: PlannerProposalResult = {
        status: 'conflict',
        turnId: normalizedTurnId,
        submissionId: submission.submissionId,
        acceptedSubmissionId: null,
        message: 'Planner proposal submissionId does not match the runtime-derived plan fingerprint.',
      };
      this.recordPlannerProposalTerminalTrace(conflict);
      return conflict;
    }

    // The active configuration revision is authoritative for the proposal.
    const normalizedPlan = normalizePlanningAgentPlanInput(submission.plan, {
      configurationRevision: this.kernelConfiguration.revisionId,
    });
    if (submission.runtimeMode === 'interactive'
      && typeof normalizedPlan === 'object' && normalizedPlan !== null
      && 'action' in normalizedPlan && normalizedPlan.action === 'authorization_resolution') {
      return {
        status: 'rejected',
        turnId: normalizedTurnId,
        submissionId: submission.submissionId,
        planId: 'id' in normalizedPlan && typeof normalizedPlan.id === 'string' ? normalizedPlan.id : null,
        rejectionType: 'validation',
        issues: ['Interactive permission decisions must use the host permission selector.'],
        kernel: null,
      };
    }

    const turn = this.plannerProposalRepo.ensureTurn(normalizedSessionId, normalizedTurnId, normalizedInput);
    if (turn.conflict) {
      return {
        status: 'conflict',
        turnId: normalizedTurnId,
        submissionId: submission.submissionId,
        acceptedSubmissionId: null,
        message: 'Planner proposal turnId was already bound to different user input.',
      };
    }
    if (turn.created && purpose === 'kernel'
      && submission.runtimeMode !== 'rpc' && submission.runtimeMode !== 'session') {
      this.appendUserInput(normalizedInput);
    }

    const context = this.buildPlanningContext(normalizedInput);
    const validation = validatePlanningAgentPlan(
      normalizedPlan,
      context.configuration,
      context.pendingAuthorizationRequest
        ? {
            requestId: context.pendingAuthorizationRequest.requestId,
            taskId: context.pendingAuthorizationRequest.taskId,
          }
        : null,
    );
    const parsedPlan = PlanningAgentPlanSchema.safeParse(normalizedPlan);
    if (parsedPlan.success && purpose === 'kernel' && validation.valid
      && !this.decompositionRejectedTurns.has(normalizedTurnId)) {
      // The Planner owns decomposition; this only tells it that a multi-question
      // request was compressed into one node, and allows exactly one revision
      // per turn so a deliberate atomic deliverable is never dead-locked.
      const issues = collectDecompositionRejections(
        parsedPlan.data as PlanningAgentPlan,
        normalizedInput,
      );
      if (issues.length > 0) {
        this.decompositionRejectedTurns.add(normalizedTurnId);
        return {
          status: 'rejected',
          turnId: normalizedTurnId,
          submissionId: submission.submissionId,
          planId: (parsedPlan.data as PlanningAgentPlan).id,
          rejectionType: 'validation',
          issues,
          kernel: null,
        };
      }
    }
    const planId = parsedPlan.success ? parsedPlan.data.id : null;
    if (parsedPlan.success) {
      this.recordPlannerIntentTrace(parsedPlan.data as PlanningAgentPlan, submission.submissionId);
    }
    const eventId = parsedPlan.success && purpose === 'kernel'
      ? `plan_event_${submission.submissionId}`
      : null;
    const reservation = this.plannerProposalRepo.reserveSubmission({
      sessionId: normalizedSessionId,
      turnId: normalizedTurnId,
      submissionId: submission.submissionId,
      planFingerprint: plannerProposalFingerprint(submission.plan),
      planId,
      eventId,
      configurationRevision: context.configuration.revisionId,
    });
    if (reservation.kind === 'replay') {
      this.recordPlannerProposalTerminalTrace(reservation.result);
      return reservation.result;
    }
    if (reservation.kind === 'in_flight') {
      const latest = this.plannerProposalRepo.getSubmission(
        normalizedSessionId, normalizedTurnId, submission.submissionId,
      );
      if (latest?.result) {
        this.recordPlannerProposalTerminalTrace(latest.result);
        return latest.result;
      }
      const uncertain: PlannerProposalResult = {
        status: 'transport_uncertain',
        turnId: normalizedTurnId,
        submissionId: submission.submissionId,
        retryableByReplay: true,
        message: 'The same Planner proposal is still being durably applied; replay the identical submission.',
      };
      this.recordPlannerProposalTerminalTrace(uncertain);
      return uncertain;
    }
    if (reservation.kind === 'conflict') {
      const conflict: PlannerProposalResult = {
        status: 'conflict',
        turnId: normalizedTurnId,
        submissionId: submission.submissionId,
        acceptedSubmissionId: reservation.acceptedSubmissionId,
        message: 'This Planner turn already has a different authoritative submission.',
      };
      this.recordPlannerProposalTerminalTrace(conflict);
      return conflict;
    }

    if (!validation.valid || !parsedPlan.success) {
      const issues = !validation.valid
        ? validation.errors
        : !parsedPlan.success
          ? parsedPlan.error.issues.map(issue => issue.message)
        : ['PlanningAgentPlan v9 validation failed'];
      const rejected: PlannerProposalResult & { status: 'rejected' } = {
        status: 'rejected',
        turnId: normalizedTurnId,
        submissionId: submission.submissionId,
        planId,
        rejectionType: 'validation',
        issues,
        kernel: null,
      };
      this.plannerProposalRepo.completeSubmission(
        normalizedSessionId, normalizedTurnId, submission.submissionId, rejected,
      );
      this.recordPlannerProposalTerminalTrace(rejected);
      return rejected;
    }

    const plan = parsedPlan.data as PlanningAgentPlan;
    this.interactionTraceStream.append({
      phase: 'planning',
      actor: 'planner',
      kind: 'planning_proposal_completed',
      title: 'Structured plan completed',
      summary: plan.reason,
      details: {
        planId: plan.id,
        submissionId: submission.submissionId,
        action: plan.action,
        schemaVersion: plan.schemaVersion,
      },
      eventKey: submission.submissionId,
    });
    if (purpose === 'validation') {
      const accepted: PlannerProposalResult & { status: 'accepted' } = {
        status: 'accepted',
        turnId: normalizedTurnId,
        submissionId: submission.submissionId,
        planId: plan.id,
        outcome: 'proposal_validated',
        displayText: 'PlanningAgentPlan v9 proposal validated by MetaClaw.',
        taskId: plan.task.taskId,
        kernel: null,
      };
      this.plannerProposalRepo.completeSubmission(
        normalizedSessionId, normalizedTurnId, submission.submissionId, accepted,
      );
      this.recordPlannerProposalTerminalTrace(accepted);
      return accepted;
    }

    const outputStart = this.output.length;
    try {
      const kernelResult = await this.submitValidatedPlanningAgentPlan(
        normalizedInput, plan, context, eventId!,
      );
      const applied = kernelResult.applied;
      if (!applied) {
        this.plannerProposalRepo.markUncertain(
          normalizedSessionId, normalizedTurnId, submission.submissionId,
        );
        const uncertain: PlannerProposalResult = {
          status: 'transport_uncertain',
          turnId: normalizedTurnId,
          submissionId: submission.submissionId,
          retryableByReplay: true,
          message: 'MetaClaw has not yet confirmed the authoritative control application; replay the same submission.',
        };
        this.recordPlannerProposalTerminalTrace(uncertain);
        return uncertain;
      }
      if (applied.status === 'rejected') {
        const rejected: PlannerProposalResult & { status: 'rejected' } = {
          status: 'rejected',
          turnId: normalizedTurnId,
          submissionId: submission.submissionId,
          planId: plan.id,
          rejectionType: 'kernel',
          issues: [applied.reason],
          kernel: {
            decisionId: applied.operationId,
            action: 'reject_request',
            reason: applied.reason,
          },
        };
        this.plannerProposalRepo.completeSubmission(
          normalizedSessionId, normalizedTurnId, submission.submissionId, rejected,
        );
        this.recordPlannerProposalTerminalTrace(rejected);
        return rejected;
      }
      const accepted = this.toAcceptedPlannerProposalResult(
        normalizedTurnId, submission.submissionId, plan, applied,
        this.output.slice(outputStart),
      );
      this.plannerProposalRepo.completeSubmission(
        normalizedSessionId, normalizedTurnId, submission.submissionId, accepted,
      );
      this.recordPlannerProposalTerminalTrace(accepted);
      return accepted;
    } catch (error) {
      this.plannerProposalRepo.markUncertain(
        normalizedSessionId, normalizedTurnId, submission.submissionId,
      );
      const uncertain: PlannerProposalResult = {
        status: 'transport_uncertain',
        turnId: normalizedTurnId,
        submissionId: submission.submissionId,
        retryableByReplay: true,
        message: `MetaClaw proposal transport is uncertain: ${(error as Error).message}`,
      };
      this.recordPlannerProposalTerminalTrace(uncertain);
      return uncertain;
    }
  }

  private reconcileLatestGuidance(): void {
    if (!this.latestGuidance) {
      return;
    }

    const task = this.findLocalTask(this.latestGuidance.taskId);
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

  initialize(options: { resumeStartupTasks?: boolean; showDashboard?: boolean } = {}): Promise<void> {
    if (this.initialized) return this.initialization ?? Promise.resolve();

    const resumeStartupTasks = options.resumeStartupTasks ?? true;
    const showDashboard = options.showDashboard ?? true;
    const recoveredRunningTasks: Task[] = [];

    if (showDashboard && this.deps.config.ui.dashboard_on_start) {
      const dashboard = this.deps.orchestration.getDashboard();
      this.output = [
        '┌─ Metaclaw v1.0 ─────────────────────────────────┐',
        `│ 你有 ${dashboard.summary.active} 个活跃任务，${dashboard.summary.blocked} 个需要处理。`,
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
          `→ 检测到上次异常退出，任务 #${task.id} 需要处理`,
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
      ? this.recoverDurableStartup().then(async recovered => {
          for (const task of recovered) {
            this.appendOutput(
              `→ 检测到上次异常退出，任务 #${task.id} 需要处理（由控制循环的恢复项收敛）`,
              `→ 可执行 /task recovery ${task.id} 查看不确定项`,
            );
          }
          await this.executorRecoveryRefreshService.refresh({ trigger: 'session_start' });
        })
      : this.executorRecoveryRefreshService.refresh({ trigger: 'session_start' }).then(() => undefined);
    // Most shell entry points historically called initialize() without await.
    // Observe the rejection immediately to preserve diagnostics without
    // converting a failed recovery into a successful session state.
    void this.initialization.catch(() => undefined);
    this.refreshRuntimeState();
    this.notify();
    return this.initialization;
  }

  async submit(
    rawInput: string,
    options: { awaitAsyncWork?: boolean } = {},
  ): Promise<{ exitRequested: boolean }> {
    await this.initialization;
    return this.inputController.submit(rawInput, options);
  }

  /**
   * 过渡：把本会话包装为 ConversationSession（ADR-0031 迁移桥接）。
   * ConversationSession 通过 runtimePort 访问账户服务，通过本会话的
   * conversation-facing 服务与 submit 委托桥接 Planner 回合。
   */
  asConversationSession(runtimePort: ConversationRuntimePort): ConversationSession {
    return new ConversationSession({
      conversationId: this.deps.sessionId,
      plannerSessionId: this.deps.sessionId,
      runtimePort,
      mailbox: new ConversationInputMailbox({
        execute: async () => undefined,
      }),
      presentation: this.presentation,
      sessionStateRepo: this.sessionStateRepo,
      persistenceService: this.persistenceService,
      interactionTraceStream: this.interactionTraceStream,
      kernelExecutionRuntime: this.kernelExecutionRuntime,
      planningContextBuilder: this.planningContextBuilder,
      db: this.deps.db,
      kernelConfiguration: this.kernelConfiguration,
      sessionControlRuntime: this.sessionControlRuntime,
      commandCatalog: this.commandCatalog,
      commandReadServices: this.commandReadServices,
      taskEngine: this.deps.taskEngine,
      orchestration: this.deps.orchestration,
      config: this.deps.config,
      taskExecutionApplicationService: this.taskExecutionApplicationService,
    });
  }

  /**
   * 过渡：把本会话适配为 Gateway 会话（SessionStreamSource + 初始化/系统消息/释放）。
   */
  asGatewaySession(runtimePort: ConversationRuntimePort): GatewaySession {
    const conversation = this.asConversationSession(runtimePort);
    return {
      subscribe: listener => conversation.subscribe(snapshot => listener({ output: [...snapshot.output] })),
      submit: text => conversation.submitUserInput(text),
      dispose: () => conversation.dispose(),
    };
  }

  async waitForAsyncWork(): Promise<void> {
    await this.initialization;
    let loops = 0;
    while (this.backgroundWork.size > 0) {
      loops += 1;
      if (loops % 50 === 0) {
      }
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

    const localTaskIds = new Set(this.listLocalTasks().map(task => task.id));
    const suggestions = this.deps.orchestration.generateSuggestions()
      .filter(suggestion => localTaskIds.has(suggestion.taskId));
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

    // A capacity wait is an owner fact: the Task carries a `kernel_capacity`
    // blocker, and its ready Subtask is the one to re-dispatch.
    const target = this.taskRuntimeService.listTasksByStatus('needs_action')
      .flatMap(task => task.dependencies
        .filter(dependency => dependency.type === 'kernel_capacity' && dependency.status === 'waiting')
        .map(dependency => ({ task, dependency })))
      .flatMap(({ task, dependency }) => {
        const subtask = this.subtaskRepo.listActiveByTask(task.id)
          .find(item => item.status === 'ready');
        return subtask ? [{ task, dependency, subtask }] : [];
      })[0];
    if (!target) {
      this.lastBlockedRecheckAt = nowMs;
      return false;
    }

    this.lastBlockedRecheckAt = nowMs;
    this.blockedRecheckInFlight = true;
    try {
      return this.kernelExecutionRuntime.recheckCapacity({
        taskId: target.task.id,
        subtaskId: target.subtask.id,
        blockedDecisionId: `capacity_wait:${target.task.id}:${target.dependency.createdAt}`,
        blockedAt: target.dependency.createdAt,
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
    const retryWakesDelivered = await this.getRetryWakeWorker().run(
      new Date(nowMs).toISOString(),
    );
    if (retryWakesDelivered > 0) return true;
    for (const task of this.listLocalTasksByStatus('needs_action')) {
      if (await this.kernelExecutionRuntime.recoverDue(task.id, 'timer durable recovery drain')) return true;
    }
    if (await this.maybeReconcileBlockedTasksOnTimer(nowMs)) {
      return true;
    }

    this.refreshRuntimeState();
    return this.maybeEmitTaskPoolWatchdogReminder(nowMs);
  }

  private getRetryWakeWorker(): RetryWakeWorker {
    return this.retryWakeWorker ??= new RetryWakeWorker({
      retryWakeRepo: this.retryWakeRepo,
      processTimer: (event, reason) => this.kernelExecutionRuntime.recoverRetryWake(event, reason),
      now: () => new Date().toISOString(),
    });
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
      // An empty blocker means the user pause itself is the only reason; the
      // explicit resume is its resolution, so it must not be classified as an
      // unknown external blocker.
      blockedReason: input.blockedReason || this.getWaitingBlockReason(task)
        || task.stateDetail.reason.message
        || '',
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

    const localTasks = this.listLocalTasks();
    const needsActionTasks = localTasks.filter(task => task.status === 'needs_action');
    if (needsActionTasks.length === 0) {
      return false;
    }

    const fingerprint = needsActionTasks.map(task =>
      `n:${task.id}:${this.getWaitingBlockReason(task)}:${task.stateDetail.reason.code}`
    ).join('|');
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
      needsActionTasks,
      getWaitingBlockReason: task => this.getWaitingBlockReason(task),
    }));
    return true;
  }

  private notify(): void {
    const snapshot = this.getSnapshot();
    this.listeners.forEach(listener => listener(snapshot));
  }

  private buildSuggestionTaskTitleSuffix(taskId: string): string {
    const task = this.findLocalTask(taskId);
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
      this.findLocalTask(suggestion.taskId)?.title ?? '',
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
      proposal.taskId ? this.findLocalTask(proposal.taskId)?.title ?? '' : '',
    ));
    this.appendOutput('→ 操作提案已记录，不等待用户确认；满足执行条件的任务由调度器自动处理');
  }

  private async runPlanningAgent(context: PlanningContext): Promise<PlanningAgentPlan> {
    this.activePlannerRuns += 1;
    this.notify();
    try {
      return await this.planningAgent.plan(context);
    } finally {
      this.activePlannerRuns = Math.max(0, this.activePlannerRuns - 1);
      this.notify();
    }
  }

  private buildPlanningContext(userInput: string, images?: PlannerImageAttachment[]): PlanningContext {
    const pendingPermission = this.permissionRepository.findOldestPendingForConversation(
      this.deps.sessionId,
    );
    return this.planningContextBuilder.build({
      userInput,
      images,
      pendingAuthorizationRequest: pendingPermission ? {
        requestId: pendingPermission.request.id,
        taskId: pendingPermission.request.taskId,
        capability: pendingPermission.request.capability,
        resource: pendingPermission.request.resource,
        operation: pendingPermission.request.operation,
        reason: pendingPermission.request.reason,
      } : null,
    });
  }

  /**
   * Legacy facade Workspace facts. The retained MetaclawSession owns no
   * Conversation Workspace binding, so it pins its single authorized root as the
   * target Workspace identity; production Conversations resolve theirs from the
   * Workspace catalog instead.
   */
  private async buildWorkspaceAdmission(
    plan: PlanningAgentPlan,
  ): Promise<{ targetWorkspace: { workspaceId: string; canonicalPath: string } | null }> {
    const root = this.deps.userArtifactPublication?.userWorkspaceRoot || this.sourceRoot;
    const canonical = await canonicalizeWorkspacePath(root).catch(() => null);
    if (!canonical) return { targetWorkspace: null };
    const existingTask = plan.task.taskId
      ? this.taskRuntimeService.findTask(plan.task.taskId)
      : null;
    return {
      targetWorkspace: {
        workspaceId: existingTask?.workspaceId ?? 'legacy-workspace',
        canonicalPath: canonical.canonicalPath,
      },
    };
  }

  private async submitValidatedPlanningAgentPlan(
    userInput: string,
    plan: PlanningAgentPlan,
    context: PlanningContext,
    eventId = `plan_event_${plan.id}_${generateInteractionId()}`,
  ): Promise<{ applied: PlanAdmissionAppliedResult | null }> {
    const event: PlanAdmissionRequest = {
      id: eventId,
      configurationRevision: context.configuration.revisionId,
      occurredAt: new Date().toISOString(),
      sessionId: this.deps.sessionId,
      ...(this.interactionTraceStream.getSnapshot()?.turnId
        ? { sourceTurnId: this.interactionTraceStream.getSnapshot()!.turnId } : {}),
      ...(plan.task.taskId ? { taskId: plan.task.taskId } : {}),
      proposal: plan,
      requestText: boundedControlRequestText(userInput),
      generationId: `generation_${eventId}`,
      proposalSource: 'initial',
      targetGraphRevision: 1,
    };
    const saved = this.generationReplanRepo.proposals.find(eventId);
    if (saved && (saved.delivery === 'invalidated' || saved.triggerOperationId !== null
      || planProposalIdentity(saved.request) !== planProposalIdentity(event))) {
      throw new Error('plan proposal identity conflict');
    }
    const proposal = saved ? { ...event, ...saved.request }
      : { ...event, workspaceAdmission: await this.buildWorkspaceAdmission(plan) };
    this.generationReplanRepo.proposals.save({ request: planAdmissionRequest(proposal) });
    this.generationReplanRepo.proposals.assertAdmissionOpen(proposal.id);
    // The snapshot builder still speaks the Kernel snapshot shape; only the
    // evaluated policy result travels any further.
    const snapshot = this.buildPlanAdmissionSnapshot(
      {
        ...proposal,
        schemaVersion: 5,
        type: 'plan_proposed',
        correlationId: plan.id,
        causationId: null,
      } as unknown as Extract<ControlEvent, { type: 'plan_proposed' }>,
      context.configuration,
      userInput,
    );
    const admission = evaluatePlanAdmission(
      proposal,
      planAdmissionSnapshotFromControl(snapshot),
    );
    const applied = await this.sessionControlRuntime.applyPlanAdmission(admission, {
      proposalId: eventId,
      userInput: proposal.requestText,
      ...(proposal.conversationId ? { conversationId: proposal.conversationId } : {}),
      queryId: proposal.queryId ?? null,
    });
    // A failed application leaves the proposal pending for the same replay.
    this.generationReplanRepo.proposals.markForwarded(eventId, new Date().toISOString());
    if (plan.action === 'authorization_resolution' && plan.authorizationResolution) {
      await this.resolvePermission({
        requestId: plan.authorizationResolution.requestId,
        resolution: plan.authorizationResolution.resolution,
        source: 'planner',
        plannerPlanId: plan.id,
      });
    }
    return { applied };
  }

  private toAcceptedPlannerProposalResult(
    turnId: string,
    submissionId: string,
    plan: PlanningAgentPlan,
    applied: PlanAdmissionAppliedResult,
    outputLines: string[],
  ): Extract<PlannerProposalResult, { status: 'accepted' }> {
    const outcome = applied.status === 'authorized' || applied.status === 'queued'
      || applied.status === 'deferred'
      ? 'task_authorized'
      : applied.status === 'task_control'
        ? 'task_control_authorized'
        : applied.status === 'clarification'
            ? 'clarification_requested'
            : applied.status === 'permission_resolution'
              ? 'authorization_recorded'
              : 'no_action';
    const displayText = outputLines.join('\n').trim()
      || applied.displayText
      || (outcome === 'task_authorized'
        ? `规划已通过 MetaClaw 授权，任务 ${applied.taskId ?? plan.task.taskId} 已创建。`
        : '规划提案已由 MetaClaw 接受。');
    return {
      status: 'accepted',
      turnId,
      submissionId,
      planId: plan.id,
      outcome,
      displayText,
      taskId: applied.taskId ?? plan.task.taskId,
      kernel: {
        decisionId: applied.operationId,
        action: planAdmissionActionName(applied.status),
        reason: applied.reason,
      },
    };
  }

  private async handlePlanningControlDecision(
    userInput: string,
    images?: PlannerImageAttachment[],
  ): Promise<boolean> {
    const turnId = `turn_${generateInteractionId()}`;
    this.interactionTraceStream.beginTurn({ turnId, userInput });
    this.interactionTraceStream.append({
      phase: 'planning',
      actor: 'planner',
      kind: 'planner_started',
      title: 'Planner started',
      summary: 'Parsing the request and preparing a structured proposal.',
      details: {
        configurationRevision: this.plannerConfiguration.revisionId,
      },
      eventKey: 'planner',
    });
    this.appendOutput('【MetaClaw｜理解用户请求】');
    const context = this.buildPlanningContext(userInput, images);
    this.activePlannerRuns += 1;
    this.notify();
    let result: PlannerProposalResult;
    try {
      result = await this.planningAgent.submit(context, {
        submit: plan => this.submitPlannerProposal({
          sessionId: this.deps.sessionId,
          turnId,
          userInput,
          submissionId: createPlannerProposalSubmissionId(this.deps.sessionId, turnId, plan),
          plan,
          runtimeMode: 'session',
        }),
        onProgress: progress => this.recordPlannerProgressTrace(progress),
      });
    } catch (error) {
      this.interactionTraceStream.append({
        phase: 'planning',
        actor: 'planner',
        kind: 'planner_failed',
        title: 'Planner failed',
        summary: (error as Error).message,
        details: {},
        eventKey: 'planner',
        traceStatus: 'failed',
      });
      throw error;
    } finally {
      this.activePlannerRuns = Math.max(0, this.activePlannerRuns - 1);
      this.notify();
    }
    this.recordPlannerProposalTerminalTrace(result, turnId);
    if (result.status === 'accepted') {
      if (result.outcome === 'no_action') this.appendOutput(result.displayText);
      return true;
    }
    if (result.status === 'rejected') {
      this.appendOutput(this.presentation.formatControlRejection(result.issues.join('; ')));
      return true;
    }
    if (result.status === 'conflict') {
      this.appendOutput(`规划回合冲突：${result.message}`);
      return true;
    }
    this.appendOutput(
      `Planner 未能完成到控制循环的交接，未进入 Runtime，也没有启动 Executor。${result.message}`,
    );
    return true;
  }

  private recordPlannerProgressTrace(progress: PlannerRunProgress): void {
    const current = this.interactionTraceStream.getSnapshot();
    if (!current || current.status !== 'running') return;
    const baseDetails = {
      progressSequence: progress.sequence,
      elapsedMs: progress.elapsedMs,
    };
    const eventKey = `rpc:${progress.sequence}`;
    switch (progress.kind) {
      case 'process_started':
        this.interactionTraceStream.append({
          phase: 'planning',
          actor: 'planner',
          kind: 'planner_process_started',
          title: 'Planner process started',
          summary: 'The isolated Planner RPC process is running.',
          details: baseDetails,
          eventKey,
        });
        return;
      case 'prompt_accepted':
        this.interactionTraceStream.append({
          phase: 'planning',
          actor: 'planner',
          kind: 'planner_prompt_accepted',
          title: 'Planner accepted the request',
          summary: 'The request entered the Planner agent loop.',
          details: baseDetails,
          eventKey,
        });
        return;
      case 'agent_started':
        this.interactionTraceStream.append({
          phase: 'planning',
          actor: 'planner',
          kind: 'planner_agent_started',
          title: 'Planner agent loop started',
          summary: 'Planner is preparing the next structured action.',
          details: baseDetails,
          eventKey,
        });
        return;
      case 'turn_started':
        this.interactionTraceStream.append({
          phase: 'planning',
          actor: 'planner',
          kind: 'planner_turn_started',
          title: `Planner processing cycle ${progress.turn}`,
          summary: 'Planner is evaluating available context and the next tool action.',
          details: { ...baseDetails, turn: progress.turn },
          eventKey,
        });
        return;
      case 'model_stream_started':
        this.interactionTraceStream.append({
          phase: 'planning',
          actor: 'planner',
          kind: 'planner_model_stream_started',
          title: 'Planner model response started',
          summary: 'The model is generating a structured action; hidden reasoning is not exposed.',
          details: { ...baseDetails, turn: progress.turn },
          eventKey,
        });
        return;
      case 'model_waiting':
        this.interactionTraceStream.append({
          phase: 'planning',
          actor: 'planner',
          kind: 'planner_model_waiting',
          title: 'Planner is waiting for the model',
          summary: 'The Planner request is still active, but no model output has arrived yet.',
          details: {
            ...baseDetails,
            turn: progress.turn,
            idleMs: progress.idleMs,
          },
          eventKey,
        });
        return;
      case 'tool_started':
        this.interactionTraceStream.append({
          phase: 'planning',
          actor: 'planner',
          kind: 'planner_tool_started',
          title: `Planner tool started: ${progress.toolName}`,
          summary: plannerToolSummary(progress.toolName, 'started'),
          details: {
            ...baseDetails,
            toolSequence: progress.toolSequence,
            toolName: progress.toolName,
            argumentFields: progress.argumentFields,
          },
          eventKey,
        });
        return;
      case 'tool_completed':
        this.interactionTraceStream.append({
          phase: 'planning',
          actor: 'planner',
          kind: 'planner_tool_completed',
          title: `Planner tool ${progress.status}: ${progress.toolName}`,
          summary: plannerToolSummary(progress.toolName, progress.status),
          details: {
            ...baseDetails,
            toolSequence: progress.toolSequence,
            toolName: progress.toolName,
            argumentFields: progress.argumentFields,
            resultFields: progress.resultFields,
          },
          eventKey,
        });
        return;
      case 'agent_completed':
        this.interactionTraceStream.append({
          phase: 'planning',
          actor: 'planner',
          kind: 'planner_agent_completed',
          title: 'Planner handoff confirmed',
          summary: 'Planner received the structured proposal result; the Task Runtime now owns the next action.',
          details: baseDetails,
          eventKey,
        });
    }
  }

  private recordPlannerIntentTrace(plan: PlanningAgentPlan, submissionId: string): void {
    this.interactionTraceStream.append({
      phase: 'planning',
      actor: 'planner',
      kind: 'intent_classified',
      title: `Intent classified: ${plan.action}`,
      summary: plan.reason,
      details: {
        planId: plan.id,
        submissionId,
        action: plan.action,
        confidence: plan.confidence,
        taskBinding: plan.task.binding,
        taskTitle: plan.task.title,
        riskLevel: plan.risk.level,
        requiresConfirmation: plan.risk.requiresConfirmation,
      },
      eventKey: submissionId,
    });
    const qualityWarnings = collectWorkGraphQualityWarnings(plan);
    if (qualityWarnings.length > 0) {
      this.interactionTraceStream.append({
        phase: 'planning',
        actor: 'planner',
        kind: 'dag_quality_warning',
        title: 'Work Graph 拆解质量提示',
        summary: qualityWarnings.join('；'),
        details: { warnings: qualityWarnings, planId: plan.id },
        eventKey: `${submissionId}:dag-quality`,
      });
    }
  }

  private recordPlannerProposalTerminalTrace(
    result: PlannerProposalResult,
    fallbackTurnId?: string,
  ): void {
    const current = this.interactionTraceStream.getSnapshot();
    const effectiveTurnId = result.turnId === 'unknown'
      ? fallbackTurnId
      : result.turnId;
    if (!current || !effectiveTurnId || current.turnId !== effectiveTurnId) return;
    if (result.status === 'accepted') {
      if (current.status !== 'running' || result.outcome === 'task_authorized') return;
      this.interactionTraceStream.append({
        phase: 'delivery',
        actor: 'runtime',
        kind: 'delivery_completed',
        title: 'Response delivered',
        summary: result.displayText,
        details: {
          planId: result.planId,
          submissionId: result.submissionId,
          outcome: result.outcome,
          taskId: result.taskId,
        },
        eventKey: result.submissionId,
        taskId: result.taskId,
        traceStatus: 'completed',
      });
      return;
    }
    const mapping: Record<
      Exclude<PlannerProposalResult['status'], 'accepted'>,
      {
        kind: string;
        title: string;
        eventStatus: 'failed' | 'blocked';
        traceStatus: Exclude<InteractionTraceStatus, 'running' | 'completed'>;
      }
    > = {
      rejected: {
        kind: 'proposal_rejected',
        title: 'Planner proposal rejected',
        eventStatus: 'failed',
        traceStatus: 'failed',
      },
      conflict: {
        kind: 'proposal_conflict',
        title: 'Planner proposal conflict',
        eventStatus: 'blocked',
        traceStatus: 'blocked',
      },
      transport_uncertain: {
        kind: 'proposal_transport_uncertain',
        title: 'Planner handoff blocked',
        eventStatus: 'blocked',
        traceStatus: 'blocked',
      },
      convergence_exhausted: {
        kind: 'planner_convergence_exhausted',
        title: 'Planner convergence exhausted',
        eventStatus: 'blocked',
        traceStatus: 'blocked',
      },
    };
    const mapped = mapping[result.status];
    const summary = result.status === 'rejected'
      ? result.issues.join('; ')
      : result.message;
    this.interactionTraceStream.append({
      phase: 'planning',
      actor: 'planner',
      kind: mapped.kind,
      title: mapped.title,
      summary,
      details: {
        turnId: effectiveTurnId,
        ...(result.status === 'convergence_exhausted'
          ? {
              convergenceReason: result.reason,
              limit: result.limit,
              observed: result.observed,
            }
          : { submissionId: result.submissionId }),
        ...(result.turnId !== effectiveTurnId
          ? { reportedTurnId: result.turnId }
          : {}),
      conversationId: this.deps.sessionId,
        ...(result.status === 'transport_uncertain'
          ? {
              retryableByReplay: result.retryableByReplay,
              blockedAt: 'planner_to_kernel_handoff',
              nextOwner: 'none',
              kernelSubmitted: false,
              executorStarted: false,
            }
          : {}),
        ...(result.status === 'conflict'
          ? { acceptedSubmissionId: result.acceptedSubmissionId }
          : {}),
        ...(result.status === 'rejected'
          ? { planId: result.planId, rejectionType: result.rejectionType }
          : {}),
      },
      eventKey: result.status === 'convergence_exhausted'
        ? `planner-run:${effectiveTurnId}:convergence:${result.reason}`
        : result.submissionId === 'unknown'
          ? `planner-run:${effectiveTurnId}`
          : result.submissionId,
      traceStatus: mapped.traceStatus,
    });
  }

  private recordControlDecisionTrace(decision: ControlDecision): void {
    const taskId = 'taskId' in decision.action ? decision.action.taskId : null;
    this.interactionTraceStream.append({
      phase: 'authorization',
      actor: 'kernel',
      kind: 'kernel_decision',
      title: `Control operation: ${decision.action.type}`,
      summary: decision.reason,
      details: {
        decisionId: decision.id,
        action: decision.action.type,
        eventId: decision.eventId,
        configurationRevision: decision.configurationRevision,
        taskId,
      },
      eventKey: decision.id,
      taskId,
    });
    if (decision.action.type !== 'authorize_task_plan') return;
    const action = decision.action;
    for (const subtaskId of Object.keys(action.authorizedBindingsBySubtask).sort()) {
      const bindings = action.authorizedBindingsBySubtask[subtaskId] ?? [];
      bindings.forEach((binding, fallbackOrder) => {
        this.interactionTraceStream.append({
          phase: 'routing',
          actor: 'kernel',
          kind: 'executor_routed',
          title: fallbackOrder === 0 ? 'Primary Executor authorized' : 'Fallback Executor authorized',
          summary:
            `${binding.agentClassRef} via ${binding.harnessRef} `
            + `using ${binding.providerRef}/${binding.modelRef}`,
          details: {
            subtaskId,
            fallbackOrder,
            routingRole: fallbackOrder === 0 ? 'primary' : 'fallback',
            authorizedBinding: binding,
          },
          eventKey: `${decision.id}:${subtaskId}:${fallbackOrder}`,
          taskId: action.taskId,
        });
      });
    }
  }

  /**
   * Durable Replan Job parity for the retained legacy facade
   * (2026-09-25 convergence plan §5).
   *
   * Production AccountRuntimes drive the same worker from their periodic
   * review; this entry point lets a session-scoped host consume Jobs owned by
   * its own Tasks without waiting for the account timer. The worker claim is
   * idempotent, so both paths can run concurrently without a duplicate Planner
   * turn or graph revision.
   */
  async runScheduledReplanJobs(): Promise<GenerationReplanWorkerReport> {
    await this.initialization;
    const report = await new GenerationReplanWorker({
      replanRepo: this.generationReplanRepo,
      // An automatic replan continues the Task's admitted Workspace; it is not a
      // new client selection.
      resolveTaskWorkspace: task => {
        if (!task.workspaceId) return null;
        const root = this.workspaceGitRepo.root(task.workspaceId);
        if (!root) return null;
        return { workspaceId: task.workspaceId, canonicalPath: root.userRoot };
      },
      planner: {
        plan: context => this.runPlanningAgent(context),
        buildPlanningContext: input => this.planningContextBuilder.build({
          userInput: input.userInput,
        }),
        materializeCompletedEvidence: (taskId, revision) => {
          this.workGraphRuntimeService.materializeCompletedEvidence(taskId, revision);
        },
        listTaskEvidence: (taskId, generationId) => (
          this.taskExecutionEvidenceRepo.listTaskEvidenceByGeneration(taskId, generationId)
        ),
        listAttemptReceipts: taskId => this.attemptReceiptRepo.listByTask(taskId),
        resolveTurnAttachmentIds: taskId => {
          return [...(this.generationReplanRepo.proposals.findInitialForTask(taskId)?.request.attachmentIds ?? [])];
        },
        findActiveGraph: taskId => this.workGraphRevisionRepo.findActive(taskId),
        submitProposal: async ({ proposal }) => {
          this.generationReplanRepo.proposals.assertAdmissionOpen(proposal.id);
          const snapshot = this.buildPlanAdmissionSnapshot(
            {
              ...proposal,
              schemaVersion: 5,
              type: 'plan_proposed',
              correlationId: proposal.proposal.id,
              causationId: null,
            } as unknown as Extract<ControlEvent, { type: 'plan_proposed' }>,
          );
          const admission = evaluatePlanAdmission(
            proposal,
            planAdmissionSnapshotFromControl(snapshot),
          );
          this.generationReplanRepo.proposals.markForwarded(proposal.id, new Date().toISOString());
          await this.sessionControlRuntime.applyPlanAdmission(admission, {
            proposalId: proposal.id,
            userInput: proposal.requestText,
            ...(proposal.conversationId ? { conversationId: proposal.conversationId } : {}),
            queryId: proposal.queryId ?? null,
          });
        },
      },
      findTask: taskId => this.taskRuntimeService.findTask(taskId),
      now: () => new Date().toISOString(),
    }).run();
    await this.kernelCoordinator.recover({
      buildSnapshot: event => this.buildPlanAdmissionSnapshot(event as Extract<ControlEvent, { type: 'plan_proposed' }>),
      runtime: this.sessionControlRuntime.forInput(),
    });
    // An activated replan revision starts its own background execution; the
    // legacy facade owns that work, so it is awaited before the next period.
    await this.waitForAsyncWork();
    return report;
  }

  private async requestControlMergeReplan(
    decision: ControlDecision & {
      action: Extract<ControlDecision['action'], { type: 'request_merge_replan' }>;
    },
  ): Promise<Extract<ControlEvent, { type: 'plan_proposed' }> | null> {
    const saved = this.generationReplanRepo.proposals.find(`merge_replan_event_${decision.id}`);
    if (saved) {
      const request = saved.request;
      if (saved.delivery === 'invalidated' || saved.triggerOperationId !== decision.id
        || request.configurationRevision !== decision.configurationRevision
        || request.sessionId !== this.deps.sessionId || request.taskId !== decision.action.taskId
        || request.proposalSource !== 'conflict_replan') throw new Error('replan proposal identity conflict');
      await this.admitPreparedReplan(request);
      return null;
    }
    const task = this.taskRuntimeService.findTask(decision.action.taskId);
    const revision = this.workGraphRevisionRepo.findActive(decision.action.taskId);
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
    const context = this.planningContextBuilder.build({
      userInput: request,
    });
    if (context.configuration.revisionId !== decision.configurationRevision) {
      throw new Error('replan configuration revision mismatch');
    }
    const plan = await this.runPlanningAgent(context);
    const event: Extract<ControlEvent, { type: 'plan_proposed' }> = {
      schemaVersion: 5,
      configurationRevision: context.configuration.revisionId,
      type: 'plan_proposed',
      id: `merge_replan_event_${decision.id}`,
      correlationId: decision.eventId,
      causationId: decision.id,
      occurredAt: new Date().toISOString(),
      sessionId: this.deps.sessionId,
      conversationId: task.conversationId ?? this.deps.sessionId,
      taskId: task.id,
      proposal: plan,
      requestText: boundedControlRequestText(request),
      generationId: revision.generationId,
      proposalSource: 'conflict_replan',
      targetGraphRevision: revision.revision + 1,
      availabilityExplanation: null,
      attachmentIds: [...(this.generationReplanRepo.proposals.findInitialForTask(task.id)?.request.attachmentIds ?? [])],
      workspaceAdmission: await this.buildWorkspaceAdmission(plan),
    };
    const prepared = planAdmissionRequest(event);
    this.generationReplanRepo.proposals.save({ request: prepared, triggerOperationId: decision.id });
    await this.admitPreparedReplan(prepared);
    return null;
  }

  /** Replan effects are Kernel-triggered but admitted directly, with no plan event. */
  private async admitPreparedReplan(prepared: PlanAdmissionRequest): Promise<void> {
    const snapshot = this.buildPlanAdmissionSnapshot(
      {
        ...prepared,
        schemaVersion: 5,
        type: 'plan_proposed',
        correlationId: prepared.proposal.id,
        causationId: null,
      } as unknown as Extract<ControlEvent, { type: 'plan_proposed' }>,
    );
    const admission = evaluatePlanAdmission(
      prepared,
      planAdmissionSnapshotFromControl(snapshot),
    );
    await this.sessionControlRuntime.applyPlanAdmission(admission, {
      proposalId: prepared.id,
      userInput: prepared.requestText,
      ...(prepared.conversationId ? { conversationId: prepared.conversationId } : {}),
      queryId: prepared.queryId ?? null,
    });
    this.generationReplanRepo.proposals.markForwarded(prepared.id, new Date().toISOString());
  }

  private buildPlanAdmissionSnapshot(
    event: Extract<ControlEvent, { type: 'plan_proposed' }>,
    plannerConfiguration = this.planningContextBuilder.getPlannerConfiguration(),
    userInput = event.proposal.task.goal ?? '',
  ): Extract<ControlSnapshot, { type: 'plan_admission' }> {
    if (
      event.configurationRevision !== plannerConfiguration.revisionId
      || event.configurationRevision !== this.kernelConfiguration.revisionId
    ) {
      throw new Error(
        `plan admission configuration revision mismatch: ${event.configurationRevision}`,
      );
    }
    return {
      schemaVersion: 5,
      type: 'plan_admission',
      tasks: this.taskRuntimeService.listTasks().map(task => ({
        id: task.id,
        status: task.status,
        ...(task.conversationId
          ? {
              conversationId: taskBelongsToConversation(task, this.deps.sessionId, true)
                ? this.deps.sessionId
                : task.conversationId,
            }
          : {}),
        ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
        ...(task.executionMode ? { executionMode: task.executionMode } : {}),
        ...(task.workspaceDeliveryPolicy ? { deliveryPolicy: task.workspaceDeliveryPolicy } : {}),
      })),
      activeTaskByConversation: Object.fromEntries(
        this.taskRuntimeService.listTasks().map(task => {
          const conversationId = task.conversationId ?? this.deps.sessionId;
          return [conversationId, this.conversationTaskSchedulerRepo.getSlot(conversationId).activeTaskId];
        }),
      ),
      occupiedConversationIds: this.conversationTaskSchedulerRepo.listSlots()
        .filter(slot => slot.state !== 'free')
        .map(slot => slot.conversationId),
      queuedTaskCountByConversation: Object.fromEntries(
        this.conversationTaskSchedulerRepo.listSlots().map(slot => [
          slot.conversationId,
          this.conversationTaskSchedulerRepo.countQueuedTasks(slot.conversationId),
        ]),
      ),
      activeTaskCount: this.conversationTaskSchedulerRepo
        .listSlots()
        .filter(slot => slot.state === 'occupied' || slot.state === 'releasing').length ?? 0,
      runningTaskId: this.taskRuntimeService.getCurrentRunningTask()?.id ?? null,
      plannerConfiguration,
      kernelConfiguration: this.kernelConfiguration,
      executorStatuses: this.kernelExecutorStatusRepo.list(
        event.configurationRevision,
      ),
      v5WorkGraphTaskIds: this.subtaskRepo.listTaskIds(),
      eligibleContextRefKeys: this.buildEligibleContextRefKeys(
        event.proposal as PlanningAgentPlan,
        userInput,
        event.attachmentIds,
      ),
      pendingAuthorizationRequest: (() => {
        const pending = this.permissionRepository.findOldestPendingForConversation(
          event.conversationId ?? this.deps.sessionId,
        );
        return pending ? { requestId: pending.request.id, taskId: pending.request.taskId } : null;
      })(),
    };
  }

  private buildEligibleContextRefKeys(
    plan: PlanningAgentPlan,
    userInput: string,
    attachmentIds: readonly string[] = [],
  ): string[] {
    const targetTask = plan.task.taskId ? this.taskRuntimeService.findTask(plan.task.taskId) : null;
    return buildEligibleContextRefKeys({
      db: this.deps.db,
      sessionId: this.deps.sessionId,
      conversationId: this.deps.sessionId,
      accountId: LOCAL_DEFAULT_ACCOUNT_ID,
      refs: (plan.workGraph?.subtasks ?? []).flatMap(subtask => subtask.contextRefs),
      attachmentIds,
      targetTask,
      userInput,
    });
  }

  private appendPlanningClarification(plan: PlanningAgentPlan): void {
    this.appendOutput(
      plan.clarificationQuestion
        || '我不确定你是想继续聊天、创建新任务，还是恢复某个已有任务。请明确说明下一步动作。',
    );
  }

  private prepareTaskExecution(
    taskId: string,
    request: QueuedExecutionRequest,
  ): TaskExecutionStart {
    return this.taskExecutionApplicationService.prepareTaskExecution(taskId, request);
  }

  private startBackgroundExecution(taskId: string, launch: () => Promise<void>): Promise<void> {
    const scheduled = new Promise<void>(resolveWork => {
      setTimeout(() => {
        void launch().catch(error => {
          this.appendOutput(`Executor background failure for ${taskId}: ${(error as Error).message}`);
          this.refreshRuntimeState();
        }).finally(resolveWork);
      }, 0);
    });
    this.trackBackgroundWork(scheduled);
    return scheduled;
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
    const tasks = this.listLocalTasks();
    this.workspaceRetentionService.reconcileTaskStatuses(tasks);
    this.triggerWorkspaceRetentionSweep();
    const runningTask = tasks.find(task => task.status === 'running') ?? null;
    const schedulerState: RuntimeState = {
      runningTaskId: runningTask?.id ?? this.kernelExecutionRuntime.getSingleActiveTaskId(),
      runningExecutorName: null,
      queuedTaskIds: tasks.filter(task => task.status === 'queued').map(task => task.id),
      needsActionTaskIds: tasks.filter(task => task.status === 'needs_action').map(task => task.id),
      lastEvent: this.runtimeState.lastEvent,
    };
    this.runtimeState = {
      ...schedulerState,
      runningExecutorName: schedulerState.runningTaskId
        ? this.formatRunningExecutors(schedulerState.runningTaskId)
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
      tasks: this.listLocalTasks(),
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

  /**
   * The retained MetaclawSession is the only surface that can present tasks
   * migrated before explicit Conversation ownership existed. Account-level
   * scheduling still uses the unfiltered TaskRuntimeService directly.
   */
  private listLocalTasks(): Task[] {
    return this.taskRuntimeService.listTasks()
      .filter(task => taskBelongsToConversation(task, this.deps.sessionId, true));
  }

  private listLocalTasksByStatus(status: Task['status']): Task[] {
    return this.taskRuntimeService.listTasksByStatus(status)
      .filter(task => taskBelongsToConversation(task, this.deps.sessionId, true));
  }

  private findLocalTask(taskId: string): Task | null {
    const task = this.taskRuntimeService.findTask(taskId);
    return task && taskBelongsToConversation(task, this.deps.sessionId, true) ? task : null;
  }

  private async handleCommand(userInput: string): Promise<boolean> {
    if (/^\/task\s+(resume|recover|recovery)\b/iu.test(userInput)) {
      await this.executorRecoveryRefreshService.refresh({ trigger: 'task_recovery' });
    }
    const result = await this.commandCatalog.execute(userInput, this.getCommandContext());
    this.appendOutput(result.content);
    if (/^\/executor\s+(register|unregister)\b/iu.test(userInput)) {
      await this.executorRecoveryRefreshService.refresh({ trigger: 'executor_changed' });
    }

    if (result.type === 'exit') {
      this.persistSessionState({ lastSessionId: this.deps.sessionId });
      return true;
    }

    if (result.type === 'directive' && result.directive.kind === 'resume-task') {
      const directive = result.directive;
      const resumedTask = this.findLocalTask(directive.taskId);
      if (resumedTask) {
        this.setCurrentTaskId(resumedTask.id);
        const started = this.prepareTaskExecution(resumedTask.id, {
          userPrompt: resumedTask.goal,
          contextTaskId: resumedTask.id,
          expectedGenerationId: directive.expectedGenerationId,
          expectedGraphRevision: directive.expectedGraphRevision,
          executionMode: directive.mode,
          schedulingReason: directive.mode === 'resume-blocked' ? '继续处理' : '恢复已暂停任务',
          newlyProvidedResources: directive.newlyProvidedResources,
          recoveryTrigger: directive.mode === 'resume-blocked'
            ? this.buildRecoveryTrigger(resumedTask, {
                kind: 'explicit-task-command',
                blockedReason: directive.blockedReason,
                triggerReason: directive.newlyProvidedResources?.length
                  ? '显式继续处理并补充材料'
                  : '显式继续处理',
                sourceInput: userInput,
                newlyProvidedResources: directive.newlyProvidedResources,
              })
            : undefined,
        });
        const decision = await started.decision;
        if (!decision) {
          await started.completion;
          this.appendOutput(`任务 #${resumedTask.id} 恢复请求未产生权威控制操作`);
        } else {
          this.appendOutput(formatTaskResumeDecision(resumedTask.id, decision, resumedTask.status));
          if (decision.action.type !== 'resume_task') await started.completion;
        }
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

  private triggerWorkspaceRetentionSweep(): void {
    if (this.workspaceRetentionSweep) return;
    const sweep = this.workspaceRetentionService.sweepDue()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.workspaceRetentionSweep = null;
      });
    this.workspaceRetentionSweep = sweep;
    this.trackBackgroundWork(sweep);
  }

  private async resolvePermission(input: {
    requestId: string;
    resolution: 'approve' | 'deny';
    source: 'button' | 'planner';
    plannerPlanId?: string | null;
  }): Promise<void> {
    const record = this.permissionRepository.findRequest(input.requestId);
    if (!record) throw new Error(`permission request not found: ${input.requestId}`);
    const attemptExecution = this.attemptExecutionRepository.find(record.request.attemptId);
    const dispatchItem = new ControlDispatchItemRepo(this.deps.db)
      .find(record.request.attemptId);
    if (!dispatchItem) {
      throw new Error(
        `permission request has no authorized dispatch identity: ${record.request.attemptId}`,
      );
    }
    const workspaceId = attemptExecution?.workspaceId
      ?? `workspace:${record.request.taskId}:${record.request.generationId}:${record.request.subtaskId}`;
    const task = this.taskRuntimeService.findTask(record.request.taskId);
    const resourceRegistrations = new Map((task?.resources ?? []).map((resource, index) => [
      resource,
      { kind: 'path' as const, mountId: `inputs-${record.request.taskId}`, normalizedRelativePath: `resource-${index}` },
    ]));
    const workflow = new PermissionWorkflowService({
      context: {
        sessionId: this.deps.sessionId,
        taskId: record.request.taskId,
        generationId: record.request.generationId,
        subtaskId: record.request.subtaskId,
        attemptId: record.request.attemptId,
        agentClassName: record.request.agentClassName,
        configurationRevision: dispatchItem.configurationRevision,
        authorizedDecisionId: dispatchItem.decisionId,
        permissionProfileId: record.request.permissionProfileId,
        containerId: attemptExecution?.containerId ?? '',
        workspaceId,
        checkpointId: null,
      },
      repository: this.permissionRepository,
      resolver: new RegisteredCapabilityResourceResolver(resourceRegistrations),
      executionBackend: this.attemptExecutionBackend,
      rules: buildPermissionRules({
        permissionProfileId: record.request.permissionProfileId,
        additionalReadPartitions: resourceRegistrations.values(),
      }),
      ...(this.deps.managerPermissionJudge ? { manager: this.deps.managerPermissionJudge } : {}),
      hooks: {
        checkpoint: async () => null,
        onEscalation: async () => undefined,
        onRecoveryAuthorized: async ({ request }) => {
          if (!task || !request) return;
          await this.prepareTaskExecution(task.id, {
            userPrompt: task.goal,
            contextTaskId: task.id,
            executionMode: 'resume-blocked',
            schedulingReason: `permission ${input.requestId} approved; recover persistent workspace`,
          });
        },
      },
    });
    await workflow.resolve({
      requestId: input.requestId,
      resolution: input.resolution,
      source: input.source,
      plannerPlanId: input.plannerPlanId ?? null,
    });
  }

  /**
   * Startup recovery could not prove a safe resumption. It records the durable
   * blocker and asks the authority to conclude; it never picks a status itself.
   */
  /**
   * Releases the Conversation slot for a Task that stopped to wait for the user,
   * so the user's next answer is admitted instead of queued behind it. It only
   * releases a slot this Task actually holds and never promotes twice: the
   * scheduler's release+promote is a single transaction.
   */
  private async releasePausedTaskSlot(taskId: string): Promise<void> {
    try {
      const task = this.taskRuntimeService.findTask(taskId);
      if (!task || task.status !== 'needs_action') return;
      const now = new Date().toISOString();
      this.conversationTaskSchedulerRepo.parkScheduleEntry(taskId, now);
      const conversationId = task.conversationId;
      const slot = conversationId
        ? this.conversationTaskSchedulerRepo.getSlot(conversationId)
        : null;
      if (conversationId && slot && slot.activeTaskId === taskId && slot.state !== 'free') {
        // Never hand the slot on while this Task still owns a live operation: the
        // shared residue reader decides, and the slot stays `releasing` until the
        // periodic convergence confirms the cleanup and promotes the successor.
        const generationId = this.workGraphRevisionRepo.findActive(taskId)?.generationId ?? null;
        const residue = this.cancellationCoordinator?.completionBlockedReasons(
          taskId,
          generationId,
        ) ?? [];
        this.conversationTaskSchedulerRepo.releaseSlotAndPromote(
          conversationId,
          taskId,
          now,
          () => (this.cancellationCoordinator?.completionBlockedReasons(taskId, generationId) ?? residue).length > 0,
          true, { reservationId: slot.reservationId, slotVersion: slot.slotVersion, taskVersion: task.stateVersion },
        );
      }
      this.refreshRuntimeState();
    } catch {
      // Periodic account convergence repeats the same release from durable facts.
    }
  }

  private markStartupRecoveryBlocked(taskId: string, reason: string, task?: Task): void {
    const current = task ?? this.taskRuntimeService.findTask(taskId);
    if (!current) return;
    this.taskRuntimeService.updateTask(taskId, {
      dependencies: [
        ...current.dependencies.filter(dependency => !(dependency.status === 'waiting'
          && dependency.type === 'manual' && dependency.description === reason)),
        {
          taskId,
          type: 'manual',
          description: reason,
          status: 'waiting' as const,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    // Recovery could not verify the external side effect, so it records an
    // `unknown` result instead of pretending the stale dispatch is still live.
    try {
      this.taskOperationResults.record({
        taskId,
        operationKey: `startup_recovery:${taskId}`,
        operationKind: 'execution',
        outcome: 'unknown',
        reasonCode: 'external_outcome_unknown',
        message: reason,
        evidenceRefs: [`task:${taskId}`],
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // The durable blocker below still keeps the Task out of running.
    }
    this.taskStateAuthority.reconcile({
      taskId,
      decisionId: `startup_recovery:${taskId}:${current.stateVersion}`,
      operationKey: `startup_recovery:${taskId}:${current.stateVersion}`,
      actor: 'account-startup-recovery',
      reason,
    });
  }

  private lifecyclePort(): TaskLifecycleTransitionPort {
    return this.lifecycle ??= this.taskLifecyclePort;
  }

  private formatTaskRecovery(taskId: string): string {
    const task = this.findLocalTask(taskId);
    const applications = this.recoveryItems.listRecoveryItems(taskId).map(item => {
      const diagnosis = inspectApplicationAgainstSources(item, {
        findTask: id => {
          const record = this.taskRuntimeService.findTask(id);
          return record
            ? {
                id: record.id,
                status: record.status,
                dependencies: record.dependencies.map(dependency => ({
                  type: dependency.type,
                  status: dependency.status,
                })),
              }
            : null;
        },
        listSubtasks: id => this.subtaskRepo.listByTask(id)
          .map(subtask => ({ id: subtask.id, status: subtask.status })),
        listDispatchItems: id => this.dispatchItemRepo.listByTask(id).map(dispatch => ({
          attemptId: dispatch.attemptId,
          decisionId: dispatch.decisionId,
          causationId: null,
          subtaskId: dispatch.subtaskId,
          generationId: dispatch.generationId,
          attemptKind: dispatch.attemptKind,
          bindingFingerprint: dispatch.bindingFingerprint,
          configurationRevision: dispatch.configurationRevision,
          sourceAttemptId: dispatch.sourceAttemptId,
          status: dispatch.status,
        })),
        findWorkGraphRevision: (id, revision) => {
          const record = this.workGraphRevisionRepo.find(id, revision);
          return record
            ? {
                revision: record.revision,
                generationId: record.generationId,
                authorizedOperationId: record.authorizedOperationId,
                status: record.status,
              }
            : null;
        },
        findReplanRequest: (id, generationId, sourceRevision) => (
          this.generationReplanRepo.findByGeneration(id, generationId, sourceRevision)
        ),
        findReplanRequestById: id => this.generationReplanRepo.find(id),
      });
      return `- ${item.id} [application/${item.status}] ${item.decision.action.type}: `
        + `${item.errorSummary ?? 'no error summary'}`
        + ` -> ${diagnosis.family}/${diagnosis.verdict}: ${diagnosis.reason}`;
    });
    const effects = this.effectOutboxRepo.listRecoveryItems(taskId).map(item =>
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
      ? `任务 #${taskId} 的恢复项：\n${items.join('\n')}`
      : `任务 #${taskId} 没有自动恢复项：阻塞不在恢复队列里，请人工核对后取消任务并重新提交需求。`;
  }

  private async resolveTaskRecovery(input: {
    taskId: string;
    recoveryItemId: string;
    resolution: 'assume_applied' | 'retry';
  }): Promise<void> {
    const application = this.recoveryItems.findRecoveryItem(input.recoveryItemId);
    const effect = this.effectOutboxRepo.find(input.recoveryItemId);
    // The active graph revision pins the configuration for this Task; a recovery
    // item may pin an older one when the revision was replaced.
    const configurationRevision = application?.decision.configurationRevision
      ?? this.workGraphRevisionRepo.findActive(input.taskId)?.configurationRevision
      ?? null;
    if (!configurationRevision) {
      throw new Error(
        `recovery item has no persisted configuration revision: ${input.recoveryItemId}`,
      );
    }
    const event: Extract<ControlEvent, { type: 'recovery_resolution_requested' }> = {
      schemaVersion: 5,
      configurationRevision,
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
    const workflow = new TaskControlWorkflow({
      recordUncertain: input => {
        if (!input.taskId) return;
        const message = input.error instanceof Error ? input.error.message : String(input.error);
        this.recoveryItems.record({
          operation: input.operation,
          taskId: input.taskId,
          subtaskId: input.subtaskId,
          attemptId: input.attemptId,
          errorSummary: message.replace(/[\r\n]+/gu, ' ').slice(0, 320),
          createdAt: new Date().toISOString(),
        });
      },
      kernel: this.controlLoop,
      buildSnapshot: claimed => {
        const recovery = claimed as Extract<ControlEvent, { type: 'recovery_resolution_requested' }>;
        return this.buildRecoverySnapshot(recovery.taskId!, recovery.recoveryItemId);
      },
      clock: { now: () => new Date().toISOString() },
      runtime: {
        apply: async decision => {
          if (decision.action.type === 'resolve_recovery') {
            const now = new Date().toISOString();
            if (this.recoveryItems.findRecoveryItem(decision.action.recoveryItemId)) {
              this.recoveryItems.resolveRecoveryItem(
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
  ): Extract<ControlSnapshot, { type: 'recovery' }> {
    const task = this.taskRuntimeService.findTask(taskId);
    const application = this.recoveryItems.findRecoveryItem(recoveryItemId);
    const effect = this.effectOutboxRepo.find(recoveryItemId);
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

  private getCommandContext(): CommandContext {
    return {
      taskEngine: this.deps.taskEngine,
      orchestration: this.deps.orchestration,
      activeExecutions: this.executionRuntime,
      conversationId: this.deps.sessionId,
      taskControl: this.kernelExecutionRuntime,
      readServices: this.commandReadServices,
      refreshExecutors: agentClassNames => this.executorRecoveryRefreshService.refresh({
        trigger: 'manual',
        agentClassNames,
      }),
      currentTaskId: this.getCurrentTaskId(),
      db: this.deps.db,
      config: this.deps.config,
      executorAgentClassNames: this.agentClassService.listExecutorAgentClassNames(),
    };
  }

  private async handleNaturalLanguageInput(
    userInput: string,
    images?: PlannerImageAttachment[],
  ): Promise<void> {
    if (await this.handlePlanningControlDecision(userInput, images)) {
      return;
    }

    this.appendOutput(
      '-> Task Runtime produced no action for this turn.',
      'Please clarify whether you want to chat, create a new task, resume an existing task, or dispatch an executor.',
    );
  }

  private getPlannerTimeoutMs(): number {
    const configured = Number(process.env.METACLAW_PLANNER_TIMEOUT_MS);
    return Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_PLANNER_TIMEOUT_MS;
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
    const backendLossAttemptIds = new Set<string>();
    const claimedOrphans = this.workUnitClaimService.listOrphanedClaims();
    const dispatchItems = new ControlDispatchItemRepo(this.deps.db);
    const requiresAttemptReconciliation = claimedOrphans.length > 0
      || this.attemptExecutionRepository.listActive().length > 0
      || this.taskRuntimeService.listTasksByStatus('running').some(task =>
        dispatchItems.listByTask(task.id).some(item =>
          ['launching', 'running', 'cancelling', 'uncertain'].includes(item.status)
        )
      );
    let recoveryBlockedReason: string | null = null;
    try {
      if (requiresAttemptReconciliation) {
        const checkpointIds = new Map<string, string | null>();
        const reconciliation = await new AttemptExecutionBackendReconciler(
          this.attemptExecutionBackend,
          this.attemptExecutionRepository,
        ).reconcile({
          checkpoint: async record => {
            const persisted = this.workspaceRepository.find(record.workspaceId);
            if (!persisted) {
              checkpointIds.set(record.attemptId, null);
              return;
            }
            const workspace = await this.workspaceStore.ensureWorkspace({
              taskId: persisted.taskId,
              generationId: persisted.generationId,
              subtaskId: persisted.subtaskId,
            }, persisted.kind);
            const checkpoint = await this.workspaceStore.createCheckpoint(workspace, {
              reason: 'failure', attemptId: record.attemptId, now,
            });
            this.workspaceRepository.recordCheckpoint({
              id: checkpoint.id,
              workspaceId: workspace.id,
              attemptId: record.attemptId,
              reason: 'failure',
              manifestUri: checkpoint.manifestUri,
              manifestHash: checkpoint.manifestHash,
              manifestSize: checkpoint.manifestSize,
              createdAt: checkpoint.manifest.createdAt,
              objects: checkpoint.manifest.entries.flatMap(entry => (
                entry.type === 'file' && entry.hash && entry.objectUri
                  ? [{ hash: entry.hash, uri: entry.objectUri, size: entry.size, mediaType: null }]
                  : []
              )),
            });
            checkpointIds.set(record.attemptId, checkpoint.id);
          },
        });
        for (const record of [...reconciliation.lostAttempts, ...reconciliation.exitedAttempts]) {
          if (backendLossAttemptIds.has(record.attemptId)) continue;
          backendLossAttemptIds.add(record.attemptId);
          const dispatchItem = dispatchItems.find(record.attemptId);
          if (!dispatchItem) {
            throw new Error(
              `startup recovery found attempt without authorized dispatch: ${record.attemptId}`,
            );
          }
          if (dispatchItem && ['cancelling', 'cancelled'].includes(dispatchItem.status)) {
            continue;
          }
          dispatchItems.markUncertain(
            record.attemptId,
            `execution backend ${record.containerId} was reconciled during startup`,
            now,
          );
          await this.kernelExecutionRuntime.submitControlEvent({
            schemaVersion: 5,
            configurationRevision: dispatchItem.configurationRevision,
            type: 'sandbox_lost',
            id: `sandbox_lost_${record.attemptId}`,
            correlationId: record.taskId,
            causationId: record.attemptId,
            occurredAt: now,
            sessionId: this.deps.sessionId,
            taskId: record.taskId,
            subtaskId: record.subtaskId,
            attemptId: record.attemptId,
            containerId: record.containerId,
            workspaceId: record.workspaceId,
            checkpointId: checkpointIds.get(record.attemptId) ?? null,
            authorizedBinding: dispatchItem.authorizedBinding,
            bindingFingerprint: dispatchItem.bindingFingerprint,
            attemptKind: dispatchItem.attemptKind,
            sourceAttemptId: dispatchItem.sourceAttemptId,
            recoveryMode: dispatchItem.recoveryMode,
          }, 'startup sandbox loss recovery');
        }
      }
      await this.kernelExecutionRuntime.recoverCancellations();
    } catch (error) {
      recoveryBlockedReason = error instanceof Error ? error.message : String(error);
    }
    if (recoveryBlockedReason) {
      const blocked: Task[] = [];
      const runningTasks = this.listLocalTasksByStatus('running');
      for (const task of runningTasks) {
        try {
          this.markStartupRecoveryBlocked(task.id, `startup recovery requires handling: ${recoveryBlockedReason}`, task);
        } catch {
          // Keep the in-memory recovery fence even if persistence is unavailable.
        }
        const current = this.findLocalTask(task.id);
        if (current) blocked.push(current);
      }
      this.appendOutput(
        `恢复任务：无法安全对账原生进程、Git 或持久状态（${recoveryBlockedReason}）。`,
        '已保留现有执行后端实例、WorkUnit claim 与 resource lease；恢复对账成功前不会启动 attempt。',
      );
      return blocked;
    }
    this.effectOutboxRepo.reconcileSending(now);
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

    const planningWorkflow = new TaskControlWorkflow({
        recordUncertain: input => {
          if (!input.taskId) return;
          const message = input.error instanceof Error ? input.error.message : String(input.error);
          this.recoveryItems.record({
            operation: input.operation,
            taskId: input.taskId,
            subtaskId: input.subtaskId,
            attemptId: input.attemptId,
            errorSummary: message.replace(/[\r\n]+/gu, ' ').slice(0, 320),
            createdAt: new Date().toISOString(),
          });
        },
        kernel: this.controlLoop,
        buildSnapshot: event => this.buildPlanAdmissionSnapshot(
          event as Extract<ControlEvent, { type: 'plan_proposed' }>,
        ),
          runtime: this.sessionControlRuntime.forInput(),
        clock: { now: () => new Date().toISOString() },
        acceptedEventTypes: ['plan_proposed'],
        acceptedActions: [
          'reject_request', 'request_clarification', 'no_op',
          'authorize_task_plan', 'authorize_task_control', 'block_work', 'park_for_replan',
        ],
    });
    await planningWorkflow.recover();

    const reconciledLeases = new ResourceLeaseService(
      new SqliteResourceLeaseRepository(this.deps.db),
    );
    const recovered: Task[] = [];
    try {
      for (const task of this.listLocalTasksByStatus('running')) {
      const activeSubtasks = this.subtaskRepo.listActiveByTask(task.id);
      const subtasks = activeSubtasks.length > 0 ? activeSubtasks : this.subtaskRepo.listByTask(task.id);
      const taskClaims = claimedOrphans.filter(workUnit => workUnit.claimedTaskId === task.id);
      for (const workUnit of taskClaims) {
        if (!workUnit.claimedSubtaskId || !workUnit.claimedAttemptId) continue;
        const dispatchItem = dispatchItems.find(workUnit.claimedAttemptId);
        if (!dispatchItem) {
          throw new Error(
            `startup orphan has no authorized dispatch identity: ${workUnit.claimedAttemptId}`,
          );
        }
        if (!backendLossAttemptIds.has(workUnit.claimedAttemptId)) {
          this.attemptRunner.landHeartbeatLost({
            attemptId: workUnit.claimedAttemptId,
            executionId: `startup_${workUnit.claimedAttemptId}`,
            taskId: task.id,
            subtaskId: workUnit.claimedSubtaskId,
            workUnitId: workUnit.id,
            authorizedBinding: dispatchItem.authorizedBinding,
            bindingFingerprint: dispatchItem.bindingFingerprint,
          });
        }
        reconciledLeases.releaseReconciledAttempt(workUnit.claimedAttemptId, now);
        this.workUnitClaimService.releaseReconciledClaim({
          workUnitId: workUnit.id,
          taskId: task.id,
          subtaskId: workUnit.claimedSubtaskId,
          attemptId: workUnit.claimedAttemptId,
        });
      }
      if (taskClaims.length === 0 && this.recoveryItems.countPending(task.id) === 0
        && this.retryWakeRepo.findBlockingByTask(task.id).length === 0) {
        const orphan = subtasks.find(subtask => !['done', 'cancelled'].includes(subtask.status));
        if (orphan) {
          const dispatchItem = dispatchItems.listByTask(task.id)
            .find(item => (
              item.subtaskId === orphan.id
              && ['launching', 'running', 'uncertain'].includes(item.status)
            ));
          if (!dispatchItem) {
            throw new Error(
              `startup task has active Subtask without authorized dispatch: ${orphan.id}`,
            );
          }
          await this.kernelExecutionRuntime.submitControlEvent(startupOrphanEvent({
            sessionId: this.deps.sessionId,
            task,
            subtaskId: orphan.id,
            attemptId: dispatchItem.attemptId,
            authorizedBinding: dispatchItem.authorizedBinding,
            bindingFingerprint: dispatchItem.bindingFingerprint,
            attemptKind: dispatchItem.attemptKind,
            sourceAttemptId: dispatchItem.sourceAttemptId,
            occurredAt: now,
          }), 'startup orphan dispatch recovery');
        }
      }
      await this.kernelExecutionRuntime.recoverDue(task.id, 'startup durable recovery');
      const current = this.findLocalTask(task.id);
      if (current) recovered.push(current);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const blocked: Task[] = [];
      const runningTasks = this.listLocalTasksByStatus('running');
      for (const task of runningTasks) {
        try {
          this.markStartupRecoveryBlocked(task.id, `startup recovery blocked: ${reason}`, task);
        } catch {
          // Preserve durable attempt ownership if even the diagnostic Task update fails.
        }
        const current = this.findLocalTask(task.id);
        if (current) blocked.push(current);
      }
      this.appendOutput(
        `恢复任务：无法安全封口 attempt terminal 事实（${reason}）。`,
        '已保留尚未安全封口的 WorkUnit claim 与 resource lease；修复持久状态后可重试启动恢复。',
      );
      return blocked;
    }
    for (const task of this.listLocalTasksByStatus('needs_action')) {
      if (recovered.some(item => item.id === task.id)) continue;
      await this.kernelExecutionRuntime.recoverDue(task.id, 'startup due-event drain');
    }
    return recovered;
  }

  private setRunningExecutorName(
    taskId: string,
    subtaskId: string,
    attemptId: string,
    name: string,
  ): void {
    this.runningExecutorsByAttempt.set(attemptId, { taskId, subtaskId, name });
    this.runtimeState = {
      ...this.runtimeState,
      lastEvent: `Kernel dispatched ${name} for ${taskId}/${subtaskId}/${attemptId}`,
    };
    this.refreshRuntimeState();
  }

  private appendExecutionTrace(input: ExecutionTraceAppendInput): void {
    const current = this.interactionTraceStream.getSnapshot();
    if (!current || current.status !== 'running') return;
    this.interactionTraceStream.append(input);
  }

  private clearRunningExecutorName(taskId: string, attemptId?: string): void {
    if (attemptId) {
      this.runningExecutorsByAttempt.delete(attemptId);
    } else {
      for (const [activeAttemptId, active] of this.runningExecutorsByAttempt) {
        if (active.taskId === taskId) this.runningExecutorsByAttempt.delete(activeAttemptId);
      }
    }
    this.runtimeState = { ...this.runtimeState, lastEvent: `Kernel execution settled for ${taskId}` };
    this.refreshRuntimeState();
  }

  private formatRunningExecutors(taskId: string): string | null {
    const names = [...this.runningExecutorsByAttempt.values()]
      .filter(active => active.taskId === taskId)
      .map(active => active.name)
      .sort();
    if (names.length === 0) return null;
    const counts = new Map<string, number>();
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    return [...counts].map(([name, count]) => count === 1 ? name : `${name} ×${count}`).join(', ');
  }

  private trackBackgroundWork(work: Promise<void>): void {
    this.backgroundWork.add(work);
    void work.finally(() => {
      this.backgroundWork.delete(work);
    });
  }

}

function planAdmissionActionName(
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
