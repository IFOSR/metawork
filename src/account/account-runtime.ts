/**
 * AccountRuntime（ADR-0031 第 2 节）。
 *
 * 一个账户的单一运行时协调者。它拥有账户级 durable recovery 与 Kernel 单写
 * 协调器。startup recovery 在账户激活时只运行一次，而非每次连接或每个
 * Conversation 各跑一次。
 *
 * 生命周期：attachClient/detachClient 跟踪已连接客户端，setActiveWork 跟踪
 * 活动工作；closeWhenIdle 仅在无客户端且无活动工作时 dispose 一次。
 */

import type { AccountKernelCoordinator } from './account-kernel-coordinator.js';
import type { AccountKernelServices } from './account-kernel-services.js';
import type { AccountRepositories } from './account-repositories.js';
import type { AccountWorkspaceServices } from './account-workspace-services.js';
import type { AccountExecutionServices } from './account-execution-services.js';
import type { AccountTaskServices } from './account-task-services.js';
import type { AccountCoordinatorServices } from './account-coordinator-services.js';
import type { AccountRuntimeExecutionServices } from './account-runtime-execution-services.js';
import type { AccountPlannerServices } from './account-planner-services.js';
import type { AccountPermissionService } from './account-permission-service.js';
import type { AccountRuntimeHandle, ConversationRuntimePort } from './account-runtime-ports.js';

export interface AccountRuntimeDeps {
  readonly accountId: string;
  readonly kernelCoordinator: AccountKernelCoordinator;
  readonly kernelServices: AccountKernelServices;
  readonly repositories: AccountRepositories;
  readonly workspaceServices: AccountWorkspaceServices;
  readonly executionServices?: AccountExecutionServices;
  readonly taskServices?: AccountTaskServices;
  readonly coordinatorServices?: AccountCoordinatorServices;
  readonly runtimeExecutionServices?: AccountRuntimeExecutionServices;
  readonly plannerServices?: AccountPlannerServices;
  readonly permissionService?: AccountPermissionService;
  readonly recoverDurableStartup: () => Promise<void>;
  readonly reviewTaskPoolOnTimer?: (nowMs: number) => Promise<boolean>;
  readonly dispose?: () => Promise<void>;
}

export class AccountRuntime implements AccountRuntimeHandle {
  private initialized = false;
  private initialization: Promise<void> | null = null;
  private disposed = false;
  private closing: Promise<void> | null = null;
  private attachedClients = 0;
  private activeWorkCount = 0;
  private periodicReview: Promise<boolean> | null = null;

  constructor(private readonly deps: AccountRuntimeDeps) {}

  get accountId(): string {
    return this.deps.accountId;
  }

  get kernelCoordinator(): AccountKernelCoordinator {
    return this.deps.kernelCoordinator;
  }

  get kernelServices(): AccountKernelServices {
    return this.deps.kernelServices;
  }

  get repositories(): AccountRepositories {
    return this.deps.repositories;
  }

  get workspaceServices(): AccountWorkspaceServices {
    return this.deps.workspaceServices;
  }

  get executionServices(): AccountExecutionServices | undefined {
    return this.deps.executionServices;
  }

  get taskServices(): AccountTaskServices | undefined {
    return this.deps.taskServices;
  }

  get coordinatorServices(): AccountCoordinatorServices | undefined {
    return this.deps.coordinatorServices;
  }

  get runtimeExecutionServices(): AccountRuntimeExecutionServices | undefined {
    return this.deps.runtimeExecutionServices;
  }

  get plannerServices(): AccountPlannerServices | undefined {
    return this.deps.plannerServices;
  }

  get permissionService(): AccountPermissionService | undefined {
    return this.deps.permissionService;
  }

