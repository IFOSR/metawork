import type { Task } from '../core/types.js';
import type { TimelineTaskRecord } from '../storage/task-repo.js';
import type { SubtaskRepo, TimelineSubtaskRecord } from '../storage/subtask-repo.js';
import type { ExecutorAttemptReceiptRepo, TimelineReceiptRecord } from '../storage/executor-attempt-receipt-repo.js';
import type { KernelDecisionRepo } from '../storage/kernel-decision-repo.js';
import type { WorkspacePublicationRepo } from '../storage/workspace-publication-repo.js';
import type { ExecutorAttemptRuntimeRepo, TimelineRuntimeRecord } from '../storage/executor-attempt-runtime-repo.js';
import type { KernelDispatchItemRepo, TimelineDispatchItemRecord } from '../storage/kernel-dispatch-item-repo.js';
import { formatExecutorProgress } from '../executor/error-utils.js';
import type { KernelAttemptKind } from '../kernel/control-kernel.js';
import type { ConfigurationSnapshot } from '../configuration/types.js';
import { resolvePublicRoutingIdentity } from '../configuration/public-routing-identity.js';

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
  attemptKind: KernelAttemptKind;
  attemptOrdinal: number;
  attemptLabel: string;
  displayStatus: '等待启动' | '执行中' | '已完成' | '失败' | '已取消' | '状态未知';
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
  harness?: string;
  provider?: string;
  model?: string;
  harnessDisplayName?: string;
  providerDisplayName?: string;
  modelDisplayName?: string;
  configurationRevision?: string;
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
  /** Revision-pinned configuration used to render historical public names. */
  configurationByRevision?: ReadonlyMap<string, ConfigurationSnapshot>;
}

/**
 * 把分散的 durable 事实组合成结构化执行时间线。
 * 纯只读投影，不做任何调度/恢复/语义决策。
 */
export class ExecutionProjector {
  constructor(private readonly deps: ExecutionProjectorDeps) {}

  projectMany(tasks: readonly TimelineTaskRecord[]): ReadonlyMap<string, ExecutionTimeline> {
    if (!tasks.length) return new Map();
    const ids = [...new Set(tasks.map(task => task.id))];
    const subtasks = groupByTask(this.deps.subtaskRepo.listTimelineByTasks(ids));
    const receipts = groupByTask(this.deps.receiptRepo.listTimelineByTasks(ids));
    const decisions = groupByTask(this.deps.decisionRepo.listTimelineByTasks(ids, MAX_TIMELINE_DECISIONS));
    const dispatches = groupByTask(this.deps.dispatchItemRepo.listTimelineByTasks(ids));
    const runtimes = new Map(this.deps.attemptRuntimeRepo.listTimelineByTasks(ids).map(runtime => [runtime.attemptId, runtime]));
    const publications = this.deps.publicationRepo.timelineByTaskIds(ids);
    return new Map(tasks.map(task => [task.id, this.projectFacts(
      task, subtasks.get(task.id) ?? [], receipts.get(task.id) ?? [],
      decisions.get(task.id) ?? [], dispatches.get(task.id) ?? [],
      attemptId => runtimes.get(attemptId) ?? null, publications.get(task.id) ?? { integrated: false, blocking: false },
    )]));
  }

  project(task: Task): ExecutionTimeline {
    const subtasks = this.deps.subtaskRepo.listByTask(task.id);
    const receipts = this.deps.receiptRepo.listByTask(task.id).map(receipt => ({
      ...receipt,
      hasViolations: receipt.verification?.violations?.length > 0,
    }));
    const decisions = this.deps.decisionRepo.listTimelineByTask(
      task.id,
      MAX_TIMELINE_DECISIONS,
    );
    const dispatchItems = this.deps.dispatchItemRepo.listByTask(task.id);
    return this.projectFacts(task, subtasks, receipts, decisions, dispatchItems,
      attemptId => this.deps.attemptRuntimeRepo.find(attemptId));
  }

  private projectFacts(
    task: TimelineTaskRecord,
    subtasks: TimelineSubtaskRecord[],
    receipts: TimelineReceiptRecord[],
    decisions: ReturnType<KernelDecisionRepo['listTimelineByTask']>,
    dispatchItems: TimelineDispatchItemRecord[],
    runtimeFor: (attemptId: string) => TimelineRuntimeRecord | null,
    publication?: { integrated: boolean; blocking: boolean },
  ): ExecutionTimeline {
    return {
      taskId: task.id,
      title: task.title,
      status: task.status === 'blocked'
        && task.dependencies.some(dependency =>
          dependency.type === 'kernel_retry' && dependency.status === 'waiting'
        )
        ? 'waiting_retry'
        : task.status,
      stages: [
        this.projectPlanning(subtasks),
        this.projectAuthorization(decisions),
        this.projectExecution(subtasks, receipts, dispatchItems, runtimeFor),
        this.projectVerification(subtasks, receipts),
        this.projectDelivery(task, subtasks, publication),
      ],
    };
  }

