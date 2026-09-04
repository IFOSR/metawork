/**
 * 账户级 Kernel 执行 / 任务执行应用 / 会话 Kernel 运行时服务簇（ADR-0031 第 2 节）。
 *
 * 这三个服务是 AccountRuntime 持有的 runtime-wide 服务，但它们通过
 * callbacks 与 Conversation 交互。callbacks 由会话（当前为 MetaclawSession，
 * 未来为 ConversationSession）实现，工厂只依赖 callbacks 接口。
 */

import type Database from 'better-sqlite3';
import type { OrchestrationEngine } from '../guidance/orchestration.js';
import type { NotificationService } from '../notifications/types.js';
import { KernelExecutionRuntime } from '../execution/kernel-execution-runtime.js';
import { SessionTaskExecutionApplicationService } from '../session/session-task-execution-application-service.js';
import { SessionKernelRuntime } from '../session/session-kernel-runtime.js';
import { WorkspacePublicationWorker } from '../execution/workspace-publication-worker.js';
import { SubtaskHandoffRepo } from '../storage/subtask-handoff-repo.js';
import type { TaskRuntimeService } from '../task/task-runtime-service.js';
import type { AgentClassService } from '../executor/agent-class-service.js';
import type { WorkGraphRuntimeService } from '../execution/work-graph-runtime-service.js';
import type { SubtaskRepo } from '../storage/subtask-repo.js';
import type { WorkGraphRevisionRepo } from '../storage/work-graph-revision-repo.js';
import type { KernelEffectOutboxRepo } from '../storage/kernel-effect-outbox-repo.js';
import type { ExecutorAttemptReceiptRepo } from '../storage/executor-attempt-receipt-repo.js';
import type { TaskEventRepo } from '../storage/task-event-repo.js';
import type { WorkUnitClaimService } from '../execution/work-unit-claim-service.js';
import type { SubtaskAttemptRunner } from '../execution/subtask-attempt-runner.js';
import type { ControlKernel } from '../kernel/control-kernel.js';
import type { KernelWorkflowRepo } from '../storage/kernel-workflow-repo.js';
import type { KernelDispatchItemRepo } from '../storage/kernel-dispatch-item-repo.js';
import type { KernelDecisionRepo } from '../storage/kernel-decision-repo.js';
import type { WorkspacePublicationRepo } from '../storage/workspace-publication-repo.js';
import type { GenerationReplanRequestRepo } from '../storage/generation-replan-request-repo.js';
import type { TaskCancellationCoordinator } from '../execution/task-cancellation-coordinator.js';
import type { ExecutionProgressService } from '../execution/execution-progress-service.js';
import type { VerificationAndDeliveryService } from '../delivery/verification-and-delivery-service.js';
import type { UserArtifactPublicationService } from '../delivery/user-artifact-publication-service.js';
import type { SessionPersistenceService } from '../session/session-persistence-service.js';
import type { KernelExecutorStatusProjector } from '../execution/kernel-executor-status-projector.js';
import type { SessionPresentationService } from '../session/session-presentation-service.js';
import type { WorkspaceStore } from '../execution/workspace-store.js';
import type { SqliteWorkspaceRepository } from '../storage/workspace-repo.js';
import type { ResourceLeaseService } from '../execution/resource-lease-service.js';
import type { MemoryContextService } from '../memory/memory-context-service.js';
import type { ExecutionRuntime } from '../execution/execution-runtime.js';
import { HistoricalResultUpgrader } from '../execution/historical-result-upgrader.js';
import { ResultObjectRepo } from '../storage/result-object-repo.js';
import type { RuntimeConfigurationView } from '../configuration/index.js';
import type { ConversationTaskSchedulerRepo } from '../storage/conversation-task-scheduler-repo.js';

export type KernelExecutionRuntimeCallbacks = ConstructorParameters<typeof KernelExecutionRuntime>[0]['callbacks'];
export type TaskExecutionApplicationCallbacks = ConstructorParameters<typeof SessionTaskExecutionApplicationService>[0]['callbacks'];
export type SessionKernelRuntimeCallbacks = ConstructorParameters<typeof SessionKernelRuntime>[0]['callbacks'];

export interface AccountKernelExecutionServices {
  readonly kernelExecutionRuntime: KernelExecutionRuntime;
  readonly taskExecutionApplicationService: SessionTaskExecutionApplicationService;
  readonly sessionKernelRuntime: SessionKernelRuntime;
}

