/**
 * Atomic Task Runtime admission application (ADR-0055 §6, D2-3b-2b).
 *
 * One SQLite transaction commits the Task, its initial proposal origin, the
 * authorized Work Graph revision (with materialized Subtasks) and the applied
 * admission outcome. Everything that can need external IO — Workspace root
 * resolution, public-project baseline capture, cancellation — happens before
 * this call, and the transaction re-reads the durable proposal and its
 * lifecycle fence before writing, so a Turn cancelled or a Conversation
 * deleted in between cannot land a Task.
 *
 * The graph is materialized here rather than when an Executor starts, so an
 * admitted Task always has one authoritative graph revision. Execution then
 * recovers that revision instead of applying a second one.
 */
import type Database from 'better-sqlite3';
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import type { WorkspaceExecutionDecision, WorkspaceIntent } from '../core/workspace-execution.js';
import type { TaskRuntimeService } from '../task/task-runtime-service.js';
import type {
  ConversationTaskSchedulerRepo,
  QueuedTaskPayload,
} from '../storage/conversation-task-scheduler-repo.js';
import { PlanProposalUnavailableError, type PlanProposalStore } from './plan-proposal-store.js';
import type { PlanAdmissionResultStore } from './plan-admission-result-store.js';
import type { WorkGraphRuntimeService } from './work-graph-runtime-service.js';
import type { WorkGraphProposal } from '../work-graph/types.js';

export interface PlanAdmissionTaskValues {
  title: string;
  goal: string;
  resources: string[];
  publicTaskDirectory?: string;
  publicDeliveryBaseline: Record<string, string>;
  startServiceAfterPublish: boolean;
  ownerPlannerSessionId?: string;
  accountId?: string;
}

export interface PlanAdmissionApplication {
  /** Deterministic Task id for a new Task (ignored when `existingTaskId` is set). */
  taskId: string;
  existingTaskId: string | null;
  owner: { conversationId: string; workspaceId: string | null; plannerSessionId: string };
  workspaceExecution: WorkspaceExecutionDecision;
  workspaceIntent: WorkspaceIntent | null;
  proposalSource: 'initial' | 'replan' | 'conflict_replan';
  generationId: string;
  graphRevision: number;
  scheduleState: 'eligible' | 'queued';
  schedulingReason: string | null;
  workGraph: WorkGraphProposal;
  authorizedBindingsBySubtask: Record<string, AuthorizedExecutorBinding[]>;
  /** Identity that authorized this graph revision for the current transport. */
  operationId: string;
  /** Saved proposal; its lifecycle fence is re-read inside the transaction. */
  proposalId: string | null;
  requestText: string;
  queryId: string | null;
  includeRecentConversationContext?: boolean;
  task: PlanAdmissionTaskValues;
  priority?: { level: 'normal' | 'high' | 'urgent'; reason: string };
}

export interface AppliedPlanAdmission {
  status: 'authorized' | 'queued';
  taskId: string;
  schedulingReason: string | null;
  /** The durable outcome already existed; no Task/graph/slot write happened. */
  replayed: boolean;
}

export interface PlanAdmissionApplicationDeps {
  db: Database.Database;
  taskRuntimeService: TaskRuntimeService;
  workGraphRuntimeService: WorkGraphRuntimeService;
  planProposals?: PlanProposalStore;
  admissionResults?: PlanAdmissionResultStore;
  conversationTaskSchedulerRepo?: ConversationTaskSchedulerRepo;
  /** Conversation Git delivery is a model of the runtime, not of admission. */
  conversationGit?: boolean;
}

export class PlanAdmissionApplicationService {
  constructor(private readonly deps: PlanAdmissionApplicationDeps) {}

  apply(input: PlanAdmissionApplication): AppliedPlanAdmission {
    const recorded = input.proposalId
      ? this.deps.admissionResults?.find(input.proposalId)
      : null;
    if (recorded && (recorded.status === 'authorized' || recorded.status === 'queued')) {
      // The outcome is already durable: no Task, graph revision, queue entry or
      // slot claim may be written twice for one proposal.
      return {
        status: recorded.status,
        taskId: recorded.taskId ?? input.existingTaskId ?? input.taskId,
        schedulingReason: recorded.detail?.schedulingReason ?? null,
        replayed: true,
      };
    }
    return this.deps.db.transaction(() => this.applyInTransaction(input)).immediate();
  }

