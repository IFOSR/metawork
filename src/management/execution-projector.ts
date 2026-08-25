import type { Subtask, Task } from '../core/types.js';
import type { SubtaskRepo } from '../storage/subtask-repo.js';
import type { ExecutorAttemptReceiptRepo } from '../storage/executor-attempt-receipt-repo.js';
import type { KernelDecisionRepo } from '../storage/kernel-decision-repo.js';
import type { WorkspacePublicationRepo } from '../storage/workspace-publication-repo.js';
import type { ExecutorAttemptRuntimeRepo } from '../storage/executor-attempt-runtime-repo.js';
import type { KernelDispatchItemRepo } from '../storage/kernel-dispatch-item-repo.js';
import { formatExecutorProgress } from '../executor/error-utils.js';

const MAX_TIMELINE_ATTEMPTS_PER_SUBTASK = 20;
const MAX_TIMELINE_PROGRESS_EVENTS_PER_ATTEMPT = 50;
const MAX_TIMELINE_DECISIONS = 200;

// 与 web/src/api/types.ts 同构的前端执行时间线类型。
export type StagePhase = 'planning' | 'authorization' | 'execution' | 'verification' | 'delivery';
export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked';

export interface TimelineProposal {
  subtasks: string[];
  dependencies: string[][];
}

export interface TimelineDecision {
  type: string;
  subtask: string;
  reason: string;
}

export interface TimelineAttempt {
  attemptId?: string;
  result: string;
  status?: string;
  startedAt?: string;
  updatedAt?: string;
  exitCode?: number;
  error?: string;
  progress?: Record<string, unknown>;
  progressHistory?: Array<{
    kind: string;
    text: string;
    occurredAt: string;
  }>;
}

type TimelineProgressEntry = NonNullable<TimelineAttempt['progressHistory']>[number];

export interface TimelineSubtask {
  id: string;
  title: string;
  status: string;
  executor?: string;
  attempts: TimelineAttempt[];
}

export interface TimelineStage {
  phase: StagePhase;
  status: StageStatus;
  proposal?: TimelineProposal;
  decisions?: TimelineDecision[];
  subtasks?: TimelineSubtask[];
}

export interface ExecutionTimeline {
  taskId: string;
  title: string;
  status: string;
  stages: TimelineStage[];
}

export interface ExecutionProjectorDeps {
  subtaskRepo: SubtaskRepo;
  receiptRepo: ExecutorAttemptReceiptRepo;
  decisionRepo: KernelDecisionRepo;
  publicationRepo: WorkspacePublicationRepo;
  attemptRuntimeRepo: ExecutorAttemptRuntimeRepo;
  dispatchItemRepo: KernelDispatchItemRepo;
}

/**
 * 把分散的 durable 事实组合成结构化执行时间线。
 * 纯只读投影，不做任何调度/恢复/语义决策。
 */
export class ExecutionProjector {
  constructor(private readonly deps: ExecutionProjectorDeps) {}

  project(task: Task): ExecutionTimeline {
    const subtasks = this.deps.subtaskRepo.listByTask(task.id);
    const receipts = this.deps.receiptRepo.listByTask(task.id);
    const decisions = this.deps.decisionRepo.listTimelineByTask(
      task.id,
      MAX_TIMELINE_DECISIONS,
    );
    const dispatchItems = this.deps.dispatchItemRepo.listByTask(task.id);

    return {
      taskId: task.id,
      title: task.title,
      status: task.status,
      stages: [
        this.projectPlanning(subtasks),
        this.projectAuthorization(decisions),
        this.projectExecution(subtasks, receipts, dispatchItems),
        this.projectVerification(subtasks, receipts),
        this.projectDelivery(task, subtasks),
      ],
    };
  }

  private projectPlanning(subtasks: Subtask[]): TimelineStage {
    if (subtasks.length === 0) {
      return { phase: 'planning', status: 'pending' };
    }
    return {
      phase: 'planning',
      status: 'done',
      proposal: {
        subtasks: subtasks.map(subtask => subtask.title),
        dependencies: subtasks.flatMap(subtask =>
          subtask.dependencies.map(dependency => [dependency.fromSubtaskId, subtask.id]),
        ),
      },
    };
  }

  private projectAuthorization(
    decisions: ReturnType<KernelDecisionRepo['listTimelineByTask']>,
  ): TimelineStage {
    if (decisions.length === 0) {
      return { phase: 'authorization', status: 'pending' };
    }
    return {
      phase: 'authorization',
      status: 'done',
      decisions: decisions.map(record => ({
        type: record.action,
        subtask: record.subtaskId ?? record.taskId ?? '',
        reason: record.reason,
      })),
    };
  }

