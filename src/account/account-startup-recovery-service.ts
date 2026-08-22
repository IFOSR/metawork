import type Database from 'better-sqlite3';
import { AttemptExecutionBackendReconciler } from '../execution/attempt-execution-backend-reconciler.js';
import type { VerificationAndDeliveryService } from '../delivery/verification-and-delivery-service.js';
import type { TaskCompletionDeliveryInput } from '../delivery/verification-and-delivery-service.js';
import type { NotificationService } from '../notifications/types.js';
import { SessionPersistenceService } from '../session/session-persistence-service.js';
import { SessionPresentationService } from '../session/session-presentation-service.js';
import type { KernelEvent } from '../kernel/control-kernel.js';
import type { KernelDecision, KernelSnapshot } from '../kernel/control-kernel.js';
import type {
  KernelConfigurationView,
  PlannerConfigurationView,
} from '../configuration/types.js';
import type { KernelDispatchItemRecord } from '../storage/kernel-dispatch-item-repo.js';
import type { AccountConversationExecutionBinder, ConversationExecutionBinding } from './account-conversation-execution-binder.js';
import type { AccountKernelExecutionServices } from './account-kernel-execution-services.js';
import type { AccountKernelServices } from './account-kernel-services.js';
import type { AccountRepositories } from './account-repositories.js';
import type { AccountRuntimeExecutionServices } from './account-runtime-execution-services.js';
import type { AccountTaskServices } from './account-task-services.js';
import type { AccountWorkspaceServices } from './account-workspace-services.js';
import type { AccountCoordinatorServices } from './account-coordinator-services.js';
import type { AccountKernelCoordinator } from './account-kernel-coordinator.js';
import { buildEligibleContextRefKeys } from '../work-graph/index.js';

export class AccountStartupRecoveryService {
  private lastBlockedRecheckAt: number | null = null;

  constructor(private readonly deps: {
    readonly db: Database.Database;
    readonly kernelServices: AccountKernelServices;
    readonly repositories: AccountRepositories;
    readonly workspaceServices: AccountWorkspaceServices;
    readonly taskServices: AccountTaskServices;
    readonly coordinatorServices: AccountCoordinatorServices;
    readonly runtimeExecutionServices: AccountRuntimeExecutionServices;
    readonly kernelExecutionServices: AccountKernelExecutionServices;
    readonly kernelCoordinator: AccountKernelCoordinator;
    readonly plannerConfiguration: PlannerConfigurationView;
    readonly kernelConfiguration: KernelConfigurationView;
    readonly binder: AccountConversationExecutionBinder;
    readonly notifier: NotificationService;
    readonly verificationAndDeliveryService: VerificationAndDeliveryService;
    readonly blockedRecheckEnabled: boolean;
    readonly blockedRecheckIntervalMs: number;
  }) {}

