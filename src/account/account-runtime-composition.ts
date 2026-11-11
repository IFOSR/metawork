import type { UsagePayerResolver } from '../metering/usage-payer.js';
import type { ManagedLocalServices } from '../execution/managed-local-service.js';
/**
 * AccountRuntime 组合辅助（ADR-0031 第 2、12 节）。
 *
 * 组合根专用：从安装全局依赖 + 配置构造账户的 8 个 runtime-wide 服务簇，
 * 再通过 AccountRuntimeFactory 组装 AccountRuntime。会话级 callbacks 与
 * kernelExecutionServices 由 ConversationSession 通过端口自行构造。
 */

import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { TaskEngine } from '../task/task-engine.js';
import type { OrchestrationEngine } from '../guidance/orchestration.js';
import type { NotificationService } from '../notifications/types.js';
import type { StagedLegacyConfiguration } from '../configuration/staged-legacy-configuration.js';
import type { RuntimePrivateConfigurationBinding } from '../configuration/index.js';
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import type { RevisionedAgentBinding } from '../core/authorized-executor-binding.js';
import type { PlanningAgent } from '../planning/planning-agent.js';
import { buildPlannerConfigurationView } from '../configuration/index.js';
import type { AttemptExecutionBackend } from '../execution/attempt-execution-backend.js';
import type { ProbeCommandRunner } from '../executor/harness-driver.js';
import { ArtifactVersionRepo } from '../storage/artifact-version-repo.js';
import { buildAccountControlServices } from './account-control-services.js';
import { buildAccountRepositories } from './account-repositories.js';
import { buildAccountWorkspaceServices } from './account-workspace-services.js';
import { buildAccountTaskServices } from './account-task-services.js';
import { createTaskLifecyclePort, createTaskStateAuthority } from './task-state-composition.js';
import { buildAccountExecutionServices } from './account-execution-services.js';
import { buildAccountCoordinatorServices } from './account-coordinator-services.js';
import { buildAccountRuntimeExecutionServices } from './account-runtime-execution-services.js';
import { buildAccountPlannerServices, type AccountPlannerServices } from './account-planner-services.js';
import { AccountControlCoordinator } from './account-control-coordinator.js';
import { AccountRuntimeFactory } from './account-runtime-factory.js';
import { AccountRuntime } from './account-runtime.js';
import type { ConversationRuntimePort } from './account-runtime-ports.js';
import type { AccountConversationExecutionBinder } from './account-conversation-execution-binder.js';
import type { ExecutionRuntime } from '../execution/execution-runtime.js';
import {
  buildAccountControlExecutionServices,
  type AccountControlExecutionServices,
} from './account-control-execution-services.js';
import {
  createAccountConversationExecutionBinder,
} from './account-conversation-execution-binder.js';
import { SessionPersistenceService } from '../session/session-persistence-service.js';
import { SessionPresentationService } from '../session/session-presentation-service.js';
import { ControlExecutorStatusProjector } from '../execution/control-executor-status-projector.js';
import { VerificationAndDeliveryService } from '../delivery/verification-and-delivery-service.js';
import { UserArtifactPublicationService } from '../delivery/user-artifact-publication-service.js';
import { TaskArtifactRepo } from '../storage/task-artifact-repo.js';
import { readTaskOriginInput } from '../storage/task-origin-input.js';
import { createSqliteAccountPermissionService } from './sqlite-account-permission-service.js';
import { AccountStartupRecoveryService } from './account-startup-recovery-service.js';
import type { ConfigurationActivationGate } from '../configuration/configuration-activation-gate.js';
import type { ConversationActivityProjection } from '../workspace/conversation-activity-projector.js';
import type { GatewayAttachmentStore } from '../gateway/attachment-store-port.js';
import type { RawUsageEvent } from '../metering/usage-normalizer.js';
import type { Payer } from '../metering/usage-payer.js';
import type { QueryUsageLifecycle } from '../metering/query-lifecycle.js';
import type { ConversationResultDelivery } from '../session/conversation-session.js';
import type { ExecutionTraceAppendInput } from '../execution/execution-trace.js';
import type { ManagerPermissionJudge } from '../execution/permission-workflow-service.js';
import type { ControlDecisionAction } from '../control/control-contracts.js';
import { ATTEMPTS_PER_TASK_BUDGET } from '../core/runtime-limits.js';