export function buildAccountKernelExecutionServices(deps: {
  db: Database.Database;
  sessionId: string;
  legacyCompatibility?: boolean;
  getSessionId?: () => string;
  accountId?: string;
  resultRoot: string;
  sourceRoot: string;
  orchestration: OrchestrationEngine;
  notifier: NotificationService;
  maxConcurrentAttempts: number;
  maxConcurrentAttemptsPerTask?: number;
  onTaskTerminal?: (taskId: string) => void | Promise<void>;
  getConfigurationRevision: () => string;
  getRuntimeConfiguration?: (revisionId: string) => RuntimeConfigurationView | null;
  taskRuntimeService: TaskRuntimeService;
  agentClassService: AgentClassService;
  workGraphRuntimeService: WorkGraphRuntimeService;
  subtaskRepo: SubtaskRepo;
  workGraphRevisionRepo: WorkGraphRevisionRepo;
  effectOutboxRepo: KernelEffectOutboxRepo;
  attemptReceiptRepo: ExecutorAttemptReceiptRepo;
  taskEventRepo: TaskEventRepo;
  workUnitClaimService: WorkUnitClaimService;
  attemptRunner: SubtaskAttemptRunner;
  controlKernel: ControlKernel;
  kernelWorkflowRepo: KernelWorkflowRepo;
  kernelDecisionRepo: KernelDecisionRepo;
  dispatchItemRepo: KernelDispatchItemRepo;
  publicationRepo: WorkspacePublicationRepo;
  generationReplanRepo: GenerationReplanRequestRepo;
  cancellationCoordinator: TaskCancellationCoordinator;
  executionProgressService: ExecutionProgressService;
  verificationAndDeliveryService: VerificationAndDeliveryService;
  userArtifactPublication?: UserArtifactPublicationService;
  resolveUserWorkspaceRoot?: (
    sessionId: string,
  ) => Promise<string | null> | string | null;
  persistenceService: SessionPersistenceService;
  kernelExecutorStatusProjector: KernelExecutorStatusProjector;
  presentation: SessionPresentationService;
  workspaceStore: WorkspaceStore;
  workspaceRepository: SqliteWorkspaceRepository;
  resourceLeaseService: ResourceLeaseService;
  memoryContextService: MemoryContextService;
  executionRuntime: ExecutionRuntime;
  kernelExecutionCallbacks: KernelExecutionRuntimeCallbacks;
  taskExecutionCallbacks: TaskExecutionApplicationCallbacks;
  sessionKernelCallbacks: SessionKernelRuntimeCallbacks;
  conversationTaskSchedulerRepo?: ConversationTaskSchedulerRepo;
  resolveWorkspacePath?: (taskId: string) => Promise<string | null>;
}): AccountKernelExecutionServices {
  const kernelExecutionRuntime = new KernelExecutionRuntime({
    sessionId: deps.sessionId,
    getSessionId: deps.getSessionId,
    getConfigurationRevision: deps.getConfigurationRevision,
    getRuntimeConfiguration: deps.getRuntimeConfiguration,
    orchestration: deps.orchestration,
    notifier: deps.notifier,
    taskRuntimeService: deps.taskRuntimeService,
    ...(deps.resolveWorkspacePath ? { resolveWorkspacePath: deps.resolveWorkspacePath } : {}),
    agentClassService: deps.agentClassService,
    workGraphRuntimeService: deps.workGraphRuntimeService,
    subtaskRepo: deps.subtaskRepo,
    workGraphRevisionRepo: deps.workGraphRevisionRepo,
    effectOutboxRepo: deps.effectOutboxRepo,
    attemptReceiptRepo: deps.attemptReceiptRepo,
    historicalResultUpgrader: new HistoricalResultUpgrader({
      db: deps.db,
      accountId: deps.accountId ?? 'local-default',
      resultRoot: deps.resultRoot,
    }),
    subtaskHandoffRepo: new SubtaskHandoffRepo(deps.db),
    taskEventRepo: deps.taskEventRepo,
    workUnitClaimService: deps.workUnitClaimService,
    attemptRunner: deps.attemptRunner,
    controlKernel: deps.controlKernel,
    kernelWorkflowStore: deps.kernelWorkflowRepo,
    kernelDecisionRepo: deps.kernelDecisionRepo,
    dispatchItemRepo: deps.dispatchItemRepo,
    maxConcurrentAttempts: deps.maxConcurrentAttempts,
    maxConcurrentAttemptsPerTask: deps.maxConcurrentAttemptsPerTask,
    conversationTaskSchedulerRepo: deps.conversationTaskSchedulerRepo,
    onTaskTerminal: deps.onTaskTerminal,
    publicationWorker: new WorkspacePublicationWorker({
      db: deps.db,
      sessionId: deps.sessionId,
      getSessionId: deps.getSessionId,
      accountId: deps.accountId,
      resultRoot: deps.resultRoot,
      sourceRoot: deps.sourceRoot,
      workspaceStore: deps.workspaceStore,
      workspaceRepository: deps.workspaceRepository,
      subtaskRepo: deps.subtaskRepo,
      attemptReceiptRepo: deps.attemptReceiptRepo,
      resourceLeaseService: deps.resourceLeaseService,
      dispatchItemRepo: deps.dispatchItemRepo,
      taskRuntimeService: deps.taskRuntimeService,
      userArtifactPublication: deps.userArtifactPublication,
      resolveUserWorkspaceRoot: deps.resolveUserWorkspaceRoot,
    }),
    publicationRepo: deps.publicationRepo,
    resultObjectRepo: new ResultObjectRepo(deps.db, deps.resultRoot),
    workspaceRepository: deps.workspaceRepository,
    generationReplanRepo: deps.generationReplanRepo,
    cancellationCoordinator: deps.cancellationCoordinator,
    executionProgressService: deps.executionProgressService,
    verificationAndDeliveryService: deps.verificationAndDeliveryService,
    persistenceService: deps.persistenceService,
    kernelExecutorStatusProjector: deps.kernelExecutorStatusProjector,
    presentation: deps.presentation,
    callbacks: deps.kernelExecutionCallbacks,
  });

  const taskExecutionApplicationService = new SessionTaskExecutionApplicationService({
    taskRuntimeService: deps.taskRuntimeService,
    kernelExecutionRuntime,
    presentation: deps.presentation,
    callbacks: deps.taskExecutionCallbacks,
  });

  const sessionKernelRuntime = new SessionKernelRuntime({
    sessionId: deps.sessionId,
    legacyCompatibility: deps.legacyCompatibility,
    accountId: deps.accountId,
    taskRuntimeService: deps.taskRuntimeService,
    memoryContextService: deps.memoryContextService,
    orchestration: deps.orchestration,
    activeExecutions: deps.executionRuntime,
    presentation: deps.presentation,
    callbacks: deps.sessionKernelCallbacks,
    conversationTaskSchedulerRepo: deps.conversationTaskSchedulerRepo,
  });

  return { kernelExecutionRuntime, taskExecutionApplicationService, sessionKernelRuntime };
}
