/**
 * AccountRuntime 组合辅助（ADR-0031 第 2、12 节）。
 *
 * 组合根专用：从安装全局依赖 + 配置构造账户的 8 个 runtime-wide 服务簇，
 * 再通过 AccountRuntimeFactory 组装 AccountRuntime。会话级 callbacks 与
 * kernelExecutionServices 由 ConversationSession 通过端口自行构造。
 */

import type Database from 'better-sqlite3';
import type { TaskEngine } from '../task/task-engine.js';
import type { MemoryEngine } from '../memory/memory-engine.js';
import type { OrchestrationEngine } from '../guidance/orchestration.js';
import type { ContextRecaller } from '../memory/context-recaller.js';
import type { NotificationService } from '../notifications/types.js';
import type { StagedLegacyConfiguration } from '../configuration/staged-legacy-configuration.js';
import type { RuntimePrivateConfigurationBinding } from '../configuration/index.js';
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import type { RevisionedAgentBinding } from '../core/authorized-executor-binding.js';
import type { PlanningAgent } from '../planning/planning-agent.js';
import type { PlannerProcessController } from '../planning/planner-process-supervisor.js';
import type { AttemptExecutionBackend } from '../execution/attempt-execution-backend.js';
import type { ProbeCommandRunner } from '../executor/harness-driver.js';
import { buildAccountKernelServices } from './account-kernel-services.js';
import { buildAccountRepositories } from './account-repositories.js';
import { buildAccountWorkspaceServices } from './account-workspace-services.js';
import { buildAccountTaskServices } from './account-task-services.js';
import { buildAccountExecutionServices } from './account-execution-services.js';
import { buildAccountCoordinatorServices } from './account-coordinator-services.js';
import { buildAccountRuntimeExecutionServices } from './account-runtime-execution-services.js';
import { buildAccountPlannerServices } from './account-planner-services.js';
import { AccountKernelCoordinator } from './account-kernel-coordinator.js';
import { AccountRuntimeFactory } from './account-runtime-factory.js';
import { AccountRuntime } from './account-runtime.js';
import type { ConversationRuntimePort } from './account-runtime-ports.js';
import type { AccountConversationExecutionBinder } from './account-conversation-execution-binder.js';
import type { ExecutionRuntime } from '../execution/execution-runtime.js';
import { buildAccountKernelExecutionServices } from './account-kernel-execution-services.js';
import {
  createAccountConversationExecutionBinder,
} from './account-conversation-execution-binder.js';
import { SessionPersistenceService } from '../session/session-persistence-service.js';
import { SessionPresentationService } from '../session/session-presentation-service.js';
import { KernelExecutorStatusProjector } from '../execution/kernel-executor-status-projector.js';
import { VerificationAndDeliveryService } from '../delivery/verification-and-delivery-service.js';
import { createSqliteAccountPermissionService } from './sqlite-account-permission-service.js';
import { AccountStartupRecoveryService } from './account-startup-recovery-service.js';
import type { ConfigurationActivationGate } from '../configuration/configuration-activation-gate.js';

export interface AccountRuntimeComposition {
  readonly accountRuntime: AccountRuntime;
  readonly runtimePort: ConversationRuntimePort;
  readonly conversationExecutionBinder: AccountConversationExecutionBinder;
  readonly executionRuntime: ExecutionRuntime;
}

