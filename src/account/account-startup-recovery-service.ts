import type Database from 'better-sqlite3';
import { AttemptExecutionBackendReconciler } from '../execution/attempt-execution-backend-reconciler.js';
import type { VerificationAndDeliveryService } from '../delivery/verification-and-delivery-service.js';
import type { TaskCompletionDeliveryInput } from '../delivery/verification-and-delivery-service.js';
import type { NotificationService } from '../notifications/types.js';
import { SessionPersistenceService } from '../session/session-persistence-service.js';
import { SessionPresentationService } from '../session/session-presentation-service.js';
import type { KernelEvent } from '../kernel/control-kernel.js';
import type { KernelDecision, KernelSnapshot } from '../kernel/control-kernel.js';
import type { PlanningAgent } from '../planning/planning-agent.js';
import { PlanningContextBuilder } from '../planning/planning-context-builder.js';
import {
  GenerationReplanWorker,
  type GenerationReplanPlannerPort,
} from './generation-replan-worker.js';
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
import {
  inspectApplicationAgainstSources,
  isRetrySafeLegacySystemBindingReplan,
  legacySystemBindingRecoveryEvent,
  type ApplicationPostconditionFactSource,
} from '../execution/kernel-application-recovery.js';
import {
  createTaskLifecycleTransitionPort,
  type TaskLifecycleTransitionPort,
} from '../task/task-lifecycle-transition-port.js';
import { reconcileUncertainCancellations } from '../execution/cancellation-reconciliation.js';
import type { QueuedTaskPayload } from '../storage/conversation-task-scheduler-repo.js';
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import type { QueryUsageLifecycle } from '../metering/query-lifecycle.js';
import type { ConversationResultDelivery } from '../session/conversation-session.js';

/**
 * Bounded retry budget for a `retry_safe` uncertain application before it must
 * stay `uncertain` and surface as explicit `recovery_required`.
 */
const MAX_UNSAFE_APPLICATION_RETRIES = 3;