  private projectPlanning(subtasks: TimelineSubtaskRecord[]): TimelineStage {
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
    subtasks: TimelineSubtaskRecord[],
    receipts: TimelineReceiptRecord[],
    dispatchItems: TimelineDispatchItemRecord[],
    runtimeFor: (attemptId: string) => TimelineRuntimeRecord | null,
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
        const binding = subtaskDispatches[0]?.authorizedBinding
          ?? subtaskReceipts[0]?.authorizedBinding;
        const identity = binding
          ? historicalPublicIdentity(this.deps.configurationByRevision, binding)
          : null;
        const capturedIdentity = binding && binding.modelDisplayName
          ? {
              executorDisplayName: binding.executorDisplayName,
              harnessDisplayName: binding.harnessDisplayName,
              providerDisplayName: binding.providerDisplayName,
              modelDisplayName: binding.modelDisplayName,
            }
          : null;
        return {
          id: subtask.id,
          title: subtask.title,
          status: subtask.status,
          executor: subtaskDispatches[0]?.authorizedBinding.agentClassRef
            ?? subtaskReceipts[0]?.agentClassName
            ?? subtask.executorBindings[0]?.agentClassRef,
          ...(binding ? {
            configurationRevision: binding.configurationRevision,
            harnessDisplayName: capturedIdentity?.harnessDisplayName
              ?? identity?.harnessDisplayName ?? '历史配置不可用',
            providerDisplayName: capturedIdentity?.providerDisplayName
              ?? identity?.providerDisplayName ?? '历史配置不可用',
            modelDisplayName: capturedIdentity?.modelDisplayName
              ?? identity?.modelDisplayName ?? '历史模型信息不可用',
          } : {}),
          attempts: attemptIds.map((attemptId, attemptIndex) => {
            const receipt = subtaskReceipts.find(item => item.attemptId === attemptId);
            const dispatch = subtaskDispatches.find(item => item.attemptId === attemptId);
            const runtime = runtimeFor(attemptId);
            const progressHistory = progressHistoryFrom(runtime?.progress);
            const currentProgress = currentProgressFrom(runtime?.progress);
            const attemptKind = dispatch?.attemptKind ?? receipt?.attemptKind ?? 'primary';
            return {
              attemptId,
              attemptKind,
              attemptOrdinal: attemptIndex + 1,
              attemptLabel: attemptLabel(attemptKind),
              displayStatus: displayAttemptStatus(dispatch?.status, receipt?.terminalState),
              result: receipt
                ? receipt.terminalState === 'completed' ? 'success' : 'failed'
                : dispatch?.status ?? 'running',
              status: dispatch?.status,
              startedAt: dispatch?.launchStartedAt ?? dispatch?.createdAt,
              updatedAt: latestTimestamp(
                receipt?.completedAt,
                dispatch?.updatedAt,
                runtime?.updatedAt,
                currentProgressFrom(runtime?.progress)?.occurredAt as string | undefined,
                progressHistory.at(-1)?.occurredAt,
              ),
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
    subtasks: TimelineSubtaskRecord[],
    receipts: TimelineReceiptRecord[],
  ): TimelineStage {
    if (receipts.length === 0) {
      return { phase: 'verification', status: 'pending' };
    }
    const hasViolation = receipts.some(receipt => receipt.hasViolations);
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

  private projectDelivery(task: TimelineTaskRecord, subtasks: TimelineSubtaskRecord[], publication?: { integrated: boolean; blocking: boolean }): TimelineStage {
    if (subtasks.length === 0) {
      return { phase: 'delivery', status: 'pending' };
    }
    const integrated = publication?.integrated ?? (this.deps.publicationRepo.listIntegratedByTaskIds([task.id]).length > 0);
    if (integrated) {
      return { phase: 'delivery', status: 'done' };
    }
    if (publication?.blocking ?? this.deps.publicationRepo.hasBlockingResidue(task.id)) {
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

function groupByTask<T extends { taskId: string | null }>(items: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    if (!item.taskId) continue;
    const group = grouped.get(item.taskId) ?? [];
    group.push(item);
    grouped.set(item.taskId, group);
  }
  return grouped;
}

function historicalPublicIdentity(
  configurations: ReadonlyMap<string, ConfigurationSnapshot> | undefined,
  binding: NonNullable<TimelineDispatchItemRecord['authorizedBinding']>,
) {
  const configuration = configurations?.get(binding.configurationRevision);
  if (!configuration) return null;
  return resolvePublicRoutingIdentity(configuration, binding);
}

function attemptLabel(kind: KernelAttemptKind): string {
  const labels: Record<KernelAttemptKind, string> = {
    primary: '主执行',
    continuation: '继续执行',
    fallback: '回退执行',
    contract_correction: '结果修正',
    merge_repair: '合并修复',
  };
  return labels[kind];
}

function displayAttemptStatus(
  dispatchStatus: string | undefined,
  terminalState: string | undefined,
): TimelineAttempt['displayStatus'] {
  if (terminalState === 'completed') return '已完成';
  if (terminalState === 'cancelled_or_stale') return '已取消';
  if (terminalState) return '失败';
  if (dispatchStatus === 'pending_launch' || dispatchStatus === 'launching') return '等待启动';
  if (dispatchStatus === 'running' || dispatchStatus === 'cancelling') return '执行中';
  if (dispatchStatus === 'terminal') return '已完成';
  if (dispatchStatus === 'cancelled') return '已取消';
  if (dispatchStatus === 'uncertain') return '状态未知';
  return dispatchStatus ? '状态未知' : '等待启动';
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

function latestTimestamp(...values: Array<string | undefined>): string | undefined {
  const valid = values.filter((value): value is string => (
    typeof value === 'string' && Number.isFinite(Date.parse(value))
  ));
  return valid.sort((left, right) => Date.parse(right) - Date.parse(left))[0]
    ?? values.find(value => typeof value === 'string');
}
