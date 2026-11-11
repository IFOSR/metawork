import {
  evaluatePlanAdmission,
  planAdmissionSnapshotFromControl,
} from '../execution/plan-admission-entry.js';
import type {
  PlanAdmissionRequest,
  PlanAdmissionResult,
} from '../execution/plan-admission-policy.js';
import { WorkspaceGitRecovery } from '../execution/workspace-git-recovery.js';
import type Database from 'better-sqlite3';
import { AttemptExecutionBackendReconciler } from '../execution/attempt-execution-backend-reconciler.js';
import type { VerificationAndDeliveryService } from '../delivery/verification-and-delivery-service.js';
import type { TaskCompletionDeliveryInput } from '../delivery/verification-and-delivery-service.js';
import type { NotificationService } from '../notifications/types.js';
import { SessionPersistenceService } from '../session/session-persistence-service.js';
import { SessionPresentationService } from '../session/session-presentation-service.js';
import type { ControlEvent } from '../control/control-contracts.js';
import type { ControlDecision, ControlSnapshot } from '../control/control-contracts.js';
import type { PlanningAgent } from '../planning/planning-agent.js';
import { PlanningContextBuilder } from '../planning/planning-context-builder.js';
import {
  GenerationReplanWorker,
  type GenerationReplanPlannerPort,
} from './generation-replan-worker.js';
import { RetryWakeWorker } from './retry-wake-worker.js';
import { clearStaleCapacityBlocks } from './capacity-block-convergence.js';
import type {
  ControlConfigurationView,
  PlannerConfigurationView,
} from '../configuration/types.js';
import type { ControlDispatchItemRecord } from '../storage/dispatch-item-repo.js';
import type { AccountConversationExecutionBinder, ConversationExecutionBinding } from './account-conversation-execution-binder.js';
import type { AccountControlExecutionServices } from './account-control-execution-services.js';
import type { AccountControlServices } from './account-control-services.js';
import type { AccountRepositories } from './account-repositories.js';
import type { AccountRuntimeExecutionServices } from './account-runtime-execution-services.js';
import type { AccountTaskServices } from './account-task-services.js';
import type { AccountWorkspaceServices } from './account-workspace-services.js';
import type { AccountCoordinatorServices } from './account-coordinator-services.js';
import type { AccountControlCoordinator } from './account-control-coordinator.js';
import { buildEligibleContextRefKeys } from '../work-graph/index.js';
import {
  inspectApplicationAgainstSources,
  isRetrySafeLegacySystemBindingReplan,
  legacySystemBindingRecoveryEvent,
  type ApplicationPostconditionFactSource,
} from '../execution/control-application-recovery.js';
import {
  createSubtaskLifecyclePort,
  type SubtaskLifecyclePort,
} from '../task/task-lifecycle-transition-port.js';
import { TaskResidueReader } from '../execution/task-residue-reader.js';
import { AttemptTerminalService } from '../execution/attempt-terminal-service.js';
import type { QueuedTaskPayload } from '../storage/conversation-task-scheduler-repo.js';
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import type { QueryUsageLifecycle } from '../metering/query-lifecycle.js';
import type { RecoveryReplan } from '../session/recovery-replanner.js';
import type { ConfigurationSnapshot } from '../configuration/types.js';
import { buildControlConfigurationView, buildPlannerConfigurationView } from '../configuration/projections.js';
import type { ConversationResultDelivery } from '../session/conversation-session.js';
import type { ExecutionTraceAppendInput } from '../execution/execution-trace.js';

/**
 * Bounded retry budget for a `retry_safe` uncertain application before it must
 * stay `uncertain` and surface as explicit `recovery_required`.
 */
const MAX_UNSAFE_APPLICATION_RETRIES = 3;

export class AccountStartupRecoveryService {
  private lastBlockedRecheckAt: number | null = null;
  private readonly promotionInFlight = new Map<string, Promise<void>>();
  private replanWorker: GenerationReplanWorker | null = null;
  private retryWakeWorker: RetryWakeWorker | null = null;
  private lifecycle: SubtaskLifecyclePort | null = null;
  private residue: TaskResidueReader | null = null;
  private readonly configurations = new Map<string, ConfigurationSnapshot>();

  private getRetryWakeWorker(): RetryWakeWorker {
    return this.retryWakeWorker ??= new RetryWakeWorker({
      retryWakeRepo: this.deps.runtimeExecutionServices.retryWakeRepo,
      processTimer: (event, reason) => this.withSystemBinding(event.sessionId, () => (
        this.deps.kernelExecutionServices.kernelExecutionRuntime.recoverRetryWake(event, reason)
      )),
      now: () => new Date().toISOString(),
    });
  }

  constructor(private readonly deps: {
    readonly accountId: string;
    readonly productionAuthorization?: () => { allowed: boolean; reason?: string };
    readonly db: Database.Database;
    readonly recoveryReplan?: RecoveryReplan;
    readonly recoveryPlan?: PlanningAgent['plan'];
    readonly resolveConfigurationSnapshot?: (revisionId: string) => Promise<ConfigurationSnapshot>;
    readonly kernelServices: AccountControlServices;
    readonly repositories: AccountRepositories;
    readonly workspaceServices: AccountWorkspaceServices;
    readonly taskServices: AccountTaskServices;
    readonly taskStateAuthority: import('../task/task-state-authority.js').TaskStateAuthority;
    readonly coordinatorServices: AccountCoordinatorServices;
    readonly runtimeExecutionServices: AccountRuntimeExecutionServices;
    readonly kernelExecutionServices: AccountControlExecutionServices;
    readonly kernelCoordinator: AccountControlCoordinator;
    readonly plannerConfiguration: PlannerConfigurationView;
    readonly kernelConfiguration: ControlConfigurationView;
    readonly planningAgent: PlanningAgent;
    readonly binder: AccountConversationExecutionBinder;
    readonly notifier: NotificationService;
    readonly verificationAndDeliveryService: VerificationAndDeliveryService;
    readonly blockedRecheckEnabled: boolean;
    readonly blockedRecheckIntervalMs: number;
    readonly queryUsageLifecycle?: QueryUsageLifecycle;
    readonly onSystemResultDelivery?: (sessionId: string, delivery: ConversationResultDelivery) => Promise<void>;
    readonly appendExecutionTrace?: (
      sessionId: string,
      input: ExecutionTraceAppendInput,
    ) => void;
  }) {}