  /** 单飞行、幂等的账户激活恢复。 */
  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initialization) return this.initialization;
    this.initialization = Promise.resolve()
      .then(() => this.deps.recoverDurableStartup())
      .then(() => {
        this.initialized = true;
      })
      .catch(error => {
        this.initialization = null;
        throw error;
      });
    return this.initialization;
  }

  attachClient(): void {
    if (this.disposed) throw new Error(`AccountRuntime is closed: ${this.accountId}`);
    if (this.closing) throw new Error(`AccountRuntime is closing: ${this.accountId}`);
    this.attachedClients += 1;
  }

  detachClient(): void {
    this.attachedClients = Math.max(0, this.attachedClients - 1);
  }

  beginWork(): void {
    if (this.disposed) throw new Error(`AccountRuntime is closed: ${this.accountId}`);
    if (this.closing) throw new Error(`AccountRuntime is closing: ${this.accountId}`);
    this.activeWorkCount += 1;
  }

  endWork(): void {
    this.activeWorkCount = Math.max(0, this.activeWorkCount - 1);
  }

  isBusy(): boolean {
    return this.attachedClients > 0 || this.activeWorkCount > 0;
  }

  reviewTaskPoolOnTimer(nowMs = Date.now()): Promise<boolean> {
    if (this.disposed || this.closing) return Promise.resolve(false);
    if (this.periodicReview) return this.periodicReview;
    const operation = this.deps.reviewTaskPoolOnTimer?.(nowMs) ?? Promise.resolve(false);
    const review = operation.finally(() => {
      if (this.periodicReview === review) this.periodicReview = null;
    });
    this.periodicReview = review;
    return review;
  }

  async closeWhenIdle(): Promise<'closed' | 'busy'> {
    if (this.isBusy()) return 'busy';
    if (this.disposed) return 'closed';
    this.closing ??= Promise.resolve()
      .then(async () => {
        if (this.periodicReview) await this.periodicReview;
      })
      .then(() => (this.deps.dispose ?? (async () => undefined))())
      .then(() => {
        this.disposed = true;
      })
      .catch(error => {
        this.closing = null;
        throw error;
      });
    await this.closing;
    return 'closed';
  }

  getConversationPort(): ConversationRuntimePort {
    const taskRuntimeService = this.deps.taskServices?.taskRuntimeService;
    const coordinator = this.deps.coordinatorServices;
    return {
      accountId: this.accountId,
      planning: this.deps.plannerServices?.planningAgent ?? null,
      permissions: this.deps.permissionService ?? null,
      queries: {
        findTask: taskId => taskRuntimeService?.findTask(taskId) ?? null,
        listTasks: () => taskRuntimeService?.listTasks() ?? [],
        listTasksByStatus: status => taskRuntimeService?.listTasksByStatus(status) ?? [],
        listSubtasks: taskId => this.deps.repositories.subtaskRepo.listByTask(taskId),
        findSubtask: subtaskId => this.deps.repositories.subtaskRepo.findById(subtaskId),
        findKernelEvent: eventId => this.deps.kernelServices.kernelWorkflowRepo.findEvent(eventId),
        findKernelApplicationByDecisionId: decisionId => (
          this.deps.kernelServices.kernelWorkflowRepo.findApplicationByDecisionId(decisionId)
        ),
        listKernelDecisionsBySession: sessionId => (
          this.deps.kernelServices.kernelDecisionRepo.listBySession(sessionId)
        ),
        listKernelDecisionsByTask: taskId => (
          this.deps.kernelServices.kernelDecisionRepo.listByTask(taskId)
        ),
        listCurrentKernelDecisions: action => (
          this.deps.kernelServices.kernelDecisionRepo.listCurrentByAction(action)
        ),
        listExecutorStatuses: configurationRevision => (
          this.deps.repositories.kernelExecutorStatusRepo.list(configurationRevision)
        ),
        listWorkGraphTaskIds: () => this.deps.repositories.subtaskRepo.listTaskIds(),
        findOldestPendingPermission: () => (
          this.deps.workspaceServices.permissionRepository.findOldestPending()
        ),
        listIntegratedPublications: taskIds => (
          this.deps.runtimeExecutionServices?.publicationRepo.listIntegratedByTaskIds(taskIds) ?? []
        ),
        listRecoveryApplications: taskId => (
          this.deps.kernelServices.kernelWorkflowRepo.listRecoveryItems(taskId)
        ),
        findRecoveryApplication: recoveryItemId => (
          this.deps.kernelServices.kernelWorkflowRepo.findRecoveryItem(recoveryItemId)
        ),
        listRecoveryEffects: taskId => (
          this.deps.repositories.effectOutboxRepo.listRecoveryItems(taskId)
        ),
        findRecoveryEffect: recoveryItemId => (
          this.deps.repositories.effectOutboxRepo.find(recoveryItemId)
        ),
        findActiveWorkGraphRevision: taskId => (
          this.deps.repositories.workGraphRevisionRepo.findActive(taskId)
        ),
        listTaskEvidence: (taskId, generationId) => (
          this.deps.repositories.taskExecutionEvidenceRepo
            .listTaskEvidenceByGeneration(taskId, generationId)
        ),
        listAttemptReceipts: taskId => (
          this.deps.repositories.attemptReceiptRepo.listByTask(taskId)
        ),
      },
      commands: {
        submitKernel: this.deps.kernelCoordinator.submit.bind(this.deps.kernelCoordinator),
        materializeCompletedEvidence: (taskId, revision) => {
          this.deps.repositories.workGraphRuntimeService
            .materializeCompletedEvidence(taskId, revision);
        },
        resolveRecoveryApplication: (recoveryItemId, resolution, now) => {
          this.deps.kernelServices.kernelWorkflowRepo.resolveRecoveryItem(
            recoveryItemId,
            resolution,
            now,
          );
        },
        resolveRecoveryEffect: (recoveryItemId, resolution, now) => {
          this.deps.repositories.effectOutboxRepo.resolve(recoveryItemId, resolution, now);
        },
        refreshExecutors: input => {
          if (!coordinator) throw new Error('Executor recovery service is unavailable');
          return coordinator.executorRecoveryRefreshService.refresh(input);
        },
      },
      execution: this.deps.executionServices && this.deps.taskServices
        ? {
            activeExecutions: this.deps.executionServices.executionRuntime,
            listExecutorAgentClassNames: () => (
              this.deps.taskServices!.agentClassService.listExecutorAgentClassNames()
            ),
          }
        : null,
    };
  }
}
