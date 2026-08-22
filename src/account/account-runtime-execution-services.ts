/**
 * 账户级运行时执行服务簇（ADR-0031 第 2 节）。
 *
 * resourceLeaseService、dispatchItemRepo、publicationRepo、generationReplanRepo、
 * cancellationCoordinator 与 attemptRunner 都是纯 runtime-wide 服务（无
 * conversation callback），按账户构造一次。
 */

import type Database from 'better-sqlite3';
import { ResourceLeaseService } from '../execution/resource-lease-service.js';
import { SqliteResourceLeaseRepository } from '../storage/resource-lease-repo.js';
import { KernelDispatchItemRepo } from '../storage/kernel-dispatch-item-repo.js';
import { WorkspacePublicationRepo } from '../storage/workspace-publication-repo.js';
import { GenerationReplanRequestRepo } from '../storage/generation-replan-request-repo.js';
import { TaskCancellationCoordinator } from '../execution/task-cancellation-coordinator.js';
import { SubtaskAttemptRunner } from '../execution/subtask-attempt-runner.js';
import type { TaskRuntimeService } from '../task/task-runtime-service.js';
import type { SubtaskRepo } from '../storage/subtask-repo.js';
import type { TaskEventRepo } from '../storage/task-event-repo.js';
import type { WorkGraphRevisionRepo } from '../storage/work-graph-revision-repo.js';
import type { WorkUnitClaimService } from '../execution/work-unit-claim-service.js';
import type { ExecutionRuntime } from '../execution/execution-runtime.js';
import type { AgentClassService } from '../executor/agent-class-service.js';
import type { WorkspaceStore } from '../execution/workspace-store.js';
import type { AttemptExecutionBackend } from '../execution/attempt-execution-backend.js';
import type { SqlitePermissionRepository } from '../storage/permission-repo.js';
import type { KernelWorkflowRepo } from '../storage/kernel-workflow-repo.js';
import type { SqliteWorkspaceRepository } from '../storage/workspace-repo.js';
import type { SqliteAttemptExecutionRepository } from '../storage/attempt-execution-backend-repo.js';

export interface AccountRuntimeExecutionServices {
  readonly resourceLeaseService: ResourceLeaseService;
  readonly dispatchItemRepo: KernelDispatchItemRepo;
  readonly publicationRepo: WorkspacePublicationRepo;
  readonly generationReplanRepo: GenerationReplanRequestRepo;
  readonly cancellationCoordinator: TaskCancellationCoordinator;
  readonly attemptRunner: SubtaskAttemptRunner;
}

export function buildAccountRuntimeExecutionServices(deps: {
  db: Database.Database;
  sessionId: string;
  getSessionId?: () => string;
  sourceRoot: string;
  taskRuntimeService: TaskRuntimeService;
  subtaskRepo: SubtaskRepo;
  taskEventRepo: TaskEventRepo;
  workGraphRevisionRepo: WorkGraphRevisionRepo;
  workUnitClaimService: WorkUnitClaimService;
  executionRuntime: ExecutionRuntime;
  agentClassService: AgentClassService;
  workspaceStore: WorkspaceStore;
  attemptExecutionBackend: AttemptExecutionBackend;
  permissionRepository: SqlitePermissionRepository;
  kernelWorkflowRepo: KernelWorkflowRepo;
  workspaceRepository: SqliteWorkspaceRepository;
  attemptExecutionRepository: SqliteAttemptExecutionRepository;
  accountId?: string;
  resultRoot: string;
}): AccountRuntimeExecutionServices {
  const resourceLeaseService = new ResourceLeaseService(new SqliteResourceLeaseRepository(deps.db));
  const dispatchItemRepo = new KernelDispatchItemRepo(deps.db);
  const publicationRepo = new WorkspacePublicationRepo(deps.db);
  const generationReplanRepo = new GenerationReplanRequestRepo(deps.db);

  const cancellationCoordinator = new TaskCancellationCoordinator({
    db: deps.db,
    taskRuntimeService: deps.taskRuntimeService,
    subtaskRepo: deps.subtaskRepo,
    taskEventRepo: deps.taskEventRepo,
    workGraphRevisionRepo: deps.workGraphRevisionRepo,
    dispatchItemRepo,
    publicationRepo,
    generationReplanRepo,
    resourceLeaseService,
    workUnitClaimService: deps.workUnitClaimService,
    activeExecutions: deps.executionRuntime,
    attemptExecutionBackend: deps.attemptExecutionBackend,
    attemptExecutionRepository: deps.attemptExecutionRepository,
  });

  const attemptRunner = new SubtaskAttemptRunner({
    db: deps.db,
    sessionId: deps.sessionId,
    getSessionId: deps.getSessionId,
    taskRuntimeService: deps.taskRuntimeService,
    subtaskRepo: deps.subtaskRepo,
    workUnitClaimService: deps.workUnitClaimService,
    executionRuntime: deps.executionRuntime,
    agentClassService: deps.agentClassService,
    workspaceStore: deps.workspaceStore,
    attemptExecutionBackend: deps.attemptExecutionBackend,
    resourceLeaseService,
    permissionRepository: deps.permissionRepository,
    kernelWorkflowStore: deps.kernelWorkflowRepo,
    workspaceRepository: deps.workspaceRepository,
    sourceRoot: deps.sourceRoot,
    controlNetwork: process.env.METACLAW_CONTROL_NETWORK ?? 'metaclaw-control',
    accountId: deps.accountId,
    resultRoot: deps.resultRoot,
  });

  return {
    resourceLeaseService,
    dispatchItemRepo,
    publicationRepo,
    generationReplanRepo,
    cancellationCoordinator,
    attemptRunner,
  };
}