  async recover(): Promise<void> {
    const now = new Date().toISOString();
    const backendLossAttemptIds = new Set<string>();
    const claimedOrphans = this.deps.coordinatorServices.workUnitClaimService.listOrphanedClaims();
    const dispatchItems = this.deps.runtimeExecutionServices.dispatchItemRepo;
    const runningTasks = this.deps.taskServices.taskRuntimeService.listTasksByStatus('running');
    const requiresAttemptReconciliation = claimedOrphans.length > 0
      || this.deps.workspaceServices.attemptExecutionRepository.listActive().length > 0
      || runningTasks.some(task => dispatchItems.listByTask(task.id).some(item =>
        ['launching', 'running', 'cancelling', 'uncertain'].includes(item.status)
      ));

    if (requiresAttemptReconciliation) {
      const checkpointIds = new Map<string, string | null>();
      const reconciliation = await new AttemptExecutionBackendReconciler(
        this.deps.taskServices.attemptExecutionBackend,
        this.deps.workspaceServices.attemptExecutionRepository,
      ).reconcile({
        checkpoint: async record => {
          const persisted = this.deps.workspaceServices.workspaceRepository.find(record.workspaceId);
          if (!persisted) {
            checkpointIds.set(record.attemptId, null);
            return;
          }
          const workspace = await this.deps.workspaceServices.workspaceStore.ensureWorkspace({
            taskId: persisted.taskId,
            generationId: persisted.generationId,
            subtaskId: persisted.subtaskId,
          }, persisted.kind);
          const checkpoint = await this.deps.workspaceServices.workspaceStore.createCheckpoint(
            workspace,
            { reason: 'failure', attemptId: record.attemptId, now },
          );
          this.deps.workspaceServices.workspaceRepository.recordCheckpoint({
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
        const dispatch = dispatchItems.find(record.attemptId);
        if (!dispatch) {
          throw new Error(`startup recovery found attempt without authorized dispatch: ${record.attemptId}`);
        }
        if (['cancelling', 'cancelled'].includes(dispatch.status)) continue;
        dispatchItems.markUncertain(
          record.attemptId,
          `execution backend ${record.containerId} was reconciled during startup`,
          now,
        );
        this.deps.kernelServices.kernelWorkflowRepo.enqueue({
          schemaVersion: 5,
          configurationRevision: dispatch.configurationRevision,
          type: 'sandbox_lost',
          id: `sandbox_lost_${record.attemptId}`,
          correlationId: record.taskId,
          causationId: record.attemptId,
          occurredAt: now,
          sessionId: this.originForDispatch(dispatch.decisionId),
          taskId: record.taskId,
          subtaskId: record.subtaskId,
          attemptId: record.attemptId,
          containerId: record.containerId,
          workspaceId: record.workspaceId,
          checkpointId: checkpointIds.get(record.attemptId) ?? null,
          authorizedBinding: dispatch.authorizedBinding,
          bindingFingerprint: dispatch.bindingFingerprint,
          attemptKind: dispatch.attemptKind,
          sourceAttemptId: dispatch.sourceAttemptId,
          recoveryMode: dispatch.recoveryMode,
        });
      }
    }

    await this.deps.runtimeExecutionServices.cancellationCoordinator.recover();
    this.deps.repositories.effectOutboxRepo.reconcileSending(now);
    this.deps.kernelServices.kernelWorkflowRepo.reconcileProcessing();
    await this.deliverPendingEffects(now);
    await this.recoverKernelCoordinator();

    for (const task of runningTasks) {
      const taskClaims = claimedOrphans.filter(item => item.claimedTaskId === task.id);
      for (const workUnit of taskClaims) {
        if (!workUnit.claimedSubtaskId || !workUnit.claimedAttemptId) continue;
        const dispatch = dispatchItems.find(workUnit.claimedAttemptId);
        if (!dispatch) {
          throw new Error(`startup orphan has no authorized dispatch identity: ${workUnit.claimedAttemptId}`);
        }
        const sessionId = this.originForDispatch(dispatch.decisionId);
        await this.withSystemBinding(sessionId, async () => {
          if (!backendLossAttemptIds.has(workUnit.claimedAttemptId!)) {
            this.deps.runtimeExecutionServices.attemptRunner.landHeartbeatLost({
              attemptId: workUnit.claimedAttemptId!,
              executionId: `startup_${workUnit.claimedAttemptId}`,
              taskId: task.id,
              subtaskId: workUnit.claimedSubtaskId!,
              workUnitId: workUnit.id,
              authorizedBinding: dispatch.authorizedBinding,
              bindingFingerprint: dispatch.bindingFingerprint,
            });
          }
        });
        this.deps.runtimeExecutionServices.resourceLeaseService.releaseReconciledAttempt(
          workUnit.claimedAttemptId,
          now,
        );
        this.deps.coordinatorServices.workUnitClaimService.releaseReconciledClaim({
          workUnitId: workUnit.id,
          taskId: task.id,
          subtaskId: workUnit.claimedSubtaskId,
          attemptId: workUnit.claimedAttemptId,
        });
      }

      if (taskClaims.length === 0 && !this.deps.kernelServices.kernelWorkflowRepo.hasRecoverableWork(task.id)) {
        const subtasks = this.deps.repositories.subtaskRepo.listActiveByTask(task.id);
        const orphan = subtasks.find(subtask => !['done', 'cancelled'].includes(subtask.status));
        if (orphan) {
          const dispatch = dispatchItems.listByTask(task.id).find(item =>
            item.subtaskId === orphan.id
            && ['launching', 'running', 'uncertain'].includes(item.status)
          );
          if (!dispatch) {
            this.deps.taskServices.taskRuntimeService.blockTask(task.id, {
              taskId: task.id,
              type: 'manual',
              description: 'startup recovery found running work without authorized dispatch',
              status: 'waiting',
            });
            continue;
          }
          this.deps.kernelServices.kernelWorkflowRepo.enqueue(
            startupOrphanEvent({
              sessionId: this.originForDispatch(dispatch.decisionId),
              taskId: task.id,
              subtaskId: orphan.id,
              attemptId: dispatch.attemptId,
              dispatch,
              occurredAt: now,
            }),
          );
        }
      }
      await this.recoverTask(task.id);
    }
    for (const task of this.deps.taskServices.taskRuntimeService.listTasksByStatus('blocked')) {
      await this.recoverTask(task.id);
    }
  }

  async recoverPeriodic(nowMs = Date.now()): Promise<boolean> {
    for (const task of this.deps.taskServices.taskRuntimeService.listTasksByStatus('blocked')) {
      const sessionId = this.originForTask(task.id);
      if (!sessionId) continue;
      const recovered = await this.withSystemBinding(sessionId, () => (
        this.deps.kernelExecutionServices.kernelExecutionRuntime.recoverDue(
          task.id,
          'account timer durable recovery drain',
        )
      ));
      if (recovered) return true;
    }

    if (!this.deps.blockedRecheckEnabled) return false;
    if (this.lastBlockedRecheckAt !== null
      && nowMs - this.lastBlockedRecheckAt < this.deps.blockedRecheckIntervalMs) {
      return false;
    }
    this.lastBlockedRecheckAt = nowMs;
    const target = this.deps.kernelServices.kernelDecisionRepo
      .listCurrentByAction('wait_for_capacity')[0];
    if (!target?.taskId || !target.subtaskId || !target.sessionId) return false;
    return this.withSystemBinding(target.sessionId, () => (
      this.deps.kernelExecutionServices.kernelExecutionRuntime.recheckCapacity({
        taskId: target.taskId!,
        subtaskId: target.subtaskId!,
        blockedDecisionId: target.id,
        blockedAt: target.createdAt,
        recheckAfterMs: this.deps.blockedRecheckIntervalMs,
        occurredAt: new Date(nowMs).toISOString(),
      })
    ));
  }

  private async recoverTask(taskId: string): Promise<void> {
    const sessionId = this.originForTask(taskId);
    if (!sessionId) {
      throw new Error(`startup recovery cannot resolve Conversation origin for Task ${taskId}`);
    }
    await this.withSystemBinding(sessionId, () => (
      this.deps.kernelExecutionServices.kernelExecutionRuntime.recoverDue(
        taskId,
        'account startup durable recovery',
      ).then(() => undefined)
    ));
  }

  private originForDispatch(decisionId: string): string {
    const decision = this.deps.kernelServices.kernelDecisionRepo.findById(decisionId);
    if (!decision?.sessionId) {
      throw new Error(`startup recovery cannot resolve Conversation origin for decision ${decisionId}`);
    }
    return decision.sessionId;
  }

  private originForTask(taskId: string): string | null {
    const decision = this.deps.kernelServices.kernelDecisionRepo.listByTask(taskId).at(-1);
    return decision?.sessionId ?? null;
  }

  private async recoverKernelCoordinator(): Promise<void> {
    await this.deps.kernelCoordinator.recover({
      buildSnapshot: event => this.buildCoordinatorSnapshot(event),
      runtime: {
        apply: decision => this.applyCoordinatorDecision(decision),
      },
    });
  }

  private buildCoordinatorSnapshot(event: KernelEvent): KernelSnapshot {
    if (event.type === 'plan_proposed') {
      return {
        schemaVersion: 5,
        type: 'plan_admission',
        tasks: this.deps.taskServices.taskRuntimeService.listTasks()
          .map(task => ({ id: task.id, status: task.status })),
        runningTaskId: this.deps.kernelExecutionServices.kernelExecutionRuntime
          .getSingleActiveTaskId(),
        plannerConfiguration: this.deps.plannerConfiguration,
        kernelConfiguration: this.deps.kernelConfiguration,
        executorStatuses: this.deps.repositories.kernelExecutorStatusRepo
          .list(event.configurationRevision),
        v5WorkGraphTaskIds: this.deps.repositories.subtaskRepo.listTaskIds(),
        eligibleContextRefKeys: buildEligibleContextRefKeys({
          db: this.deps.db,
          sessionId: event.sessionId,
          refs: event.proposal.workGraph?.subtasks.flatMap(subtask => subtask.contextRefs) ?? [],
          targetTask: event.proposal.task.taskId
            ? this.deps.taskServices.taskRuntimeService.findTask(event.proposal.task.taskId)
            : null,
          userInput: event.requestText,
        }),
        pendingAuthorizationRequest: (() => {
          const pending = this.deps.workspaceServices.permissionRepository.findOldestPending();
          return pending
            ? { requestId: pending.request.id, taskId: pending.request.taskId }
            : null;
        })(),
      };
    }
    if (event.type === 'recovery_resolution_requested') {
      const task = event.taskId
        ? this.deps.taskServices.taskRuntimeService.findTask(event.taskId)
        : null;
      const application = this.deps.kernelServices.kernelWorkflowRepo
        .findRecoveryItem(event.recoveryItemId);
      const effect = this.deps.repositories.effectOutboxRepo.find(event.recoveryItemId);
      return {
        schemaVersion: 5,
        type: 'recovery',
        task: task ? { id: task.id, status: task.status } : null,
        item: application
          ? {
              id: application.id,
              kind: 'application',
              status: application.status as 'uncertain' | 'failed',
              retrySafe: true,
            }
          : effect && (effect.status === 'uncertain' || effect.status === 'failed')
            ? {
                id: effect.id,
                kind: 'effect',
                status: effect.status,
                retrySafe: false,
              }
            : null,
      };
    }
    throw new Error(`account Kernel coordinator cannot recover event type ${event.type}`);
  }

  private async applyCoordinatorDecision(decision: KernelDecision): Promise<KernelEvent | null> {
    if (decision.action.type === 'resolve_recovery') {
      const now = new Date().toISOString();
      if (this.deps.kernelServices.kernelWorkflowRepo.findRecoveryItem(
        decision.action.recoveryItemId,
      )) {
        this.deps.kernelServices.kernelWorkflowRepo.resolveRecoveryItem(
          decision.action.recoveryItemId,
          decision.action.resolution,
          now,
        );
      } else {
        this.deps.repositories.effectOutboxRepo.resolve(
          decision.action.recoveryItemId,
          decision.action.resolution,
          now,
        );
      }
      return null;
    }
    const persisted = this.deps.kernelServices.kernelDecisionRepo.findById(decision.id);
    if (!persisted?.sessionId) {
      throw new Error(
        `startup recovery cannot resolve Conversation origin for decision ${decision.id}`,
      );
    }
    const source = this.deps.kernelServices.kernelWorkflowRepo.findEvent(decision.eventId);
    const userInput = source?.type === 'plan_proposed' ? source.requestText : '';
    return this.withSystemBinding(persisted.sessionId, () => (
      this.deps.kernelExecutionServices.sessionKernelRuntime
        .forInput(userInput)
        .apply(decision)
    ));
  }

  private async withSystemBinding<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const background = new Set<Promise<void>>();
    const result = await this.deps.binder.runWith(
      this.systemBinding(sessionId, background),
      operation,
    );
    while (background.size > 0) {
      await Promise.all([...background]);
    }
    return result;
  }

  private systemBinding(
    sessionId: string,
    background: Set<Promise<void>>,
  ): ConversationExecutionBinding {
    const persistenceService = new SessionPersistenceService(this.deps.db);
    return {
      sessionId,
      persistenceService,
      presentation: new SessionPresentationService(),
      kernelExecutionCallbacks: {
        appendOutput: () => undefined,
        recordResultDelivery: () => undefined,
        appendExecutionTrace: () => undefined,
        refreshRuntimeState: () => undefined,
        appendTaskQueueSnapshot: () => undefined,
        setFocusContext: () => undefined,
        setRunningExecutorName: () => undefined,
        clearRunningExecutorName: () => undefined,
        persistSessionState: () => undefined,
        setLatestGuidance: () => ({ scene: '', taskId: '', taskTitle: '', recommendedAction: '', reasons: [] }),
        queueProposal: () => undefined,
        requestReplan: async () => {
          throw new Error('startup recovery requires the originating Conversation Planner for replan');
        },
        requestMergeReplan: async () => {
          throw new Error('startup recovery requires the originating Conversation Planner for merge replan');
        },
        buildPlanAdmissionSnapshot: event => this.buildCoordinatorSnapshot(event),
      },
      taskExecutionCallbacks: {
        appendOutput: () => undefined,
        appendGuidance: () => undefined,
        refreshRuntimeState: () => undefined,
        startBackgroundExecution: (_taskId, launch) => {
          const work = launch().finally(() => background.delete(work));
          background.add(work);
        },
      },
      sessionKernelCallbacks: {
        appendOutput: () => undefined,
        deliverDirectReply: (userInput, reply) => {
          persistenceService.recordInteraction({
            taskId: null,
            sessionId,
            userInput,
            systemOutput: reply,
            executorUsed: 'planning-agent',
          });
        },
        prepareTaskExecution: (taskId, request) => {
          this.deps.kernelExecutionServices.taskExecutionApplicationService
            .prepareTaskExecution(taskId, request);
        },
        refreshRuntimeState: () => undefined,
        setCurrentTaskId: () => undefined,
        getCurrentTaskId: () => null,
        setFocusContext: () => undefined,
        resolveRequestText: eventId => {
          const event = this.deps.kernelServices.kernelWorkflowRepo.findEvent(eventId);
          return event?.type === 'plan_proposed' ? event.requestText : '';
        },
        cancelTask: async (taskId, reason) => {
          await this.deps.kernelExecutionServices.kernelExecutionRuntime.cancelTask(taskId, reason);
        },
      },
    };
  }

  private async deliverPendingEffects(now: string): Promise<void> {
    for (const effect of this.deps.repositories.effectOutboxRepo.listPending(now)) {
      if (effect.effectType !== 'task_completion_notification') continue;
      await this.deps.repositories.effectOutboxRepo.deliver(effect.id, async record => {
        await this.deps.verificationAndDeliveryService.deliverTaskCompletion(
          this.deps.notifier,
          record.payload as unknown as TaskCompletionDeliveryInput,
        );
        return effect.id;
      }, () => new Date().toISOString());
    }
  }
}

function startupOrphanEvent(input: {
  sessionId: string;
  taskId: string;
  subtaskId: string;
  attemptId: string;
  dispatch: KernelDispatchItemRecord;
  occurredAt: string;
}): Extract<KernelEvent, { type: 'execution_outcome' }> {
  const dispatch = input.dispatch;
  if (!dispatch) throw new Error(`missing dispatch for ${input.attemptId}`);
  return {
    schemaVersion: 5,
    configurationRevision: dispatch.configurationRevision,
    type: 'execution_outcome',
    id: `startup_orphan_${input.attemptId}`,
    correlationId: input.taskId,
    causationId: input.attemptId,
    occurredAt: input.occurredAt,
    sessionId: input.sessionId,
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    attemptId: input.attemptId,
    terminalKind: 'failed',
    authorizedBinding: dispatch.authorizedBinding,
    bindingFingerprint: dispatch.bindingFingerprint,
    attemptKind: dispatch.attemptKind,
    sourceAttemptId: dispatch.sourceAttemptId,
    failure: {
      kind: 'heartbeat_lost',
      scope: 'agent_class',
      code: 'startup_orphaned_work',
      summary: 'AnyFusion restarted with orphaned active work; explicit recovery is required',
    },
  };
}