export class AccountStartupRecoveryService {
  private lastBlockedRecheckAt: number | null = null;
  private readonly promotionInFlight = new Map<string, Promise<void>>();
  private replanWorker: GenerationReplanWorker | null = null;
  private lifecycle: TaskLifecycleTransitionPort | null = null;

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
    readonly planningAgent: PlanningAgent;
    readonly binder: AccountConversationExecutionBinder;
    readonly notifier: NotificationService;
    readonly verificationAndDeliveryService: VerificationAndDeliveryService;
    readonly blockedRecheckEnabled: boolean;
    readonly blockedRecheckIntervalMs: number;
    readonly queryUsageLifecycle?: QueryUsageLifecycle;
    readonly onSystemResultDelivery?: (sessionId: string, delivery: ConversationResultDelivery) => Promise<void>;
  }) {}

  async onTaskTerminal(taskId: string): Promise<void> {
    const task = this.deps.taskServices.taskRuntimeService.findTask(taskId);
    const scheduler = this.deps.repositories.conversationTaskSchedulerRepo;
    const conversationId = task?.conversationId;
    if (!task || !conversationId) return;
    if (this.hasReleasableResidue(taskId)) {
      scheduler.releaseSlotAndPromote(conversationId, taskId, new Date().toISOString(), true);
      return;
    }
    try {
      this.deps.queryUsageLifecycle?.finalizeQueriesForTask(taskId, new Date().toISOString());
    } catch {
      // Billing reconciliation is durable and must not turn Task completion
      // into an execution failure.
    }
    const occupiedOtherCount = scheduler.listSlots().filter(slot => (
      slot.activeTaskId !== taskId
      && (slot.state === 'occupied' || slot.state === 'releasing')
    )).length;
    const maxConcurrentTasks = this.deps.kernelConfiguration.runtimePolicy.maxConcurrentTasks ?? 2;
    const promotion = scheduler.releaseSlotAndPromote(
      conversationId,
      taskId,
      new Date().toISOString(),
      false,
      occupiedOtherCount < maxConcurrentTasks,
    );
    if (promotion) {
      await this.promoteConversationTask(promotion.taskId, conversationId);
    }
    await this.promoteAvailableQueuedTasks(new Date().toISOString());
  }

  /**
   * Bounded residue reader for Conversation slot release (2026-09-25 plan
   * §3.4). A slot is released only when none of these still own the Task:
   * dispatch/WorkUnit/lease/backend capacity, publication, an uncertain Kernel
   * application, or an outstanding durable Replan Job.
   */
  private hasReleasableResidue(taskId: string): boolean {
    if (this.deps.runtimeExecutionServices.dispatchItemRepo.hasBlockingResidue(taskId)) {
      return true;
    }
    if (this.deps.runtimeExecutionServices.publicationRepo.hasBlockingResidue(taskId)) {
      return true;
    }
    if (this.deps.coordinatorServices.workUnitClaimService.hasClaimedByTask(taskId)) {
      return true;
    }
    if (this.deps.runtimeExecutionServices.resourceLeaseService.findActive()
      .some(lease => lease.taskId === taskId)) {
      return true;
    }
    if (this.deps.workspaceServices.attemptExecutionRepository.listActive()
      .some(attempt => attempt.taskId === taskId)) {
      return true;
    }
    if (this.deps.kernelServices.kernelWorkflowRepo
      .listUncertainApplications([], taskId).length > 0) {
      return true;
    }
    return this.deps.runtimeExecutionServices.generationReplanRepo.listByTask(taskId)
      .some(job => ['pending_quiescence', 'planning', 'submitted', 'waiting_for_availability']
        .includes(job.status));
  }

  private promoteConversationTask(taskId: string, conversationId: string): Promise<void> {
    const existing = this.promotionInFlight.get(conversationId);
    if (existing) return existing;
    const work = this.startPromotedTask(taskId, conversationId)
      .catch(() => {
        this.deps.repositories.conversationTaskSchedulerRepo.markRecoveryBlocked(
          conversationId,
          taskId,
          new Date().toISOString(),
        );
      })
      .finally(() => {
        if (this.promotionInFlight.get(conversationId) === work) {
          this.promotionInFlight.delete(conversationId);
        }
      });
    this.promotionInFlight.set(conversationId, work);
    return work;
  }

  private async startPromotedTask(taskId: string, conversationId: string): Promise<void> {
    const task = this.deps.taskServices.taskRuntimeService.findTask(taskId);
    const payload = this.deps.repositories.conversationTaskSchedulerRepo.getQueuedPayload(taskId);
    if (!task || task.conversationId !== conversationId || !payload || !payload.generationId) {
      throw new Error(`queued Task ${taskId} failed immutable owner/payload validation`);
    }
    this.deps.repositories.conversationTaskSchedulerRepo.markRunning(taskId, new Date().toISOString());
    const request = promotedExecutionRequest(payload, taskId);
    await this.withSystemBinding(task.ownerPlannerSessionId ?? payload.plannerSessionId, () => {
      const started = this.deps.kernelExecutionServices.taskExecutionApplicationService
        .prepareTaskExecution(taskId, request);
      return started.completion;
    });
  }

  async recover(): Promise<void> {
    const now = new Date().toISOString();
    const backendLossAttemptIds = new Set<string>();
    const claimedOrphans = this.deps.coordinatorServices.workUnitClaimService.listOrphanedClaims();
    const dispatchItems = this.deps.runtimeExecutionServices.dispatchItemRepo;
    const recoveryTaskIds = this.collectRecoveryTaskIds(claimedOrphans);
    const requiresAttemptReconciliation = claimedOrphans.length > 0
      || this.deps.workspaceServices.attemptExecutionRepository.listActive().length > 0
      || dispatchItems.listBlocking().length > 0;

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

    // §5.3.5: reconcile uncertain cancellation applications FIRST, so a
    // re-applied cancellation becomes a durable cancelled Task before the
    // recovery sweep below releases its Conversation slot.
    const cancellationReconciliation = reconcileUncertainCancellations({
      store: this.deps.kernelServices.kernelWorkflowRepo,
      coordinator: this.deps.runtimeExecutionServices.cancellationCoordinator,
      taskRuntimeService: this.deps.taskServices.taskRuntimeService,
    });
    void cancellationReconciliation;
    await this.deps.runtimeExecutionServices.cancellationCoordinator.recover();
    this.deps.repositories.effectOutboxRepo.reconcileSending(now);
    this.deps.kernelServices.kernelWorkflowRepo.reconcileProcessing();
    this.convergeUncertainApplications(now);
    this.enqueueRetrySafeSystemBindingRecoveries(now);
    await this.deliverPendingEffects(now);
    await this.recoverKernelCoordinator();

    for (const taskId of recoveryTaskIds) {
      const task = this.deps.taskServices.taskRuntimeService.findTask(taskId);
      if (!task) continue;
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
            // Recovery may discover this Task through its Conversation slot or
            // may have blocked it while reconciling an earlier durable fact.
            // Only a still-running orphan needs a new manual blocker.
            const currentTask = this.deps.taskServices.taskRuntimeService.findTask(task.id);
            if (currentTask?.status === 'running') {
              this.lifecyclePort().blockTask({
                taskId: task.id,
                dependency: {
                  taskId: task.id,
                  type: 'manual',
                  description: 'startup recovery found running work without authorized dispatch',
                  status: 'waiting',
                },
                actor: 'account-startup-recovery',
                reason: 'startup recovery found running work without authorized dispatch',
              });
            }
            if (currentTask?.status === 'running' || currentTask?.status === 'blocked') continue;
          } else {
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
      }
      await this.recoverTask(task.id);
    }
    for (const task of this.deps.taskServices.taskRuntimeService.listTasksByStatus('blocked')) {
      await this.recoverTask(task.id);
    }
    await this.convergeConversationSlots(now);
    await this.promoteAvailableQueuedTasks(now);
  }

  private async promoteAvailableQueuedTasks(now: string): Promise<void> {
    const scheduler = this.deps.repositories.conversationTaskSchedulerRepo;
    const maxConcurrentTasks = this.deps.kernelConfiguration.runtimePolicy.maxConcurrentTasks ?? 2;
    const promotions = scheduler.promoteAvailable(maxConcurrentTasks, now);
    await Promise.all(promotions.map(promotion =>
      this.promoteConversationTask(promotion.taskId, promotion.conversationId)));
  }

  private collectRecoveryTaskIds(claimedOrphans: ReturnType<
    AccountStartupRecoveryService['deps']['coordinatorServices']['workUnitClaimService']['listOrphanedClaims']
  >): string[] {
    const taskIds = new Set<string>(
      this.deps.taskServices.taskRuntimeService.listTasksByStatus('running').map(task => task.id),
    );
    for (const workUnit of claimedOrphans) {
      if (workUnit.claimedTaskId) taskIds.add(workUnit.claimedTaskId);
    }
    for (const item of this.deps.runtimeExecutionServices.dispatchItemRepo.listBlocking()) {
      taskIds.add(item.taskId);
    }
    for (const attempt of this.deps.workspaceServices.attemptExecutionRepository.listActive()) {
      taskIds.add(attempt.taskId);
    }
    for (const lease of this.deps.runtimeExecutionServices.resourceLeaseService.findActive()) {
      taskIds.add(lease.taskId);
    }
    for (const slot of this.deps.repositories.conversationTaskSchedulerRepo.listSlots()) {
      if (slot.activeTaskId && slot.state !== 'free') taskIds.add(slot.activeTaskId);
    }
    const publications = this.deps.db.prepare(`
      SELECT DISTINCT task_id FROM workspace_publications
      WHERE status IN ('pending', 'applying', 'conflicted', 'cancelling', 'uncertain')
    `).all() as Array<{ task_id: string }>;
    for (const publication of publications) taskIds.add(publication.task_id);
    return [...taskIds].sort();
  }

  async recoverPeriodic(nowMs = Date.now()): Promise<boolean> {
    // Durable Replan Jobs are consumed first: they are the account-scoped
    // replacement for the foreground Conversation replan callback, so they must
    // run before any blocked-Task recovery that might dismiss the Task.
    const replan = await this.runReplanWorker();

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

    if (replan.claimed > 0) return true;

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

  /**
   * Account-scoped Planner Worker pass (2026-09-25 convergence plan §5). Owns
   * every scheduled Replan Job; no foreground client is required.
   */
  private async runReplanWorker(): Promise<{ claimed: number }> {
    const worker = this.replanWorker ??= new GenerationReplanWorker({
      replanRepo: this.deps.runtimeExecutionServices.generationReplanRepo,
      planner: this.buildReplanPlannerPort(),
      findTask: taskId => this.deps.taskServices.taskRuntimeService.findTask(taskId),
      now: () => new Date().toISOString(),
    });
    try {
      const report = await worker.run();
      return { claimed: report.claimed };
    } catch {
      // A worker failure must never take the account periodic review down; the
      // Job keeps its durable identity and the next pass retries it.
      return { claimed: 0 };
    }
  }

  private buildReplanPlannerPort(): GenerationReplanPlannerPort {
    return {
      plan: context => this.deps.planningAgent.plan(context),
      buildPlanningContext: input => new PlanningContextBuilder({
        sessionId: input.sessionId,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        requestSource: 'system-replan',
        getTimeoutMs: () => {
          const configured = Number(process.env.METACLAW_PLANNER_TIMEOUT_MS);
          return Number.isFinite(configured) && configured > 0 ? configured : 180_000;
        },
        getPlannerConfiguration: () => this.deps.plannerConfiguration,
      }).build({ userInput: input.userInput }),
      materializeCompletedEvidence: (taskId, revision) => {
        this.deps.repositories.workGraphRuntimeService.materializeCompletedEvidence(taskId, revision);
      },
      listTaskEvidence: (taskId, generationId) => (
        this.deps.repositories.taskExecutionEvidenceRepo
          .listTaskEvidenceByGeneration(taskId, generationId)
      ),
      listAttemptReceipts: taskId => (
        this.deps.repositories.attemptReceiptRepo.listByTask(taskId)
      ),
      resolveTurnAttachmentIds: taskId => {
        const decisions = this.deps.kernelServices.kernelDecisionRepo.listByTask(taskId);
        const origin = decisions.find(record => record.eventType === 'plan_proposed');
        if (!origin) return [];
        const event = this.deps.kernelServices.kernelWorkflowRepo.findEvent(origin.eventId);
        return event?.type === 'plan_proposed' ? [...(event.attachmentIds ?? [])] : [];
      },
      drainKernel: async () => { await this.recoverKernelCoordinator(); },
    };
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

  /**
   * Convergent recovery for every managed action family (2026-09-25 plan §6).
   * Each uncertain application is inspected against its declared postcondition
   * and reaches `applied`, a safe retry, or explicit `recovery_required`; it can
   * never stay uncertain forever while the Task remains `running`.
   */
  private convergeUncertainApplications(now: string): void {
    const workflow = this.deps.kernelServices.kernelWorkflowRepo;
    const sources = this.recoveryFactSource();
    for (const application of workflow.listUncertainApplications()) {
      const inspection = inspectApplicationAgainstSources(application, sources);
      if (inspection.verdict === 'applied') {
        workflow.resolveUncertainApplication(application.decisionId, 'applied', now);
        continue;
      }
      // Bounded retry: after the declared budget the application stays
      // `uncertain` so it surfaces as explicit `recovery_required` instead of
      // oscillating forever between pending and uncertain.
      if (inspection.verdict === 'retry_safe'
        && application.applyAttempts < MAX_UNSAFE_APPLICATION_RETRIES) {
        workflow.resolveUncertainApplication(application.decisionId, 'retry', now);
      }
    }
  }

  private lifecyclePort(): TaskLifecycleTransitionPort {
    return this.lifecycle ??= createTaskLifecycleTransitionPort({
      taskRuntimeService: this.deps.taskServices.taskRuntimeService,
      subtaskRepo: this.deps.repositories.subtaskRepo,
    });
  }

  private recoveryFactSource(): ApplicationPostconditionFactSource {
    return {
      findTask: taskId => {
        const task = this.deps.taskServices.taskRuntimeService.findTask(taskId);
        return task ? { id: task.id, status: task.status } : null;
      },
      listSubtasks: taskId => this.deps.repositories.subtaskRepo.listByTask(taskId)
        .map(subtask => ({ id: subtask.id, status: subtask.status })),
      listDispatchItems: taskId => this.deps.runtimeExecutionServices.dispatchItemRepo
        .listByTask(taskId)
        .map(item => ({
          attemptId: item.attemptId,
          decisionId: item.decisionId,
          subtaskId: item.subtaskId,
          status: item.status,
        })),
      findWorkGraphRevision: (taskId, revision) => {
        const record = this.deps.repositories.workGraphRevisionRepo.find(taskId, revision);
        return record
          ? {
              revision: record.revision,
              generationId: record.generationId,
              authorizedDecisionId: record.authorizedDecisionId,
            }
          : null;
      },
      findReplanRequest: (taskId, generationId, sourceRevision) => (
        this.deps.runtimeExecutionServices.generationReplanRepo.findByGeneration(
          taskId,
          generationId,
          sourceRevision,
        )
      ),
    };
  }

  /**
   * Conversation slot convergence (2026-09-25 plan §3.4, §5.2). A slot whose
   * Task is releasable and whose residue is clear is released and its queued
   * successor promoted exactly once; a Task with residue keeps the slot and the
   * residue stays visible through TaskView.
   */
  private async convergeConversationSlots(now: string): Promise<void> {
    const scheduler = this.deps.repositories.conversationTaskSchedulerRepo;
    const tasks = this.deps.taskServices.taskRuntimeService;
    for (const slot of scheduler.listSlots()) {
      const taskId = slot.activeTaskId;
      if (!taskId || slot.state === 'free') continue;
      const task = tasks.findTask(taskId);
      if (!task) {
        scheduler.releaseSlotAndPromote(slot.conversationId, taskId, now, false);
        continue;
      }
      const terminal = ['done', 'archived', 'cancelled'].includes(task.status);
      const releasableBlock = task.status === 'blocked';
      if (!terminal && !releasableBlock) continue;
      if (this.hasReleasableResidue(taskId)) {
        scheduler.releaseSlotAndPromote(slot.conversationId, taskId, now, true);
        continue;
      }
      if (task.status === 'blocked') {
        // A blocked Task with no residue must not hold its Conversation.
        const promotion = scheduler.releaseSlotAndPromote(
          slot.conversationId,
          taskId,
          now,
          false,
        );
        if (promotion) {
          await this.promoteConversationTask(promotion.taskId, slot.conversationId);
        }
        continue;
      }
      try {
        this.deps.queryUsageLifecycle?.finalizeQueriesForTask(taskId, now);
      } catch {
        // Billing reconciliation is durable; it must not block slot release.
      }
      const promotion = scheduler.releaseSlotAndPromote(slot.conversationId, taskId, now, false);
      if (promotion) {
        await this.promoteConversationTask(promotion.taskId, slot.conversationId);
      }
    }
  }

  private enqueueRetrySafeSystemBindingRecoveries(now: string): void {
    for (const task of this.deps.taskServices.taskRuntimeService.listTasks()) {
      const activeRevision = this.deps.repositories.workGraphRevisionRepo.findActive(task.id);
      if (!activeRevision) continue;
      for (const application of this.deps.kernelServices.kernelWorkflowRepo.listRecoveryItems(task.id)) {
        const action = application.decision.action;
        if (action.type !== 'authorize_task_plan') continue;
        const request = this.deps.runtimeExecutionServices.generationReplanRepo.findByGeneration(
          task.id,
          action.generationId,
          activeRevision.revision,
        );
        if (!isRetrySafeLegacySystemBindingReplan({
          taskId: task.id,
          application,
          activeRevision,
          replanRequest: request,
        })) continue;
        const decision = this.deps.kernelServices.kernelDecisionRepo.findById(application.decisionId);
        if (!decision?.sessionId) continue;
        this.deps.kernelServices.kernelWorkflowRepo.enqueue(
          legacySystemBindingRecoveryEvent({
            taskId: task.id,
            application,
            sessionId: decision.sessionId,
            occurredAt: now,
          }),
        );
      }
    }
  }

  private buildCoordinatorSnapshot(event: KernelEvent): KernelSnapshot {
    if (event.type === 'plan_proposed') {
      return {
        schemaVersion: 5,
        type: 'plan_admission',
        tasks: this.deps.taskServices.taskRuntimeService.listTasks()
          .map(task => ({
            id: task.id,
            status: task.status,
            ...(task.conversationId ? { conversationId: task.conversationId } : {}),
            ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
          })),
        activeTaskByConversation: Object.fromEntries(
          this.deps.repositories.conversationTaskSchedulerRepo.listSlots().map(slot => [
            slot.conversationId,
            slot.activeTaskId,
          ]),
        ),
        occupiedConversationIds: this.deps.repositories.conversationTaskSchedulerRepo
          .listSlots()
          .filter(slot => slot.state !== 'free')
          .map(slot => slot.conversationId),
        queuedTaskCountByConversation: Object.fromEntries(
          this.deps.repositories.conversationTaskSchedulerRepo.listSlots().map(slot => [
            slot.conversationId,
            this.deps.repositories.conversationTaskSchedulerRepo.countQueuedTasks(slot.conversationId),
          ]),
        ),
        activeTaskCount: this.deps.repositories.conversationTaskSchedulerRepo
          .listSlots()
          .filter(slot => slot.state === 'occupied' || slot.state === 'releasing').length,
        runningTaskId: null,
        plannerConfiguration: this.deps.plannerConfiguration,
        kernelConfiguration: this.deps.kernelConfiguration,
        executorStatuses: this.deps.repositories.kernelExecutorStatusRepo
          .list(event.configurationRevision),
        v5WorkGraphTaskIds: this.deps.repositories.subtaskRepo.listTaskIds(),
        eligibleContextRefKeys: buildEligibleContextRefKeys({
          db: this.deps.db,
          sessionId: event.sessionId,
          conversationId: event.conversationId ?? event.sessionId,
          refs: event.proposal.workGraph?.subtasks.flatMap(subtask => subtask.contextRefs) ?? [],
          targetTask: event.proposal.task.taskId
            ? this.deps.taskServices.taskRuntimeService.findTask(event.proposal.task.taskId)
            : null,
          userInput: event.requestText,
        }),
        pendingAuthorizationRequest: (() => {
          const pending = this.deps.workspaceServices.permissionRepository
            .findOldestPendingForConversation(
              event.conversationId ?? event.sessionId,
            );
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
    const task = source?.taskId
      ? this.deps.taskServices.taskRuntimeService.findTask(source.taskId)
      : null;
    return this.withSystemBinding(persisted.sessionId, () => (
      this.deps.kernelExecutionServices.sessionKernelRuntime
        .forInput(userInput, task?.conversationId)
        .apply(decision)
    ));
  }

  private async withSystemBinding<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const background = new Set<Promise<void>>();
    const deliveries: ConversationResultDelivery[] = [];
    const result = await this.deps.binder.runWith(
      this.systemBinding(sessionId, background, deliveries),
      operation,
    );
    while (background.size > 0) {
      await Promise.all([...background]);
    }
    for (const delivery of deliveries) {
      await this.deps.onSystemResultDelivery?.(sessionId, delivery);
    }
    return result;
  }

  private systemBinding(
    sessionId: string,
    background: Set<Promise<void>>,
    deliveries: ConversationResultDelivery[],
  ): ConversationExecutionBinding {
    const persistenceService = new SessionPersistenceService(this.deps.db);
    return {
      sessionId,
      persistenceService,
      presentation: new SessionPresentationService(),
      kernelExecutionCallbacks: {
        appendOutput: () => undefined,
        recordResultDelivery: delivery => { deliveries.push(delivery); },
        appendExecutionTrace: () => undefined,
        refreshRuntimeState: () => undefined,
        appendTaskQueueSnapshot: () => undefined,
        setFocusContext: () => undefined,
        setRunningExecutorName: () => undefined,
        clearRunningExecutorName: () => undefined,
        persistSessionState: () => undefined,
        setLatestGuidance: () => ({ scene: '', taskId: '', taskTitle: '', recommendedAction: '', reasons: [] }),
        queueProposal: () => undefined,
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
          return work;
        },
      },
      sessionKernelCallbacks: {
        appendOutput: () => undefined,
        onDecisionApplying: () => undefined,
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
        cancelTask: (taskId, reason) =>
          this.deps.kernelExecutionServices.kernelExecutionRuntime.cancelTaskWithOutcome(taskId, reason),
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

function promotedExecutionRequest(payload: QueuedTaskPayload, taskId: string) {
  return {
    userPrompt: payload.requestText.slice(0, 24_000),
    contextTaskId: taskId,
    queryId: payload.queryId ?? null,
    executionMode: payload.executionMode ?? 'fresh' as const,
    origin: 'system' as const,
    schedulingReason: payload.schedulingReason ?? 'queued Conversation Task promoted',
    kernelDecisionId: payload.kernelDecisionId ?? null,
    authorizedWorkGraph: payload.workGraph as import('../work-graph/types.js').WorkGraphProposal,
    authorizedBindingsBySubtask: payload.authorizedBindingsBySubtask as Record<string, AuthorizedExecutorBinding[]>,
    workGraphAuthorization: {
      decisionId: payload.kernelDecisionId ?? `queued_${taskId}`,
      generationId: payload.generationId,
      revision: payload.graphRevision,
      source: payload.proposalSource ?? 'initial' as const,
      automaticReplan: false,
    },
  };
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
      summary: 'MetaWork restarted with orphaned active work; explicit recovery is required',
    },
  };
}