  async observeWorkspaceMerge(job: import('../workspace/workspace-git-contracts.js').WorkspaceMergeJob): Promise<void> {
    const sessionId = this.originForTask(job.taskId);
    if (!sessionId) return;
    await this.withSystemBinding(sessionId, () =>
      this.deps.kernelExecutionServices.kernelExecutionRuntime.onWorkspaceMergeChanged(job));
  }

  private async recoverWorkspaceGit(): Promise<void> {
    const {workspaceMergeWorker, conversationWorktrees} = this.deps.workspaceServices;
    await new WorkspaceGitRecovery(conversationWorktrees, workspaceMergeWorker)
      .recover(job => this.observeWorkspaceMerge(job));
  }

  async onTaskTerminal(taskId: string): Promise<void> {
    const task = this.deps.taskServices.taskRuntimeService.findTask(taskId);
    const scheduler = this.deps.repositories.conversationTaskSchedulerRepo;
    const conversationId = task?.conversationId;
    if (!task || !conversationId) return;
    const finalizedAt = new Date().toISOString();
    try {
      this.deps.queryUsageLifecycle?.finalizeQueriesForTask(taskId, finalizedAt);
    } catch {
      // Usage attribution is durable and must not turn Task completion
      // into an execution failure.
    }
    if (this.hasReleasableResidue(taskId, this.activeGenerationId(taskId))) {
      scheduler.releaseSlotAndPromote(conversationId, taskId, finalizedAt, true);
      return;
    }
    // Capacity is Workspace-scoped: releasing this Task may promote the next
    // queued Task in the same Conversation only while the Workspace still has
    // room for another executing Conversation.
    const workspaceId = task.workspaceId ?? '';
    const occupiedInWorkspace = scheduler.occupiedSlotCountsByWorkspace(workspaceId).get(workspaceId) ?? 0;
    const workspaceLimit = this.workspaceConversationLimit();
    const promotion = scheduler.releaseSlotAndPromote(
      conversationId,
      taskId,
      new Date().toISOString(),
      () => this.hasReleasableResidue(taskId, this.activeGenerationId(taskId)),
      Math.max(0, occupiedInWorkspace - 1) < workspaceLimit,
    );
    if (promotion) {
      await this.promoteConversationTask(promotion.taskId, conversationId);
    }
    await this.promoteAvailableQueuedTasks(new Date().toISOString());
  }

  /**
   * Immediately wake queued work created by an explicit result decision.
   *
   * Result acceptance moves the owning Task back to `queued` while its
   * publication continuation is durably staged. That transition does not
   * pass through the terminal-task admission callback, so waiting for the
   * periodic recovery sweep makes the user see a stale queue and can block a
   * follow-up request in the same Conversation. Promotion still goes through
   * the account-wide capacity and fairness checks.
   */
  async onTaskQueued(taskId: string): Promise<void> {
    const task = this.deps.taskServices.taskRuntimeService.findTask(taskId);
    if (!task?.conversationId) return;
    const entry = this.deps.repositories.conversationTaskSchedulerRepo.getQueuedPayload(taskId);
    if (!entry) return;
    const scheduler = this.deps.repositories.conversationTaskSchedulerRepo;
    const promotions = scheduler.promoteAvailable(this.workspaceConversationLimit(), new Date().toISOString());
    for (const promotion of promotions) {
      // Do not await the execution from the caller that is currently draining
      // the same continuation; the promoted execution owns its own idempotent
      // recovery path.
      void this.promoteConversationTask(promotion.taskId, promotion.conversationId);
    }
  }

  /**
   * The one residue contract for slot release (2026-09-25 plan §3.4, review
   * fix 4). Completion, cancellation, startup recovery, periodic recovery and
   * TaskView must all ask the same reader; a Task-local re-derivation would
   * disagree about `pending`/`applying` applications and receipt-less terminal
   * dispatch items.
   */
  private residueReader(): TaskResidueReader {
    return this.residue ??= new TaskResidueReader({
      db: this.deps.db,
      dispatchItemRepo: this.deps.runtimeExecutionServices.dispatchItemRepo,
      publicationRepo: this.deps.runtimeExecutionServices.publicationRepo,
      workUnitClaimService: this.deps.coordinatorServices.workUnitClaimService,
    });
  }

  private hasReleasableResidue(
    taskId: string,
    generationId: string | null,
    excludedDecisionId?: string,
  ): boolean {
    return this.residueReader().blockingReasons(
      taskId,
      generationId,
      excludedDecisionId,
    ).length > 0;
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
    if (payload.remainingWork) {
      await this.withSystemBinding(task.ownerPlannerSessionId ?? payload.plannerSessionId,
        () => this.deps.kernelExecutionServices.kernelExecutionRuntime.recoverDue(taskId));
      return;
    }
    const request = promotedExecutionRequest(payload, taskId);
    await this.withSystemBinding(task.ownerPlannerSessionId ?? payload.plannerSessionId, () => {
      const started = this.deps.kernelExecutionServices.taskExecutionApplicationService
        .prepareTaskExecution(taskId, request);
      return started.completion;
    });
  }

  private async loadRecoveryConfigurations(): Promise<void> {
    if (!this.deps.resolveConfigurationSnapshot) return;
    const active = this.deps.db.prepare(`
      SELECT DISTINCT configuration_revision AS revision FROM work_graph_revisions WHERE status = 'active'
    `).all() as Array<{ revision: string }>;
    const revisions = new Set([
      ...active.map(({ revision }) => revision),
      ...this.deps.kernelServices.recoveryItems.listRecoveryConfigurationRevisions(),
    ]);
    for (const revision of revisions) {
      if (!revision || this.configurations.has(revision)) continue;
      const snapshot = await this.deps.resolveConfigurationSnapshot(revision);
      if (snapshot.revisionId !== revision) throw new Error('recovery configuration revision mismatch');
      this.configurations.set(revision, snapshot);
    }
  }