/**
 * Plan-admission decisions that the account coordinator must apply before
 * returning the authoritative result to a Conversation. Permission
 * resolutions use the same `plan_proposed` event as ordinary task plans.
 */
export const ACCOUNT_KERNEL_ACCEPTED_ACTIONS: ControlDecisionAction['type'][] = [
  'reject_request',
  'request_clarification',
  'no_op',
  'authorize_task_plan',
  'authorize_task_control',
  'block_work',
  'park_for_replan',
  'record_permission_resolution',
  'resolve_recovery',
];

export interface AccountRuntimeComposition {
  readonly accountRuntime: AccountRuntime;
  /** Account-level Planner services (Manager transport by default). */
  readonly plannerServices: AccountPlannerServices;
  readonly runtimePort: ConversationRuntimePort;
  readonly conversationExecutionBinder: AccountConversationExecutionBinder;
  /** Shared per-account control services; scoping happens via `runWith`. */
  readonly controlExecutionServices: AccountControlExecutionServices;
  readonly executionRuntime: ExecutionRuntime;
}

export function buildAccountRuntimeComposition(deps: {
  accountId: string;
  recoveryReplan?: import('../session/recovery-replanner.js').RecoveryReplan;
  recoveryPlan?: PlanningAgent['plan'];
  resolveConfigurationSnapshot?: (revisionId: string) => Promise<import('../configuration/types.js').ConfigurationSnapshot>;
  db: Database.Database;
  taskEngine: TaskEngine;
  /**
   * Long-term memory delivery. Optional: without it the Executor never sees a
   * memory asset, and the memory seam stays closed.
   */
  memoryEvidence?: import('../memory/memory-evidence-service.js').MemoryEvidencePort;
  orchestration: OrchestrationEngine;
  notifier: NotificationService;
  /** 任务 → 会话工作区解析（恢复/定时请求缺 workspacePath 时兜底）。 */
  resolveWorkspacePath?: (taskId: string) => Promise<string | null>;
  preflightWorkspacePath?: (path: string) => Promise<string>;
  managedLocalServices?: ManagedLocalServices;
  productionAuthorization?: () => { allowed: boolean; reason?: string };
  /** Optional Manager semantic judge for unclassified Executor capabilities. */
  managerPermissionJudge?: ManagerPermissionJudge;
  /** 用户可见 Workspace 根（进程启动目录），与内部 workspaceStore 是不同依赖。 */
  userWorkspaceRoot?: string;
  resolveUserWorkspaceRoot?: (
    sessionId: string,
  ) => Promise<string | null> | string | null;
  workspaceRoot: string;
  attemptsRoot: string;
  resultsRoot: string;
  attachmentStore?: GatewayAttachmentStore;
  generatedRuntimeRoot: string;
  sourceRoot: string;
  sessionId: string;
  stagedConfiguration: StagedLegacyConfiguration;
  plannerBinding: RevisionedAgentBinding | null;
  plannerBindingFingerprint: string;
  getPlannerBinding?: () => {
    plannerBinding: import('../core/authorized-executor-binding.js').RevisionedAgentBinding | null;
    plannerBindingFingerprint: string;
  };
  /** Upstream-Pi Manager transport (ADR-0055 D6); required when the switch selects it. */
  managerTransport?: Parameters<typeof buildAccountPlannerServices>[0]['managerTransport'];
  /** Legacy vendored Planner agent, only for an explicit opt-out run. */
  legacyPlanningAgent?: Parameters<typeof buildAccountPlannerServices>[0]['legacyPlanningAgent'];
  getRuntimeBinding(
    binding: AuthorizedExecutorBinding,
  ): Promise<RuntimePrivateConfigurationBinding> | RuntimePrivateConfigurationBinding;
  getRuntimeConfiguration?: Parameters<typeof buildAccountExecutionServices>[0]['getRuntimeConfiguration'];
  getActiveRuntimeConfiguration?: Parameters<typeof buildAccountExecutionServices>[0]['getActiveRuntimeConfiguration'];
  probeCommand?: ProbeCommandRunner;
  attemptExecutionBackend?: AttemptExecutionBackend;
  planningAgent?: PlanningAgent;
  getConfigurationRevision(): string;
  blockedRecheckEnabled?: boolean;
  blockedRecheckIntervalMs?: number;
  buildControlCoordinator?(accountId: string): AccountControlCoordinator;
  recoverDurableStartup?(accountId: string): Promise<void>;
  onConversationActivityChanged?(
    conversationId: string,
    activity: ConversationActivityProjection,
  ): Promise<void> | void;
  configurationActivationGate?: ConfigurationActivationGate;
  usageObserver?: (event: RawUsageEvent) => void;
  usageSpanOpener?: import('../metering/ports.js').MeteringSpanRecord extends infer T
    ? (span: T) => void
    : never;
  usageSpanCloser?: (spanId: string, state: 'closed' | 'uncertain', closedAt: string) => void;
  usagePayer?: Payer;
  resolveUsagePayer?: UsagePayerResolver;
  spanRoutingEvaluator?: import('../routing/span-routing-types.js').SpanRoutingEvaluator | null;
  queryUsageLifecycle?: QueryUsageLifecycle;
  onSystemResultDelivery?: (sessionId: string, delivery: ConversationResultDelivery) => Promise<void>;
  appendExecutionTrace?: (sessionId: string, input: ExecutionTraceAppendInput) => void;
}): AccountRuntimeComposition {
  const kernelServices = buildAccountControlServices(deps.db);
  const repositories = buildAccountRepositories(deps.db, deps.accountId);
  const workspaceServices = buildAccountWorkspaceServices(deps.db, deps.workspaceRoot);
  const conversationExecutionBinder = createAccountConversationExecutionBinder();
  let startupRecovery!: AccountStartupRecoveryService;
  const taskLifecyclePort = createTaskLifecyclePort(deps.db);
  const taskServices = buildAccountTaskServices({
    nativeStateRoot: join(deps.attemptsRoot, 'native-processes'),
    taskEngine: deps.taskEngine,
    lifecyclePort: taskLifecyclePort,
    getAgentClasses: () => deps.stagedConfiguration.snapshot.config.agentClasses,
    attemptExecutionBackend: deps.attemptExecutionBackend,
  });
  const executionServices = buildAccountExecutionServices({
    stagedConfiguration: deps.stagedConfiguration,
    getRuntimeBinding: deps.getRuntimeBinding,
    getRuntimeConfiguration: deps.getRuntimeConfiguration,
    getActiveRuntimeConfiguration: deps.getActiveRuntimeConfiguration,
    probeCommand: deps.probeCommand,
    attemptExecutionBackend: taskServices.attemptExecutionBackend,
    attemptExecutionRepository: workspaceServices.attemptExecutionRepository,
    attemptsRoot: deps.attemptsRoot,
    generatedRuntimeRoot: deps.generatedRuntimeRoot,
  });
  const coordinatorServices = buildAccountCoordinatorServices({
    db: deps.db,
    executionRuntime: executionServices.executionRuntime,
    executorRegistry: executionServices.executorRegistry,
    kernelExecutorStatusRepo: repositories.kernelExecutorStatusRepo,
    getConfigurationRevision: deps.getConfigurationRevision,
  });
  const taskStateAuthority = createTaskStateAuthority({
    db: deps.db,
    taskRepo: deps.taskEngine.getTaskRepo(),
    subtaskRepo: repositories.subtaskRepo,
    workGraphRevisionRepo: repositories.workGraphRevisionRepo,
    workUnitClaimService: coordinatorServices.workUnitClaimService,
    // A Task that stops to wait for the user releases its Conversation slot so a
    // later answer is never queued behind it. `startupRecovery` is assigned
    // below; the closure resolves it at call time.
    onWaitingForUser: task => {
      void startupRecovery?.onWaitingForUser(task.id);
    },
  });
  const userArtifactPublication = deps.userWorkspaceRoot || deps.resolveUserWorkspaceRoot
    ? new UserArtifactPublicationService({
      ...(deps.userWorkspaceRoot ? { userWorkspaceRoot: deps.userWorkspaceRoot } : {}),
      ...(deps.resolveUserWorkspaceRoot
        ? { resolveUserWorkspaceRoot: deps.resolveUserWorkspaceRoot }
        : {}),
      accountId: deps.accountId,
      taskArtifactRepo: new TaskArtifactRepo(deps.db),
      // Fixed artifact versions live in the Runtime's own content store.
      objectRoot: join(workspaceServices.workspaceStore.objectsPath, 'artifacts'),
      artifactVersionRepo: new ArtifactVersionRepo(deps.db),
    })
    : null;

  const plannerModel = deps.plannerBinding
    ? deps.stagedConfiguration.snapshot.config.models[deps.plannerBinding.modelRef] : undefined;
  if (deps.plannerBinding && !plannerModel) {
    throw new Error(`Planner Model is unavailable: ${deps.plannerBinding.modelRef}`);
  }
  const plannerServices = buildAccountPlannerServices({
    ...(deps.planningAgent ? { planningAgent: deps.planningAgent } : {}),
    ...(deps.managerTransport ? { managerTransport: deps.managerTransport } : {}),
    ...(deps.legacyPlanningAgent ? { legacyPlanningAgent: deps.legacyPlanningAgent } : {}),
  });
  const managerPermissionJudge = deps.managerPermissionJudge ?? plannerServices.managerPermissionJudge;
  const runtimeExecutionServices = buildAccountRuntimeExecutionServices({
    conversationWorktrees: workspaceServices.conversationWorktrees,
    serviceWorktrees: workspaceServices.serviceWorktrees,
    workspaceMergeWorker: workspaceServices.workspaceMergeWorker,
    db: deps.db,
    sessionId: deps.sessionId,
    getSessionId: () => conversationExecutionBinder.currentSessionId() ?? deps.sessionId,
    accountId: deps.accountId,
    resultRoot: deps.resultsRoot,
    attachmentStore: deps.attachmentStore,
    sourceRoot: deps.sourceRoot,
    taskRuntimeService: taskServices.taskRuntimeService,
    taskStateAuthority,
    taskLifecyclePort,
    subtaskRepo: repositories.subtaskRepo,
    taskEventRepo: repositories.taskEventRepo,
    workGraphRevisionRepo: repositories.workGraphRevisionRepo,
    workUnitClaimService: coordinatorServices.workUnitClaimService,
    executionRuntime: executionServices.executionRuntime,
    agentClassService: taskServices.agentClassService,
    workspaceStore: workspaceServices.workspaceStore,
    attemptExecutionBackend: taskServices.attemptExecutionBackend,
    permissionRepository: workspaceServices.permissionRepository,
    managerPermissionJudge,
    workspaceRepository: workspaceServices.workspaceRepository,
    attemptExecutionRepository: workspaceServices.attemptExecutionRepository,
    conversationTaskSchedulerRepo: repositories.conversationTaskSchedulerRepo,
    ...(deps.resolveWorkspacePath ? { resolveWorkspacePath: deps.resolveWorkspacePath } : {}),
    ...(deps.preflightWorkspacePath ? { preflightWorkspacePath: deps.preflightWorkspacePath } : {}),
    ...(userArtifactPublication ? { userArtifactPublication } : {}),
    usageObserver: deps.usageObserver,
    usageSpanOpener: deps.usageSpanOpener,
    usageSpanCloser: deps.usageSpanCloser,
    usagePayer: deps.usagePayer,
    resolveUsagePayer: deps.resolveUsagePayer,
    ...(deps.memoryEvidence ? { memoryEvidence: deps.memoryEvidence } : {}),
  });
  const sharedPresentation = new SessionPresentationService();
  const verificationAndDeliveryService = new VerificationAndDeliveryService();
  // 用户可见 Workspace（进程启动目录）与内部 workspaceStore 是不同依赖；
  // 未提供时（如测试组合）不启用用户产物发布。
  const kernelExecutionServices = buildAccountControlExecutionServices({
    recoveryItems: kernelServices.recoveryItems,
    conversationWorktrees: workspaceServices.conversationWorktrees,
    serviceWorktrees: workspaceServices.serviceWorktrees,
    workspaceMergeWorker: workspaceServices.workspaceMergeWorker,
    managedLocalServices: deps.managedLocalServices,
    db: deps.db,
    sessionId: deps.sessionId,
    getSessionId: () => conversationExecutionBinder.currentSessionId() ?? deps.sessionId,
    accountId: deps.accountId,
    resultRoot: deps.resultsRoot,
    sourceRoot: deps.sourceRoot,
    orchestration: deps.orchestration,
    notifier: deps.notifier,
    // Internal budget: configuration values are not a scheduling input.
    maxAttemptsPerTask: ATTEMPTS_PER_TASK_BUDGET,
    onTaskTerminal: taskId => startupRecovery?.onTaskTerminal(taskId),
    onTaskQueued: taskId => startupRecovery?.onTaskQueued(taskId),
    getConfigurationRevision: deps.getConfigurationRevision,
    getRuntimeConfiguration: deps.getRuntimeConfiguration,
    ...(plannerServices.planningAgent.summarizeTask ? { summarizeCompletedTask: async input => {
      const snapshot = input.configurationRevision === deps.stagedConfiguration.snapshot.revisionId
        ? deps.stagedConfiguration.snapshot
        : await deps.resolveConfigurationSnapshot?.(input.configurationRevision);
      if (!snapshot || snapshot.revisionId !== input.configurationRevision) {
        throw new Error('manager_summary_configuration_unavailable');
      }
      const linked = deps.db.prepare('SELECT query_id FROM query_task_links WHERE task_id = ? ORDER BY linked_at LIMIT 1')
        .get(input.taskId) as { query_id: string } | undefined;
      const origin = readTaskOriginInput(deps.db, {
        accountId: deps.accountId, conversationId: input.conversationId, taskId: input.taskId,
      });
      return plannerServices.planningAgent.summarizeTask!({
        ...input, configuration: buildPlannerConfigurationView(snapshot),
        ...(origin ? { userInput: origin.userInput } : {}),
        ...(deps.usageObserver && linked ? { onUsage: usage => {
          const providerRef = usage.providerRef ?? null;
          deps.usageObserver!({
            sourceId: 'manager', sourceEventKey: `summary:${input.taskId}:${usage.sourceEventKey}`,
            sourceScope: 'model_request', callId: `summary:${input.taskId}:${usage.callId}`,
            queryId: linked.query_id, taskId: input.taskId, stage: 'planning', reason: 'primary',
            payer: providerRef ? deps.resolveUsagePayer?.(providerRef, input.configurationRevision)
              ?? deps.usagePayer ?? 'unknown' : 'unknown',
            agentClassRef: 'manager', providerRef, modelId: usage.modelId ?? null,
            capturedAt: usage.occurredAtUtc ?? new Date().toISOString(),
            providerResponseId: usage.providerResponseId ?? null,
            evidenceRef: `task:${input.taskId}:summary`,
            counters: usage.counters, missing: usage.missing,
          });
        } } : {}),
      });
    } } : {}),
    taskRuntimeService: taskServices.taskRuntimeService,
    taskStateAuthority,
    ...(deps.resolveWorkspacePath ? { resolveWorkspacePath: deps.resolveWorkspacePath } : {}),
    ...(deps.preflightWorkspacePath ? { preflightWorkspacePath: deps.preflightWorkspacePath } : {}),
    ...(deps.productionAuthorization ? { productionAuthorization: deps.productionAuthorization } : {}),
    agentClassService: taskServices.agentClassService,
    workGraphRuntimeService: repositories.workGraphRuntimeService,
    subtaskRepo: repositories.subtaskRepo,
    workGraphRevisionRepo: repositories.workGraphRevisionRepo,
    effectOutboxRepo: repositories.effectOutboxRepo,
    attemptReceiptRepo: repositories.attemptReceiptRepo,
    taskEventRepo: repositories.taskEventRepo,
    workUnitClaimService: coordinatorServices.workUnitClaimService,
    attemptRunner: runtimeExecutionServices.attemptRunner,
    controlLoop: kernelServices.controlLoop,
    dispatchItemRepo: runtimeExecutionServices.dispatchItemRepo,
    publicationRepo: runtimeExecutionServices.publicationRepo,
    generationReplanRepo: runtimeExecutionServices.generationReplanRepo,
    retryWakeRepo: runtimeExecutionServices.retryWakeRepo,
    cancellationCoordinator: runtimeExecutionServices.cancellationCoordinator,
    executionProgressService: repositories.executionProgressService,
    verificationAndDeliveryService,
    ...(userArtifactPublication ? { userArtifactPublication } : {}),
    ...(deps.resolveUserWorkspaceRoot ? {
      resolveUserWorkspaceRoot: deps.resolveUserWorkspaceRoot,
    } : {}),
    ...(deps.spanRoutingEvaluator ? { spanRoutingEvaluator: deps.spanRoutingEvaluator } : {}),
    ...(deps.usageObserver ? { usageObserver: deps.usageObserver } : {}),
    persistenceService: conversationExecutionBinder.routedPersistenceService(),
    kernelExecutorStatusProjector: new ControlExecutorStatusProjector(
      repositories.kernelExecutorStatusRepo,
    ),
    presentation: sharedPresentation,
    workspaceStore: workspaceServices.workspaceStore,
    workspaceRepository: workspaceServices.workspaceRepository,
    resourceLeaseService: runtimeExecutionServices.resourceLeaseService,
    executionRuntime: executionServices.executionRuntime,
    kernelExecutionCallbacks: conversationExecutionBinder.routedControlCallbacks(),
    taskExecutionCallbacks: conversationExecutionBinder.routedTaskCallbacks(),
    sessionControlCallbacks: conversationExecutionBinder.routedSessionControlCallbacks(),
    conversationTaskSchedulerRepo: repositories.conversationTaskSchedulerRepo,
    ...(userArtifactPublication ? { userArtifactPublication } : {}),
  });
  conversationExecutionBinder.bindSharedServices(kernelExecutionServices);
  coordinatorServices.bindControlExecutionRuntime(kernelExecutionServices.kernelExecutionRuntime);
  const permissionService = createSqliteAccountPermissionService({
    onContinuationReady: () => {
      void accountRuntime.reviewTaskPoolOnTimer().catch(error => {
        console.error(`Permission continuation remains durable: ${(error as Error).message}`);
      });
    },
    kernelServices,
    runtimeExecutionServices,
    taskServices,
    workspaceServices,
    repositories,
    managerPermissionJudge,
    // The permission owner applies its continuation itself; nothing is queued
    // for another component to drain.
    deliverContinuation: event => kernelExecutionServices.kernelExecutionRuntime
      .submitControlEvent(event, 'permission continuation'),
  });

  const kernelCoordinator = deps.buildControlCoordinator
    ? deps.buildControlCoordinator(deps.accountId)
    : new AccountControlCoordinator({
        productionAuthorization: deps.productionAuthorization,
        kernel: kernelServices.controlLoop,
        clock: { now: () => new Date().toISOString() },
        acceptedEventTypes: ['plan_proposed', 'recovery_resolution_requested'],
        acceptedActions: ACCOUNT_KERNEL_ACCEPTED_ACTIONS,
      });
  startupRecovery = new AccountStartupRecoveryService({
    accountId: deps.accountId,
    productionAuthorization: deps.productionAuthorization,
    recoveryReplan: deps.recoveryReplan,
    recoveryPlan: deps.recoveryPlan,
    resolveConfigurationSnapshot: deps.resolveConfigurationSnapshot,
    db: deps.db,
    kernelServices,
    repositories,
    workspaceServices,
    taskServices,
    taskStateAuthority,
    coordinatorServices,
    runtimeExecutionServices,
    kernelExecutionServices,
    kernelCoordinator,
    plannerConfiguration: deps.stagedConfiguration.planner,
    get kernelConfiguration() { return deps.stagedConfiguration.kernel; },
    planningAgent: plannerServices.planningAgent,
    binder: conversationExecutionBinder,
    notifier: deps.notifier,
    verificationAndDeliveryService,
    blockedRecheckEnabled: deps.blockedRecheckEnabled !== false,
    blockedRecheckIntervalMs: deps.blockedRecheckIntervalMs ?? 60_000,
    queryUsageLifecycle: deps.queryUsageLifecycle,
    onSystemResultDelivery: deps.onSystemResultDelivery,
    appendExecutionTrace: deps.appendExecutionTrace,
  });

  workspaceServices.workspaceMergeWorker.setObserver(job => startupRecovery.observeWorkspaceMerge(job));

  const factory = new AccountRuntimeFactory({
    buildControlCoordinator: () => kernelCoordinator,
    buildControlServices: () => kernelServices,
    buildRepositories: () => repositories,
    buildWorkspaceServices: () => workspaceServices,
    buildExecutionServices: () => executionServices,
    buildPlannerServices: () => plannerServices,
    buildTaskServices: () => taskServices,
    buildCoordinatorServices: () => coordinatorServices,
    buildRuntimeExecutionServices: () => runtimeExecutionServices,
    buildPermissionService: () => permissionService,
    configurationActivationGate: deps.configurationActivationGate,
    recoverDurableStartup: deps.recoverDurableStartup
      ? () => deps.recoverDurableStartup!(deps.accountId)
      : async () => {
          await permissionService.recoverPending(true);
          await startupRecovery.recover();
        },
    reviewTaskPoolOnTimer: async (_accountId, nowMs) => {
      await permissionService.recoverPending();
      return startupRecovery.recoverPeriodic(nowMs);
    },
    onConversationActivityChanged: (_accountId, conversationId, activity) => (
      deps.onConversationActivityChanged?.(conversationId, activity)
    ),
    dispose: async () => {
      await kernelExecutionServices.kernelExecutionRuntime.dispose();
      if (deps.db.open) deps.db.close();
    },
  });
  const accountRuntime = factory.create(deps.accountId);

  return {
    accountRuntime,
    plannerServices,
    runtimePort: accountRuntime.getConversationPort(),
    conversationExecutionBinder,
    // One shared instance per account: the Conversation layer scopes calls with
    // `runWith`, so it never needs per-method proxies.
    controlExecutionServices: kernelExecutionServices,
    executionRuntime: executionServices.executionRuntime,
  };
}