  private projectExecution(
    subtasks: Subtask[],
    receipts: ReturnType<ExecutorAttemptReceiptRepo['listByTask']>,
    dispatchItems: ReturnType<KernelDispatchItemRepo['listByTask']>,
  ): TimelineStage {
    if (subtasks.length === 0) {
      return { phase: 'execution', status: 'pending' };
    }

    const statuses = new Set(subtasks.map(subtask => subtask.status));
    let status: StageStatus;
    if (statuses.has('running')) {
      status = 'running';
    } else if (statuses.has('blocked') || statuses.has('awaiting_decision')) {
      status = 'blocked';
    } else if (statuses.has('cancelled')) {
      status = 'failed';
    } else if (statuses.size === 1 && statuses.has('done')) {
      status = 'done';
    } else {
      status = 'running';
    }

    return {
      phase: 'execution',
      status,
      subtasks: subtasks.map(subtask => {
        const subtaskReceipts = receipts.filter(receipt => receipt.subtaskId === subtask.id);
        const subtaskDispatches = dispatchItems.filter(item => item.subtaskId === subtask.id);
        const attemptIds = [...new Set([
          ...subtaskDispatches.map(item => item.attemptId),
          ...subtaskReceipts.map(item => item.attemptId),
        ])].slice(-MAX_TIMELINE_ATTEMPTS_PER_SUBTASK);
        return {
          id: subtask.id,
          title: subtask.title,
          status: subtask.status,
          executor: subtaskDispatches[0]?.authorizedBinding.agentClassRef
            ?? subtaskReceipts[0]?.agentClassName
            ?? subtask.executorBindings[0]?.agentClassRef,
          attempts: attemptIds.map(attemptId => {
            const receipt = subtaskReceipts.find(item => item.attemptId === attemptId);
            const dispatch = subtaskDispatches.find(item => item.attemptId === attemptId);
            const runtime = this.deps.attemptRuntimeRepo.find(attemptId);
            const progressHistory = progressHistoryFrom(runtime?.progress);
            const currentProgress = currentProgressFrom(runtime?.progress);
            return {
              attemptId,
              result: receipt
                ? receipt.terminalState === 'completed' ? 'success' : 'failed'
                : dispatch?.status ?? 'running',
              status: dispatch?.status,
              startedAt: dispatch?.launchStartedAt ?? dispatch?.createdAt,
              updatedAt: dispatch?.updatedAt ?? runtime?.updatedAt,
              error: receipt?.errorDetail
                ?? receipt?.errorCode
                ?? dispatch?.errorSummary
                ?? undefined,
              ...(currentProgress && Object.keys(currentProgress).length > 0
                ? { progress: currentProgress }
                : {}),
              ...(progressHistory.length > 0 ? { progressHistory } : {}),
            };
          }),
        };
      }),
    };
  }

  private projectVerification(
    subtasks: Subtask[],
    receipts: ReturnType<ExecutorAttemptReceiptRepo['listByTask']>,
  ): TimelineStage {
    if (receipts.length === 0) {
      return { phase: 'verification', status: 'pending' };
    }
    const hasViolation = receipts.some(receipt => receipt.verification?.violations?.length > 0);
    if (hasViolation) {
      return { phase: 'verification', status: 'failed' };
    }
    const hasAwaitingIntegration = subtasks.some(subtask => subtask.status === 'awaiting_integration');
    if (hasAwaitingIntegration) {
      return { phase: 'verification', status: 'running' };
    }
    const allDone = subtasks.every(subtask => subtask.status === 'done');
    return { phase: 'verification', status: allDone ? 'done' : 'running' };
  }

  private projectDelivery(task: Task, subtasks: Subtask[]): TimelineStage {
    if (subtasks.length === 0) {
      return { phase: 'delivery', status: 'pending' };
    }
    const integrated = this.deps.publicationRepo.listIntegratedByTaskIds([task.id]);
    if (integrated.length > 0) {
      return { phase: 'delivery', status: 'done' };
    }
    if (this.deps.publicationRepo.hasBlockingResidue(task.id)) {
      return { phase: 'delivery', status: 'blocked' };
    }
    if (task.status === 'done') {
      return { phase: 'delivery', status: 'done' };
    }
    const hasFinishedSubtask = subtasks.some(
      subtask => subtask.status === 'done' || subtask.status === 'awaiting_integration',
    );
    return { phase: 'delivery', status: hasFinishedSubtask ? 'running' : 'pending' };
  }
}

function progressHistoryFrom(
  progress: Record<string, unknown> | undefined,
): TimelineProgressEntry[] {
  if (!Array.isArray(progress?.history)) return [];
  return progress.history
    .filter((entry): entry is TimelineProgressEntry => Boolean(entry)
      && typeof entry === 'object'
      && typeof (entry as Record<string, unknown>).kind === 'string'
      && typeof (entry as Record<string, unknown>).text === 'string'
      && typeof (entry as Record<string, unknown>).occurredAt === 'string')
    .slice(-MAX_TIMELINE_PROGRESS_EVENTS_PER_ATTEMPT)
    .flatMap(entry => {
      const text = formatExecutorProgress(entry.text);
      return text ? [{ ...entry, text }] : [];
    });
}

function currentProgressFrom(
  progress: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!progress) return null;
  const current: Record<string, unknown> = {};
  if (typeof progress.kind === 'string') current.kind = progress.kind;
  if (typeof progress.text === 'string') {
    const text = formatExecutorProgress(progress.text);
    if (text) current.text = text;
  }
  if (typeof progress.occurredAt === 'string') current.occurredAt = progress.occurredAt;
  return current;
}
