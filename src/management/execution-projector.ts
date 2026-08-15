import type { Subtask, Task } from '../core/types.js';
import type { SubtaskRepo } from '../storage/subtask-repo.js';
import type { ExecutorAttemptReceiptRepo } from '../storage/executor-attempt-receipt-repo.js';
import type { KernelDecisionRepo } from '../storage/kernel-decision-repo.js';
import type { WorkspacePublicationRepo } from '../storage/workspace-publication-repo.js';

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
  result: string;
  exitCode?: number;
  error?: string;
}

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
    const decisions = this.deps.decisionRepo.listByTask(task.id);

    return {
      taskId: task.id,
      title: task.title,
      status: task.status,
      stages: [
        this.projectPlanning(subtasks),
        this.projectAuthorization(decisions),
        this.projectExecution(subtasks, receipts),
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
    decisions: ReturnType<KernelDecisionRepo['listByTask']>,
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
        return {
          id: subtask.id,
          title: subtask.title,
          status: subtask.status,
          executor: subtaskReceipts[0]?.agentClassName ?? subtask.executorBindings[0]?.agentClassRef,
          attempts: subtaskReceipts.map(receipt => ({
            result: receipt.terminalState === 'completed' ? 'success' : 'failed',
            error: receipt.errorDetail ?? receipt.errorCode ?? undefined,
          })),
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