  async recover(): Promise<void> {
    await this.loadRecoveryConfigurations();
    const now = new Date().toISOString();
    const terminals = new AttemptTerminalService(this.deps.db);
    for (const item of this.deps.runtimeExecutionServices.dispatchItemRepo.listBlocking()) {
      const settled = terminals.reconcileSettledFailure(item.attemptId, now);
      if (!settled) continue;
      this.deps.coordinatorServices.workUnitClaimService.releaseReconciledClaim(settled);
    }
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
          // Conversation files are already retained in their registered worktree.
          // Never create a legacy Task directory to checkpoint a Git Attempt.
          if (this.deps.workspaceServices.workspaceGitRepo.binding(record.taskId, record.generationId)) {
            checkpointIds.set(record.attemptId, null);
            return;
          }
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
        await this.observeControlEvent({
          schemaVersion: 5,
          configurationRevision: dispatch.configurationRevision,
          type: 'sandbox_lost',
          id: `sandbox_lost_${record.attemptId}`,
          correlationId: record.taskId,
          causationId: record.attemptId,
          occurredAt: now,
          sessionId: this.originForDispatch(dispatch.taskId),
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
        }, 'startup sandbox loss recovery');
      }
    }

    await this.recoverWorkspaceGit();

    // Cancellation is a synchronous Task Runtime fence: the fence row and the
    // Task state change commit together, so only the asynchronous cleanup drain
    // needs recovery here.
    await this.deps.runtimeExecutionServices.cancellationCoordinator.recover();
    this.deps.repositories.effectOutboxRepo.reconcileSending(now);
    await this.deliverPendingEffects(now);
    await this.recoverControlCoordinator();
    await this.convergeRecovery(now);

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
        const sessionId = this.originForDispatch(dispatch.taskId);
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

      if (taskClaims.length === 0 && !this.hasOwnedRecoverableWork(task.id)) {
        const subtasks = this.deps.repositories.subtaskRepo.listActiveByTask(task.id);
        const orphan = subtasks.find(subtask => subtask.status === 'running');
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
              this.markStartupRecoveryBlocked(
                task.id,
                'startup recovery found running work without authorized dispatch',
                currentTask,
              );
            }
            if (currentTask?.status === 'running' || currentTask?.status === 'needs_action') continue;
          } else {
            await this.observeControlEvent(
              startupOrphanEvent({
                sessionId: this.originForDispatch(dispatch.taskId),
                taskId: task.id,
                subtaskId: orphan.id,
                attemptId: dispatch.attemptId,
                dispatch,
                occurredAt: now,
              }),
              'startup orphan dispatch recovery',
            );
          }
        }
      }
      await this.recoverTask(task.id);
    }
    for (const task of this.deps.taskServices.taskRuntimeService.listTasksByStatus('needs_action')) {
      await this.recoverTask(task.id);
    }
  }

  /**
   * Shared convergence entry for startup and periodic recovery
   * (2026-09-25 review fix 2). Work is selected from durable pending facts —
   * uncertain applications, scheduled or failed Replan Jobs, residue — not from
   * a single `Task.status` scan, so a Task that never reaches `blocked` still
   * converges.
   */
  private async convergeRecovery(now: string): Promise<boolean> {
    this.convergeTerminalTaskUsage(now);
    const retriedTaskIds = [...new Set(this.convergeUncertainApplications(now))];
    // Re-queuing an application is not convergence on its own: the same pass
    // must drain the Task so the retried Decision is actually re-applied and
    // the next verdict is observed (2026-09-25 review, bounded retry closure).
    for (const taskId of retriedTaskIds) {
      try {
        await this.recoverTask(taskId);
      } catch {
        // A Task without a resolvable origin keeps the application observable
        // as `recovery_required`; it must not take the recovery pass down.
      }
    }
    const retryWakeResidue = await this.convergeMissingRetryWakes(now);
    const retryWakesDelivered = await this.getRetryWakeWorker().run(now);
    const signalled = await this.convergeRecoveryRequired(now);
    // A partition/capacity yield is a scheduler wait: once its resource waits
    // are resolved, the stale blocker must not keep the Task queued forever.
    const clearedCapacityBlocks = this.clearStaleCapacityBlocks();
    // A Task that is `queued` again must be promotable: its entry cannot stay
    // `running` from the attempt that yielded.
    const requeuedEntries = this.requeueQueuedTaskEntries();
    await this.convergeConversationSlots(now);
    await this.promoteAvailableQueuedTasks(now);
    // Internal Worktree directories are Runtime state: retire the ones whose
    // Generation is terminal and residue-free, keep the rest for recovery.
    try {
      await this.deps.kernelExecutionServices.kernelExecutionRuntime
        .cleanupWorktreeExecutions?.();
    } catch {
      // Cleanup diagnostics are durable; a failed sweep must not block startup.
    }
    return signalled
      || retriedTaskIds.length > 0
      || retryWakeResidue > 0
      || retryWakesDelivered > 0
      || clearedCapacityBlocks.length > 0
      || requeuedEntries > 0;
  }

  /**
   * Rebuilds the only safe missing continuation fact from an applied
   * `wait_for_retry` Decision. This is intentionally a recovery operation:
   * Task rows are never edited directly and a contradictory residue becomes an
   * explicit recovery observation instead of an endless blocked Task.
   */
  private async convergeMissingRetryWakes(now: string): Promise<number> {
    let changed = 0;
    const taskRuntime = this.deps.taskServices.taskRuntimeService;
    const wakeRepo = this.deps.runtimeExecutionServices.retryWakeRepo;
    for (const task of taskRuntime.listTasksByStatus('needs_action')) {
      if (!task.dependencies.some(dependency =>
        dependency.type === 'kernel_retry' && dependency.status === 'waiting'
      )) continue;
      if (wakeRepo.findBlockingByTask(task.id).length > 0) continue;
      const recoveryWake = wakeRepo.findRecoveryRequiredByTask(task.id)[0] ?? null;
      if (recoveryWake) {
        const sessionId = this.originForTask(task.id);
        const configurationRevision = this.deps.repositories.workGraphRevisionRepo
          .findActive(task.id)?.configurationRevision;
        if (sessionId && configurationRevision) {
          changed += await this.enqueueRetryWakeRecovery({
            taskId: task.id,
            sourceDecisionId: recoveryWake.sourceDecisionId,
            configurationRevision,
            sessionId,
            reason: `Retry Wake ${recoveryWake.wakeId} requires recovery`,
            now,
          }) ? 1 : 0;
        }
        continue;
      }
      const sessionId = this.originForTask(task.id);
      const configurationRevision = this.deps.repositories.workGraphRevisionRepo
        .findActive(task.id)?.configurationRevision;
      if (!sessionId || !configurationRevision) continue;
      // Nothing to rebuild: the wake row is the continuation fact. Without one the
      // Task cannot resume on its own and must surface as a recovery item.
      changed += await this.enqueueRetryWakeRecovery({
        taskId: task.id,
        sourceDecisionId: task.id,
        configurationRevision,
        sessionId,
        reason: 'kernel_retry blocker has no durable Retry Wake',
        now,
      }) ? 1 : 0;
      await this.recoverTask(task.id, 'missing Retry Wake recovery observation');
    }
    return changed;
  }

  /** Owner facts that still owe work for this Task. */
  private hasOwnedRecoverableWork(taskId: string): boolean {
    if (this.deps.kernelServices.recoveryItems.countPending(taskId) > 0) return true;
    if (this.deps.runtimeExecutionServices.retryWakeRepo.findBlockingByTask(taskId).length > 0) return true;
    return this.deps.runtimeExecutionServices.dispatchItemRepo.listByTask(taskId)
      .some(item => ['pending_launch', 'launching', 'running', 'cancelling', 'uncertain'].includes(item.status));
  }

  private async enqueueRetryWakeRecovery(input: {
    taskId: string;
    sourceDecisionId: string;
    configurationRevision: string;
    sessionId: string;
    reason: string;
    now: string;
  }): Promise<boolean> {
    if (!input.sessionId) return false;
    const recoveryId = `retry_wake_recovery_${input.taskId}`;
    return this.observeControlEvent({
      schemaVersion: 5,
      configurationRevision: input.configurationRevision,
      type: 'recovery_required_observed',
      id: recoveryId,
      correlationId: input.taskId,
      causationId: input.sourceDecisionId,
      occurredAt: input.now,
      sessionId: input.sessionId,
      taskId: input.taskId,
      recoveryItemId: recoveryId,
      reason: input.reason,
    }, 'retry wake recovery observation');
  }

  /**
   * Usage finalization is a Task-terminal consequence, not a Conversation
   * slot consequence. A completed Task can already have released its slot
   * before the process dies, and older releases could also miss the terminal
   * callback entirely. Revisit every durable terminal Task on the same startup
   * and periodic convergence pass; the Query usage lifecycle resolves its linked
   * Queries idempotently.
   */
  private convergeTerminalTaskUsage(now: string): void {
    const terminalStatuses = new Set(['succeeded', 'failed', 'cancelled']);
    for (const task of this.deps.taskServices.taskRuntimeService.listTasks()) {
      if (!terminalStatuses.has(task.status)) continue;
      try {
        this.deps.queryUsageLifecycle?.finalizeQueriesForTask(task.id, now);
      } catch {
        // Usage attribution is durable and must not reopen or fail a
        // terminal Task; the next convergence pass retries it.
      }
    }
  }

  /**
   * Emits one durable `recovery_required_observed` fact per Task that can no
   * longer progress on its own, so the Kernel authorizes an explicit
   * `block_work` instead of the Task staying `running` forever
   * (2026-09-25 review fix 1). The event id is deterministic per recovery item,
   * so repeated passes cannot accumulate duplicate blocker decisions.
   */
  private async convergeRecoveryRequired(now: string): Promise<boolean> {
    let signalled = false;
    for (const task of this.deps.taskServices.taskRuntimeService.listTasks()) {
      // A terminal conclusion or a Task already waiting for its user needs no
      // additional recovery observation.
      if (task.status === 'succeeded' || task.status === 'failed'
        || task.status === 'cancelled' || task.status === 'needs_action') continue;
      const fact = this.recoveryRequiredFact(task.id);
      if (!fact) continue;
      // Prefer the active revision's pin, but fall back to the recovery item's
      // own recorded revision so a Task with no active revision (an initial
      // plan that failed before creating one) still converges.
      const configurationRevision = this.deps.repositories.workGraphRevisionRepo
        .findActive(task.id)?.configurationRevision
        ?? this.configurationRevisionForRecoveryItem(task.id, fact.recoveryItemId);
      const sessionId = this.originForTask(task.id);
      if (!configurationRevision || !sessionId) continue;
      await this.observeControlEvent({
        schemaVersion: 5,
        configurationRevision,
        type: 'recovery_required_observed',
        id: `recovery_required_${fact.recoveryItemId}`,
        correlationId: task.id,
        causationId: fact.recoveryItemId,
        occurredAt: now,
        sessionId,
        taskId: task.id,
        recoveryItemId: fact.recoveryItemId,
        reason: fact.reason,
      }, 'account recovery_required convergence');
      signalled = true;
      await this.withSystemBinding(sessionId, () => (
        this.deps.kernelExecutionServices.kernelExecutionRuntime.recoverDue(
          task.id,
          'account recovery_required convergence',
        )
      ));
    }
    return signalled;
  }

  /**
   * The durable reasons a Task has no remaining Kernel-authorized driver.
   *
   * Two independent sources:
   *
   * 1. A Replan Job that failed closed **for the currently active graph
   *    revision**. A stale failure from an older revision must not block a Task
   *    whose newer revision already succeeded (2026-09-25 review fix).
   * 2. An uncertain application that can no longer converge: either its
   *    declared postcondition is `unresolved`, or its bounded re-application
   *    budget is exhausted. `unresolved` never increments `applyAttempts`, so
   *    counting attempts alone would leave it uncertain forever.
   *
   * Neither source requires an active Work Graph revision: an initial
   * `authorize_task_plan` can fail before any revision exists, and that must
   * still converge.
   */
  private recoveryRequiredFact(
    taskId: string,
  ): { recoveryItemId: string; reason: string } | null {
    const revision = this.deps.repositories.workGraphRevisionRepo.findActive(taskId);
    if (revision) {
      const jobsForGeneration = this.deps.runtimeExecutionServices.generationReplanRepo
        .listByTask(taskId)
        .filter(job => job.generationId === revision.generationId);
      const latest = jobsForGeneration
        .slice()
        .sort((left, right) => left.sourceRevision - right.sourceRevision)
        .at(-1);
      if (
        latest?.status === 'failed'
        && latest.sourceRevision === revision.revision
      ) {
        return {
          recoveryItemId: latest.id,
          reason: latest.errorSummary
            ?? 'planner_unavailable: the authorized Replan Job failed',
        };
      }
    }
    const sources = this.recoveryFactSource();
    const stuck = this.deps.kernelServices.recoveryItems
      .listPending(taskId)
      .filter(item => {
        const inspection = inspectApplicationAgainstSources(item, sources);
        if (inspection.verdict === 'unresolved') return true;
        return inspection.verdict === 'retry_safe'
          && item.applyAttempts >= MAX_UNSAFE_APPLICATION_RETRIES;
      })
      .at(-1);
    if (stuck) {
      return {
        // The application id, so the Kernel recovery item and the revision
        // fallback resolve to the same durable row.
        recoveryItemId: stuck.id,
        reason: `unresolved_application: ${stuck.decision.action.type}`
          + `${stuck.errorSummary ? ` ${stuck.errorSummary}` : ''}`,
      };
    }
    return null;
  }

  /**
   * How many Conversations in one Workspace may execute at once. This is the
   * only scheduling limit in the product; there is no account-wide Task or
   * Attempt ceiling.
   */
  private workspaceConversationLimit(): number {
    return this.deps.kernelConfiguration.runtimePolicy.maxConcurrentConversationsPerWorkspace ?? 2;
  }

  private async promoteAvailableQueuedTasks(now: string): Promise<void> {
    const scheduler = this.deps.repositories.conversationTaskSchedulerRepo;
    const promotions = scheduler.promoteAvailable(this.workspaceConversationLimit(), now);
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
        OR (status = 'integrated' AND EXISTS (SELECT 1 FROM workspace_publication_deliveries d
          JOIN subtasks s ON s.id = workspace_publications.subtask_id
          WHERE d.publication_id = workspace_publications.id AND d.status <> 'failed' AND s.status = 'awaiting_integration'))
    `).all() as Array<{ task_id: string }>;
    for (const publication of publications) taskIds.add(publication.task_id);
    const continuations = this.deps.db.prepare(`SELECT DISTINCT task_id FROM effect_outbox
      WHERE effect_type IN ('task_result_continuation', 'task_remaining_work')
        AND status <> 'sent'`).all() as Array<{ task_id: string }>;
    for (const continuation of continuations) taskIds.add(continuation.task_id);
    return [...taskIds].sort();
  }

  async recoverPeriodic(nowMs = Date.now()): Promise<boolean> {
    await this.recoverWorkspaceGit();
    const now = new Date(nowMs).toISOString();
    // Durable Replan Jobs are consumed first: they are the account-scoped
    // replacement for the foreground Conversation replan callback, so they must
    // run before recovery converges the Tasks they own.
    const replan = await this.runReplanWorker();
    // The same convergence entry as startup recovery, selected from durable
    // pending facts rather than a blocked-only Task scan (review fix 2).
    const converged = await this.convergeRecovery(now);
    for (const task of this.deps.taskServices.taskRuntimeService.listTasksByStatus('needs_action')) {
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

    if (replan.claimed > 0 || converged) return true;

    if (!this.deps.blockedRecheckEnabled) return false;
    if (this.lastBlockedRecheckAt !== null
      && nowMs - this.lastBlockedRecheckAt < this.deps.blockedRecheckIntervalMs) {
      return false;
    }
    this.lastBlockedRecheckAt = nowMs;
    // A capacity wait is an owner fact: the Task carries a `kernel_capacity`
    // blocker, and its ready Subtask is the one to re-dispatch.
    const target = this.deps.taskServices.taskRuntimeService.listTasksByStatus('needs_action')
      .flatMap(task => task.dependencies
        .filter(dependency => dependency.type === 'kernel_capacity' && dependency.status === 'waiting')
        .map(dependency => ({ task, dependency })))
      .flatMap(({ task, dependency }) => {
        const subtask = this.deps.repositories.subtaskRepo.listActiveByTask(task.id)
          .find(item => item.status === 'ready');
        const sessionId = this.originForTask(task.id);
        return subtask && sessionId ? [{ task, dependency, subtask, sessionId }] : [];
      })[0];
    if (!target) return false;
    return this.withSystemBinding(target.sessionId, () => (
      this.deps.kernelExecutionServices.kernelExecutionRuntime.recheckCapacity({
        taskId: target.task.id,
        subtaskId: target.subtask.id,
        blockedDecisionId: `capacity_wait:${target.task.id}:${target.dependency.createdAt}`,
        blockedAt: target.dependency.createdAt,
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
      productionAuthorization: this.deps.productionAuthorization,
      replanRepo: this.deps.runtimeExecutionServices.generationReplanRepo,
      planner: this.buildReplanPlannerPort(),
      findTask: taskId => this.deps.taskServices.taskRuntimeService.findTask(taskId),
      // A client-less replan is admitted against the Task's own Workspace.
      resolveTaskWorkspace: task => {
        if (!task.workspaceId) return null;
        const root = this.deps.workspaceServices.workspaceGitRepo.root(task.workspaceId);
        if (!root) return null;
        return { workspaceId: task.workspaceId, canonicalPath: root.userRoot };
      },
      now: () => new Date().toISOString(),
    });
    try {
      const report = await worker.run();
      await this.recoverControlCoordinator();
      return { claimed: report.claimed };
    } catch {
      // A worker failure must never take the account periodic review down; the
      // Job keeps its durable identity and the next pass retries it.
      return { claimed: 0 };
    }
  }

  private buildReplanPlannerPort(): GenerationReplanPlannerPort {
    return {
      plan: context => (this.deps.recoveryPlan ?? this.deps.planningAgent.plan.bind(this.deps.planningAgent))(context),
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
        return [...(this.deps.repositories.planProposalRepo.findInitialForTask(taskId)?.request.attachmentIds ?? [])];
      },
      findActiveGraph: taskId => this.deps.repositories.workGraphRevisionRepo.findActive(taskId),
      submitProposal: async ({ proposal }) => {
        this.deps.repositories.planProposalRepo.assertAdmissionOpen(proposal.id);
        const snapshot = this.buildCoordinatorSnapshot(
          {
            ...proposal,
            schemaVersion: 5,
            type: 'plan_proposed',
            correlationId: proposal.proposal.id,
            causationId: null,
          } as unknown as Extract<ControlEvent, { type: 'plan_proposed' }>,
        ) as unknown as Extract<ControlSnapshot, { type: 'plan_admission' }>;
        const admission = evaluatePlanAdmission(
          proposal,
          planAdmissionSnapshotFromControl(snapshot),
        );
        this.deps.repositories.planProposalRepo.markForwarded(proposal.id, new Date().toISOString());
        await this.applyAdmissionInOwnerBinding(proposal, admission);
      },
    };
  }

  private async recoverTask(
    taskId: string,
    reason = 'account startup durable recovery',
  ): Promise<void> {
    const sessionId = this.originForTask(taskId);
    if (!sessionId) {
      throw new Error(`startup recovery cannot resolve Conversation origin for Task ${taskId}`);
    }
    await this.withSystemBinding(sessionId, () => (
      this.deps.kernelExecutionServices.kernelExecutionRuntime.recoverDue(
        taskId,
        reason,
      ).then(() => undefined)
    ));
  }

  private originForDispatch(taskId: string): string {
    const sessionId = this.originForTask(taskId);
    if (!sessionId) {
      throw new Error(`startup recovery cannot resolve Conversation origin for Task ${taskId}`);
    }
    return sessionId;
  }

  /**
   * The Task's owning Conversation is the durable origin, so recovery routing
   * never depends on the retired decision ledger.
   */
  private originForTask(taskId: string): string | null {
    const task = this.deps.taskServices.taskRuntimeService.findTask(taskId);
    return task?.ownerPlannerSessionId ?? task?.conversationId ?? null;
  }

  /**
   * The producer applies its own observation. Startup recovery derives these
   * facts from durable rows, so nothing needs to be queued for another workflow
   * to drain; a failure to apply is retried by the next convergence pass.
   */
  private async observeControlEvent(
    event: ControlEvent,
    reason: string,
  ): Promise<boolean> {
    const taskId = event.taskId;
    if (!taskId) return false;
    const sessionId = 'sessionId' in event && typeof event.sessionId === 'string'
      ? event.sessionId
      : this.originForTask(taskId);
    if (!sessionId) return false;
    try {
      await this.withSystemBinding(sessionId, () => (
        this.deps.kernelExecutionServices.kernelExecutionRuntime.submitControlEvent(event, reason)
      ));
      return true;
    } catch {
      // The Task may have concluded or lost its generation between the fact and
      // the application; the next pass re-derives it instead of failing startup.
      return false;
    }
  }

  private async recoverControlCoordinator(): Promise<void> {
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
  private convergeUncertainApplications(now: string): string[] {
    const recoveryItems = this.deps.kernelServices.recoveryItems;
    const sources = this.recoveryFactSource();
    const retriedTaskIds = new Set<string>();
    for (const item of recoveryItems.listPending()) {
      const inspection = inspectApplicationAgainstSources(item, sources);
      if (inspection.verdict === 'applied') {
        recoveryItems.resolveRecoveryItem(item.id, 'assume_applied', now);
        continue;
      }
      // Bounded retry: after the declared budget the application stays
      // `uncertain` so it surfaces as explicit `recovery_required` instead of
      // oscillating forever between pending and uncertain.
      if (inspection.verdict === 'retry_safe'
        && item.applyAttempts < MAX_UNSAFE_APPLICATION_RETRIES) {
        recoveryItems.resolveRecoveryItem(item.id, 'retry', now);
        const action = item.decision.action;
        if ('taskId' in action && action.taskId) retriedTaskIds.add(action.taskId);
      }
    }
    return [...retriedTaskIds];
  }

  /**
   * Records a durable startup-recovery blocker and lets the Task state authority
   * conclude. Recovery never writes a Task status itself.
   */
  private markStartupRecoveryBlocked(
    taskId: string,
    reason: string,
    task?: import('../core/types.js').Task,
  ): void {
    const runtime = this.deps.taskServices.taskRuntimeService;
    const current = task ?? runtime.findTask(taskId);
    if (!current) return;
    this.deps.taskStateAuthority.reconcile({
      taskId,
      decisionId: `startup_recovery:${taskId}:${current.stateVersion}`,
      operationKey: `startup_recovery:${taskId}:${current.stateVersion}`,
      actor: 'account-startup-recovery',
      reason,
      facts: () => {
        runtime.updateTask(taskId, {
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
        return [];
      },
    });
  }

  private lifecyclePort(): SubtaskLifecyclePort {
    return this.lifecycle ??= createSubtaskLifecyclePort({
      subtaskRepo: this.deps.repositories.subtaskRepo,
    });
  }

  private configurationRevisionForRecoveryItem(
    taskId: string,
    recoveryItemId: string,
  ): string | null {
    const item = this.deps.kernelServices.recoveryItems.findRecoveryItem(recoveryItemId);
    if (item?.decision.configurationRevision) {
      return item.decision.configurationRevision;
    }
    return this.deps.runtimeExecutionServices.generationReplanRepo
      .find(recoveryItemId)?.configurationRevision ?? null;
  }

  private activeGenerationId(taskId: string): string | null {
    return this.deps.repositories.workGraphRevisionRepo.findActive(taskId)?.generationId ?? null;
  }

  private recoveryFactSource(): ApplicationPostconditionFactSource {
    return {
      findTask: taskId => {
        const task = this.deps.taskServices.taskRuntimeService.findTask(taskId);
        return task
          ? {
              id: task.id,
              status: task.status,
              dependencies: task.dependencies.map(dependency => ({
                type: dependency.type,
                status: dependency.status,
              })),
            }
          : null;
      },
      listSubtasks: taskId => this.deps.repositories.subtaskRepo.listByTask(taskId)
        .map(subtask => ({ id: subtask.id, status: subtask.status })),
      listDispatchItems: taskId => this.deps.runtimeExecutionServices.dispatchItemRepo
        .listByTask(taskId)
        .map(item => ({
          attemptId: item.attemptId,
          decisionId: item.decisionId,
          causationId: null,
          subtaskId: item.subtaskId,
          generationId: item.generationId,
          attemptKind: item.attemptKind,
          bindingFingerprint: item.bindingFingerprint,
          configurationRevision: item.configurationRevision,
          sourceAttemptId: item.sourceAttemptId,
          status: item.status,
        })),
      findWorkGraphRevision: (taskId, revision) => {
        const record = this.deps.repositories.workGraphRevisionRepo.find(taskId, revision);
        return record
          ? {
              revision: record.revision,
              generationId: record.generationId,
              authorizedOperationId: record.authorizedOperationId,
              status: record.status,
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
      findReplanRequestById: id => (
        this.deps.runtimeExecutionServices.generationReplanRepo.find(id)
      ),
      findRetryWake: (taskId, sourceDecisionId) => {
        const wake = this.deps.runtimeExecutionServices.retryWakeRepo.findByDecision(
          sourceDecisionId,
        );
        return wake && wake.taskId === taskId
          ? {
              wakeId: wake.wakeId,
              taskId: wake.taskId,
              subtaskId: wake.subtaskId,
              sourceDecisionId: wake.sourceDecisionId,
              sourceAttemptId: wake.sourceAttemptId,
              configurationRevision: wake.configurationRevision,
              bindingFingerprint: wake.bindingFingerprint,
              resumeAt: wake.resumeAt,
              status: wake.status,
            }
          : null;
      },
    };
  }

  /**
   * Conversation slot convergence (2026-09-25 plan §3.4, §5.2). A slot whose
   * Task is releasable and whose residue is clear is released and its queued
   * successor promoted exactly once; a Task with residue keeps the slot and the
   * residue stays visible through TaskView.
   */
  /**
   * Prompt single-Task form of {@link convergeConversationSlots}: called right
   * after a Task committed `needs_action`. It releases the Conversation slot only
   * when no residue remains, so a user's next answer is admitted instead of
   * queuing behind a Task that is only waiting for them. The periodic
   * convergence repeats the same check from durable facts, so a crash between
   * the state commit and this call still converges.
   */
  async onWaitingForUser(taskId: string, now = new Date().toISOString()): Promise<void> {
    const scheduler = this.deps.repositories.conversationTaskSchedulerRepo;
    const task = this.deps.taskServices.taskRuntimeService.findTask(taskId);
    if (!task || task.status !== 'needs_action') return;
    const slot = scheduler.getSlot(task.conversationId ?? '');
    if (!slot || slot.activeTaskId !== taskId || slot.state === 'free') {
      // Nothing is held; still close a runnable queue entry so the paused Task
      // cannot be promoted while it waits.
      scheduler.parkScheduleEntry(taskId, now);
      return;
    }
    if (this.hasReleasableResidue(taskId, this.activeGenerationId(taskId))) {
      scheduler.releaseSlotAndPromote(slot.conversationId, taskId, now, true);
      return;
    }
    scheduler.parkScheduleEntry(taskId, now);
    const promotion = scheduler.releaseSlotAndPromote(slot.conversationId, taskId, now,
      () => this.hasReleasableResidue(taskId, this.activeGenerationId(taskId)), true,
      { reservationId: slot.reservationId, slotVersion: slot.slotVersion, taskVersion: task?.stateVersion ?? 0 });
    if (promotion) await this.promoteConversationTask(promotion.taskId, slot.conversationId);
  }

  /**
   * Clear `kernel_capacity` blockers whose resource waits are already resolved.
   * The Kernel still authorizes the dispatch; this only removes a stale
   * scheduler fact so the queue can resume the Task.
   */
  private clearStaleCapacityBlocks(): string[] {
    const tasks = this.deps.taskServices.taskRuntimeService;
    return clearStaleCapacityBlocks({
      tasks: tasks.listTasksByStatus('queued'),
      hasUnresolvedWait: taskId => (
        this.deps.runtimeExecutionServices.resourceLeaseService.findWaiting(taskId) ?? []
      ).length > 0,
      clear: taskId => {
        const task = tasks.findTask(taskId);
        if (!task) return;
        tasks.updateTask(taskId, {
          dependencies: task.dependencies.filter(dependency => !(
            dependency.status === 'waiting' && dependency.type === 'kernel_capacity'
          )),
        });
      },
    });
  }

  /** Make every `queued` Task promotable again by closing a stale run entry. */
  private requeueQueuedTaskEntries(): number {
    const scheduler = this.deps.repositories.conversationTaskSchedulerRepo;
    let changed = 0;
    for (const task of this.deps.taskServices.taskRuntimeService.listTasksByStatus('queued')) {
      if (scheduler.requeueStaleEntry(task.id)) changed += 1;
    }
    return changed;
  }

  private async convergeConversationSlots(now: string): Promise<void> {
    const scheduler = this.deps.repositories.conversationTaskSchedulerRepo;
    const tasks = this.deps.taskServices.taskRuntimeService;
    for (const slot of scheduler.listSlots()) {
      const taskId = slot.activeTaskId;
      if (!taskId || slot.state === 'free') continue;
      const task = tasks.findTask(taskId);
      if (!task) continue;
      const terminal = task.status === 'succeeded' || task.status === 'failed'
        || task.status === 'cancelled';
      // `needs_action` is the only non-terminal state that must never hold a slot
      // after its cleanup converged, and `queued` never holds one: a
      // `running -> queued` capacity edge leaves the slot behind unless it is
      // released here (otherwise the queue can never be promoted).
      const releasableBlock = task.status === 'needs_action' || task.status === 'queued';
      if (!terminal && !releasableBlock) continue;
      if (this.hasReleasableResidue(taskId, this.activeGenerationId(taskId))) {
        scheduler.releaseSlotAndPromote(slot.conversationId, taskId, now, true);
        continue;
      }
      if (task.status === 'needs_action' || task.status === 'queued') {
        // A blocked or queued Task with no residue must not hold its
        // Conversation; releasing it lets the queue (this Task included) be
        // promoted again.
        const promotion = scheduler.releaseSlotAndPromote(
          slot.conversationId,
          taskId,
          now,
          () => this.hasReleasableResidue(taskId, this.activeGenerationId(taskId)), true,
          { reservationId: slot.reservationId, slotVersion: slot.slotVersion, taskVersion: task.stateVersion },
        );
        if (promotion) {
          await this.promoteConversationTask(promotion.taskId, slot.conversationId);
        }
        continue;
      }
      const promotion = scheduler.releaseSlotAndPromote(slot.conversationId, taskId, now,
      () => this.hasReleasableResidue(taskId, this.activeGenerationId(taskId)), true,
      { reservationId: slot.reservationId, slotVersion: slot.slotVersion, taskVersion: task?.stateVersion ?? 0 });
      if (promotion) {
        await this.promoteConversationTask(promotion.taskId, slot.conversationId);
      }
    }
  }

  private buildCoordinatorSnapshot(event: ControlEvent): ControlSnapshot {
    if (event.type === 'plan_proposed') {
      const pinned = this.configurations.get(event.configurationRevision);
      const plannerConfiguration = pinned ? buildPlannerConfigurationView(pinned) : this.deps.plannerConfiguration;
      const kernelConfiguration = pinned ? buildControlConfigurationView(pinned) : this.deps.kernelConfiguration;
      if (plannerConfiguration.revisionId !== event.configurationRevision
        || kernelConfiguration.revisionId !== event.configurationRevision) {
        throw new Error('recovery configuration revision unavailable');
      }
      return {
        schemaVersion: 5,
        type: 'plan_admission',
        tasks: this.deps.taskServices.taskRuntimeService.listTasks()
          .map(task => ({
            id: task.id,
            status: task.status,
            ...(task.conversationId ? { conversationId: task.conversationId } : {}),
            ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
            ...(task.executionMode ? { executionMode: task.executionMode } : {}),
            ...(task.workspaceDeliveryPolicy ? { deliveryPolicy: task.workspaceDeliveryPolicy } : {}),
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
        plannerConfiguration,
        kernelConfiguration,
        executorStatuses: this.deps.repositories.kernelExecutorStatusRepo
          .list(event.configurationRevision),
        v5WorkGraphTaskIds: this.deps.repositories.subtaskRepo.listTaskIds(),
        eligibleContextRefKeys: buildEligibleContextRefKeys({
          db: this.deps.db,
          sessionId: event.sessionId,
          conversationId: event.conversationId ?? event.sessionId,
          accountId: this.deps.accountId,
          refs: event.proposal.workGraph?.subtasks.flatMap(subtask => subtask.contextRefs) ?? [],
          targetTask: event.proposal.task.taskId
            ? this.deps.taskServices.taskRuntimeService.findTask(event.proposal.task.taskId)
            : null,
          userInput: event.requestText,
          attachmentIds: event.attachmentIds,
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
      const application = this.deps.kernelServices.recoveryItems
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

  private async applyCoordinatorDecision(decision: ControlDecision): Promise<ControlEvent | null> {
    if (decision.action.type === 'resolve_recovery') {
      const now = new Date().toISOString();
      if (this.deps.kernelServices.recoveryItems.findRecoveryItem(
        decision.action.recoveryItemId,
      )) {
        this.deps.kernelServices.recoveryItems.resolveRecoveryItem(
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
    const source = this.deps.repositories.planProposalRepo.find(decision.eventId)?.request;
    const userInput = source?.requestText ?? '';
    const taskId = source?.taskId
      ?? ('taskId' in decision.action ? decision.action.taskId : null);
    const sessionId = taskId ? this.originForTask(taskId) : null;
    if (!sessionId) {
      throw new Error(
        `startup recovery cannot resolve Conversation origin for decision ${decision.id}`,
      );
    }
    const task = taskId
      ? this.deps.taskServices.taskRuntimeService.findTask(taskId)
      : null;
    return this.withSystemBinding(sessionId, () => (
      this.deps.kernelExecutionServices.sessionControlRuntime
        .forInput(userInput, source?.conversationId ?? task?.conversationId, source?.queryId)
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

  /** Applies a direct admission in the Conversation that owns the proposal. */
  private async applyAdmissionInOwnerBinding(
    proposal: PlanAdmissionRequest,
    admission: PlanAdmissionResult,
  ): Promise<void> {
    const task = proposal.taskId
      ? this.deps.taskServices.taskRuntimeService.findTask(proposal.taskId)
      : null;
    const sessionId = proposal.sessionId;
    await this.withSystemBinding(sessionId, () => (
      this.deps.kernelExecutionServices.sessionControlRuntime.applyPlanAdmission(admission, {
        proposalId: proposal.id,
        userInput: proposal.requestText,
        ...(proposal.conversationId ?? task?.conversationId
          ? { conversationId: proposal.conversationId ?? task!.conversationId! }
          : {}),
        queryId: proposal.queryId ?? null,
      })
    ));
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
        appendExecutionTrace: input => {
          this.deps.appendExecutionTrace?.(sessionId, input);
        },
        refreshRuntimeState: () => undefined,
        appendTaskQueueSnapshot: () => undefined,
        setFocusContext: () => undefined,
        setRunningExecutorName: () => undefined,
        clearRunningExecutorName: () => undefined,
        persistSessionState: () => undefined,
        setLatestGuidance: () => ({ scene: '', taskId: '', taskTitle: '', recommendedAction: '', reasons: [] }),
        queueProposal: () => undefined,
        requestReplan: decision => {
          if (!this.deps.recoveryReplan) throw new Error('recovery replan adapter unavailable');
          return this.deps.recoveryReplan(sessionId, decision);
        },
        requestMergeReplan: decision => {
          if (!this.deps.recoveryReplan) throw new Error('recovery replan adapter unavailable');
          return this.deps.recoveryReplan(sessionId, decision);
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
      sessionControlCallbacks: {
        appendOutput: () => undefined,
        onDecisionApplying: () => undefined,
        prepareTaskExecution: (taskId, request) => {
          this.deps.kernelExecutionServices.taskExecutionApplicationService
            .prepareTaskExecution(taskId, request);
        },
        refreshRuntimeState: () => undefined,
        setCurrentTaskId: () => undefined,
        getCurrentTaskId: () => null,
        setFocusContext: () => undefined,
        resolveRequestText: eventId => {
          return this.deps.repositories.planProposalRepo.find(eventId)?.request.requestText ?? '';
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
      operationId: payload.kernelDecisionId ?? `queued_${taskId}`,
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
  dispatch: ControlDispatchItemRecord;
  occurredAt: string;
}): Extract<ControlEvent, { type: 'execution_outcome' }> {
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