  private applyInTransaction(input: PlanAdmissionApplication): AppliedPlanAdmission {
    // Durable facts are re-read inside the write transaction: a Turn cancelled
    // or a Conversation deleted after the asynchronous Workspace IO must not
    // leave a Task behind.
    const proposal = input.proposalId
      ? this.deps.planProposals?.find(input.proposalId) ?? null
      : null;
    if (input.proposalId) {
      if (!this.deps.planProposals || !proposal) {
        throw new PlanProposalUnavailableError('proposal_missing');
      }
      this.deps.planProposals.assertAdmissionOpen(input.proposalId);
      const recorded = this.deps.admissionResults?.find(input.proposalId);
      if (recorded && (recorded.status === 'authorized' || recorded.status === 'queued')) {
        return {
          status: recorded.status,
          taskId: recorded.taskId ?? input.existingTaskId ?? input.taskId,
          schedulingReason: recorded.detail?.schedulingReason ?? null,
          replayed: true,
        };
      }
    }
    const existing = input.existingTaskId
      ? this.deps.taskRuntimeService.findTask(input.existingTaskId)
      : null;
    if (input.existingTaskId && !existing) {
      throw new Error(`task not found: ${input.existingTaskId}`);
    }
    const task = existing ?? this.deps.taskRuntimeService.createTask({
      id: input.taskId,
      executionMode: input.workspaceExecution.executionMode,
      publicTaskDirectory: input.task.publicTaskDirectory,
      publicDeliveryBaseline: input.task.publicDeliveryBaseline,
      startServiceAfterPublish: input.task.startServiceAfterPublish,
      workspaceExecutionSource: input.workspaceExecution.source,
      workspaceDeliveryPolicy: input.workspaceExecution.deliveryPolicy,
      workspaceTargetPaths: input.workspaceExecution.targetPaths,
      workspaceIntent: input.workspaceIntent,
      title: input.task.title,
      goal: input.task.goal,
      resources: input.task.resources,
      accountId: input.task.accountId,
      conversationId: input.owner.conversationId,
      workspaceId: input.owner.workspaceId ?? undefined,
      ownerPlannerSessionId: input.task.ownerPlannerSessionId ?? input.owner.plannerSessionId,
    });
    if (!existing && input.proposalId) {
      this.deps.planProposals?.bindInitialToTask(task.id, input.proposalId);
    }
    const graph = this.deps.workGraphRuntimeService.apply({
      conversationGit: Boolean(this.deps.conversationGit),
      task,
      userPrompt: input.requestText,
      sessionId: input.owner.plannerSessionId,
      authorizedWorkGraph: input.workGraph,
      authorizedBindingsBySubtask: input.authorizedBindingsBySubtask,
      authorization: {
        operationId: input.operationId,
        generationId: input.generationId,
        revision: input.graphRevision,
        source: input.proposalSource,
        automaticReplan: input.proposalSource === 'replan',
      },
    });
    if (graph.outcome === 'not_executable') {
      // Roll the Task and origin binding back: an admitted Task must always
      // carry exactly one authoritative graph revision.
      throw new Error(`authorized Work Graph could not be persisted: ${graph.reason}`);
    }
    if (input.priority) {
      const current = this.deps.taskRuntimeService.findTask(task.id) ?? task;
      this.deps.taskRuntimeService.updateTask(task.id, {
        prioritySignals: {
          ...current.prioritySignals,
          semanticPriority: input.priority.level,
          semanticPriorityReason: input.priority.reason,
        },
      });
    }
    let status: 'authorized' | 'queued' = input.scheduleState === 'queued'
      ? 'queued'
      : 'authorized';
    if (!existing && this.deps.conversationTaskSchedulerRepo) {
      const scheduler = this.deps.conversationTaskSchedulerRepo;
      const now = new Date().toISOString();
      const payload: QueuedTaskPayload = {
        requestText: input.requestText.slice(0, 24_000),
        queryId: input.queryId,
        generationId: input.generationId,
        graphRevision: input.graphRevision,
        workGraph: input.workGraph,
        authorizedBindingsBySubtask: input.authorizedBindingsBySubtask,
        workspaceId: input.owner.workspaceId,
        plannerSessionId: input.owner.plannerSessionId,
        kernelDecisionId: input.operationId,
        proposalSource: input.proposalSource,
        includeRecentConversationContext: input.includeRecentConversationContext,
        schedulingReason: input.schedulingReason ?? 'work graph authorized',
      };
      // Persist the authorized execution fact before the slot claim, so a lost
      // race leaves a recoverable queue entry instead of a Task without one.
      scheduler.enqueueTask(task.id, input.owner.conversationId, now, payload);
      const slot = scheduler.getSlot(input.owner.conversationId);
      const admitted = input.scheduleState === 'eligible'
        && (slot.activeTaskId === task.id
          || scheduler.claimSlot(input.owner.conversationId, task.id, input.operationId, now));
      if (!admitted) {
        scheduler.enqueueTask(
          task.id,
          input.owner.conversationId,
          now,
          payload.schedulingReason ?? 'conversation_slot_occupied',
          payload,
        );
        status = 'queued';
      } else {
        scheduler.markRunning(task.id, now);
        status = 'authorized';
      }
    }
    if (input.proposalId) {
      this.deps.admissionResults?.record({
        operationId: proposal?.operationId ?? input.operationId,
        proposalId: input.proposalId,
        status,
        reason: input.schedulingReason ?? 'work graph authorized',
        taskId: task.id,
        generationId: input.generationId,
        graphRevision: input.graphRevision,
        detail: status === 'queued'
          ? { schedulingReason: input.schedulingReason ?? 'work graph authorized' }
          : { proposalSource: input.proposalSource },
        appliedAt: new Date().toISOString(),
      });
    }
    return {
      status,
      taskId: task.id,
      schedulingReason: input.schedulingReason,
      replayed: false,
    };
  }
}