export function buildAccountRuntimeComposition(deps: {
  accountId: string;
  db: Database.Database;
  taskEngine: TaskEngine;
  memoryEngine: MemoryEngine;
  orchestration: OrchestrationEngine;
  contextRecaller: ContextRecaller;
  notifier: NotificationService;
  workspaceRoot: string;
  attemptsRoot: string;
  resultsRoot: string;
  generatedRuntimeRoot: string;
  sourceRoot: string;
  sessionId: string;
  stagedConfiguration: StagedLegacyConfiguration;
  plannerBinding: RevisionedAgentBinding;
  plannerBindingFingerprint: string;
  getPlannerBinding?: Parameters<typeof buildAccountPlannerServices>[0]['getPlannerBinding'];
  getRuntimeBinding(
    binding: AuthorizedExecutorBinding,
  ): Promise<RuntimePrivateConfigurationBinding> | RuntimePrivateConfigurationBinding;
  getRuntimeConfiguration?: Parameters<typeof buildAccountExecutionServices>[0]['getRuntimeConfiguration'];
  getActiveRuntimeConfiguration?: Parameters<typeof buildAccountExecutionServices>[0]['getActiveRuntimeConfiguration'];
  probeCommand?: ProbeCommandRunner;
  attemptExecutionBackend?: AttemptExecutionBackend;
  plannerSupervisor?: PlannerProcessController;
  planningAgent?: PlanningAgent;
  getConfigurationRevision(): string;
  blockedRecheckEnabled?: boolean;
  blockedRecheckIntervalMs?: number;
  buildKernelCoordinator?(accountId: string): AccountKernelCoordinator;
  recoverDurableStartup?(accountId: string): Promise<void>;
  configurationActivationGate?: ConfigurationActivationGate;
}): AccountRuntimeComposition {
  const kernelServices = buildAccountKernelServices(deps.db);
  const repositories = buildAccountRepositories(deps.db);
  const workspaceServices = buildAccountWorkspaceServices(deps.db, deps.workspaceRoot);
  const conversationExecutionBinder = createAccountConversationExecutionBinder();
  const taskServices = buildAccountTaskServices({
    taskEngine: deps.taskEngine,
    agentClasses: deps.stagedConfiguration.snapshot.config.agentClasses,
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
  const runtimeExecutionServices = buildAccountRuntimeExecutionServices({
    db: deps.db,
    sessionId: deps.sessionId,
    getSessionId: () => conversationExecutionBinder.currentSessionId() ?? deps.sessionId,
    accountId: deps.accountId,
    resultRoot: deps.resultsRoot,
    sourceRoot: deps.sourceRoot,
    taskRuntimeService: taskServices.taskRuntimeService,
    subtaskRepo: repositories.subtaskRepo,
    taskEventRepo: repositories.taskEventRepo,
    workGraphRevisionRepo: repositories.workGraphRevisionRepo,
    workUnitClaimService: coordinatorServices.workUnitClaimService,
    executionRuntime: executionServices.executionRuntime,
    agentClassService: taskServices.agentClassService,
    workspaceStore: workspaceServices.workspaceStore,
    attemptExecutionBackend: taskServices.attemptExecutionBackend,
    permissionRepository: workspaceServices.permissionRepository,
    kernelWorkflowRepo: kernelServices.kernelWorkflowRepo,
    workspaceRepository: workspaceServices.workspaceRepository,
    attemptExecutionRepository: workspaceServices.attemptExecutionRepository,
  });
  const plannerModel = deps.stagedConfiguration.snapshot.config.models[
    deps.plannerBinding.modelRef
  ];
  if (!plannerModel) {
    throw new Error(`Planner Model is unavailable: ${deps.plannerBinding.modelRef}`);
  }
  const plannerServices = buildAccountPlannerServices({
    db: deps.db,
    memoryEngine: deps.memoryEngine,
    contextRecaller: deps.contextRecaller,
    plannerBinding: deps.plannerBinding,
    plannerBindingFingerprint: deps.plannerBindingFingerprint,
    plannerModelId: plannerModel.modelId,
    getPlannerBinding: deps.getPlannerBinding,
    plannerSupervisor: deps.plannerSupervisor,
    planningAgent: deps.planningAgent,
  });
  const sharedPresentation = new SessionPresentationService();
  const verificationAndDeliveryService = new VerificationAndDeliveryService();
  const kernelExecutionServices = buildAccountKernelExecutionServices({
    db: deps.db,
    sessionId: deps.sessionId,
    getSessionId: () => conversationExecutionBinder.currentSessionId() ?? deps.sessionId,
    accountId: deps.accountId,
    resultRoot: deps.resultsRoot,
    sourceRoot: deps.sourceRoot,
    orchestration: deps.orchestration,
    notifier: deps.notifier,
    maxConcurrentAttempts: deps.stagedConfiguration.snapshot.config.runtimePolicy.maxConcurrentAttempts
      ?? 4,
    getConfigurationRevision: deps.getConfigurationRevision,
    taskRuntimeService: taskServices.taskRuntimeService,
    agentClassService: taskServices.agentClassService,
    workGraphRuntimeService: repositories.workGraphRuntimeService,
    subtaskRepo: repositories.subtaskRepo,
    workGraphRevisionRepo: repositories.workGraphRevisionRepo,
    effectOutboxRepo: repositories.effectOutboxRepo,
    attemptReceiptRepo: repositories.attemptReceiptRepo,
    taskEventRepo: repositories.taskEventRepo,
    workUnitClaimService: coordinatorServices.workUnitClaimService,
    attemptRunner: runtimeExecutionServices.attemptRunner,
    controlKernel: kernelServices.controlKernel,
    kernelWorkflowRepo: kernelServices.kernelWorkflowRepo,
    kernelDecisionRepo: kernelServices.kernelDecisionRepo,
    dispatchItemRepo: runtimeExecutionServices.dispatchItemRepo,
    publicationRepo: runtimeExecutionServices.publicationRepo,
    generationReplanRepo: runtimeExecutionServices.generationReplanRepo,
    cancellationCoordinator: runtimeExecutionServices.cancellationCoordinator,
    executionProgressService: repositories.executionProgressService,
    verificationAndDeliveryService,
    persistenceService: conversationExecutionBinder.routedPersistenceService(),
    kernelExecutorStatusProjector: new KernelExecutorStatusProjector(
      repositories.kernelExecutorStatusRepo,
    ),
    presentation: sharedPresentation,
    workspaceStore: workspaceServices.workspaceStore,
    workspaceRepository: workspaceServices.workspaceRepository,
    resourceLeaseService: runtimeExecutionServices.resourceLeaseService,
    memoryContextService: plannerServices.memoryContextService,
    executionRuntime: executionServices.executionRuntime,
    kernelExecutionCallbacks: conversationExecutionBinder.routedKernelCallbacks(),
    taskExecutionCallbacks: conversationExecutionBinder.routedTaskCallbacks(),
    sessionKernelCallbacks: conversationExecutionBinder.routedSessionKernelCallbacks(),
  });
  conversationExecutionBinder.bindSharedServices(kernelExecutionServices);
  coordinatorServices.bindKernelExecutionRuntime(kernelExecutionServices.kernelExecutionRuntime);
  const permissionService = createSqliteAccountPermissionService({
    kernelServices,
    runtimeExecutionServices,
    taskServices,
    workspaceServices,
    repositories,
  });

  const kernelCoordinator = deps.buildKernelCoordinator
    ? deps.buildKernelCoordinator(deps.accountId)
    : new AccountKernelCoordinator({
        kernel: kernelServices.controlKernel,
        store: kernelServices.kernelWorkflowRepo,
        clock: { now: () => new Date().toISOString() },
        acceptedEventTypes: ['plan_proposed', 'recovery_resolution_requested'],
        acceptedActions: [
          'reject_request',
          'request_clarification',
          'deliver_direct_reply',
          'no_op',
          'authorize_task_plan',
          'authorize_task_control',
          'block_work',
          'park_for_replan',
          'resolve_recovery',
        ],
      });
  const startupRecovery = new AccountStartupRecoveryService({
    db: deps.db,
    kernelServices,
    repositories,
    workspaceServices,
    taskServices,
    coordinatorServices,
    runtimeExecutionServices,
    kernelExecutionServices,
    kernelCoordinator,
    plannerConfiguration: deps.stagedConfiguration.planner,
    kernelConfiguration: deps.stagedConfiguration.kernel,
    binder: conversationExecutionBinder,
    notifier: deps.notifier,
    verificationAndDeliveryService,
    blockedRecheckEnabled: deps.blockedRecheckEnabled !== false,
    blockedRecheckIntervalMs: deps.blockedRecheckIntervalMs ?? 60_000,
  });

  const factory = new AccountRuntimeFactory({
    buildKernelCoordinator: () => kernelCoordinator,
    buildKernelServices: () => kernelServices,
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
      : () => startupRecovery.recover(),
    reviewTaskPoolOnTimer: (_accountId, nowMs) => startupRecovery.recoverPeriodic(nowMs),
    dispose: async () => {
      await kernelExecutionServices.kernelExecutionRuntime.dispose();
      if (deps.db.open) deps.db.close();
    },
  });
  const accountRuntime = factory.create(deps.accountId);

  return {
    accountRuntime,
    runtimePort: accountRuntime.getConversationPort(),
    conversationExecutionBinder,
    executionRuntime: executionServices.executionRuntime,
  };
}
