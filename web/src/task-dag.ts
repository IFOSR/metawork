import type {
  ExecutionTimeline,
  InteractionTraceEvent,
  SubtaskCard,
  WorkGraphPresentationProjection,
} from './api/types';
import { formatExecutionDuration } from './execution-duration';
import { markdownPreview } from './markdown-preview';
import type { ExecutorActivityState } from './executor-health';
import { userFacingBlockReason } from './block-reason';
import { traceEventTaskId } from './turn-task-presentation';

/**
 * Task DAG derivation.
 *
 * These functions are the single owner of "what is this Subtask doing right
 * now": they were lifted out of the retired execution-card panel so the DAG
 * node, its header summary and the detail drawer all read one derivation.
 */

export interface ExecutionCard {
  subtaskId: string;
  /** Attempt whose live fields are currently projected into this card. */
  activeAttemptId: string | null;
  subtaskTitle: string;
  executorDisplayName: string;
  harnessDisplayName: string;
  providerDisplayName: string;
  modelDisplayName: string;
  stepLabel: string;
  stepKey: string;
  progress: number | null;
  /** Scheduler attempt time; never presented as execution duration. */
  startedAt: string | null;
  /** Real execution window from Attempt runtime/receipt facts. */
  executionStartedAt: string | null;
  executionCompletedAt: string | null;
  updatedAt: string | null;
  lastProgressAt: string | null;
  lastActivityAt: string | null;
  healthText: string | null;
  activityStatus: string;
  activityState: ExecutorActivityState | null;
  state: ExecutionCardState;
}

/**
 * Card state drives both the visual treatment and an execution-state badge.
 *
 * The badge reports what the Subtask's execution is doing — it never claims a
 * Task conclusion. The Task's six-state status stays authoritative; the badge
 * exists because a finished card otherwise looked identical to a running one
 * (same border, frozen timer, no label), which users read as "stuck".
 */
export type ExecutionCardState = 'completed' | 'running' | 'waiting' | 'blocked' | 'failed' | 'unknown';

/** Short execution-state label rendered in the card header. */
export const EXECUTION_STATE_LABEL: Record<ExecutionCardState, string> = {
  completed: '已完成',
  running: '执行中',
  waiting: '等待中',
  blocked: '已阻塞',
  failed: '已失败',
  unknown: '状态待确认',
};

export function preparationStatus(
  card: ExecutionCard,
  nowMs: number,
  completed: boolean,
): { level: 'info' | 'warning'; label: string; detail: string } | null {
  if (completed || !card.stepLabel || !/准备|上下文|权限与能力服务|启动 Executor/u.test(card.stepLabel)) return null;
  const startedMs = card.startedAt ? Date.parse(card.startedAt) : NaN;
  const elapsedSeconds = Number.isFinite(startedMs) ? Math.max(0, Math.floor((nowMs - startedMs) / 1_000)) : 0;
  if (elapsedSeconds >= 30) {
    return {
      level: 'warning',
      label: '准备阶段已超过 30 秒',
      detail: 'Executor 仍未启动，可能卡在工作区、输入资料或权限服务初始化；可展开执行详情查看。',
    };
  }
  return {
    level: 'info',
    label: 'Executor 尚未启动',
    detail: '正在创建工作区、整理输入资料并生成执行上下文。',
  };
}

export function collectExecutionCards(
  events: InteractionTraceEvent[],
  timeline: ExecutionTimeline | null,
  workGraph?: WorkGraphPresentationProjection | null,
): ExecutionCard[] {
  const bySubtask = new Map<string, ExecutionCard>();
  const titleBySubtask = new Map(workGraph?.nodes.map(node => [node.id, node.title]) ?? []);
  const executionStage = timeline?.stages.find(stage => stage.phase === 'execution');
  const dependencies = timeline?.stages.find(stage => stage.phase === 'planning')?.proposal?.dependencies ?? [];
  for (const subtask of executionStage?.subtasks ?? []) {
    const attempt = subtask.attempts.at(-1);
    const latest = attempt?.progressHistory?.at(-1);
    // An Attempt that yielded before executing (no runtime fact, nothing
    // pending) must not claim the Executor started.
    const attemptExecuted = Boolean(attempt?.executionStartedAt)
      || attempt?.displayStatus === '执行中'
      || attempt?.displayStatus === '已完成';
    const subtaskTitle = titleBySubtask.get(subtask.id)
      || presentationTitle(subtask.title, timeline?.title);
    const waitingFor = dependencies.filter(([, target]) => target === subtask.id)
      .map(([source]) => executionStage?.subtasks?.find(candidate => candidate.id === source)?.title)
      .filter(Boolean);
    bySubtask.set(subtask.id, {
      subtaskId: subtask.id,
      activeAttemptId: attempt?.attemptId ?? null,
      subtaskTitle,
      executorDisplayName: subtask.executor || '',
      harnessDisplayName: subtask.harnessDisplayName || subtask.harness || '',
      providerDisplayName: subtask.providerDisplayName || subtask.provider || '',
      modelDisplayName: subtask.modelDisplayName || subtask.model || '',
      stepLabel: latest?.text || (attemptExecuted ? '执行器已启动，等待实际进度…'
        : waitingFor.length ? `尚未启动，等待：${waitingFor.join('、')}` : '尚未启动，等待前置结果或调度'),
      stepKey: latest?.kind || 'executor_waiting',
      progress: null,
      startedAt: attempt?.startedAt ?? null,
      executionStartedAt: attempt?.executionStartedAt ?? null,
      executionCompletedAt: attempt?.executionCompletedAt ?? null,
      updatedAt: attempt?.updatedAt ?? null,
      lastProgressAt: latest?.occurredAt ?? attempt?.startedAt ?? null,
      lastActivityAt: null,
      healthText: null,
      activityStatus: attempt?.status ?? attempt?.result ?? subtask.status,
      activityState: null,
      state: executionCardState(subtask.status, attempt),
    });
  }
  for (const event of events) {
    const eventTaskId = traceEventTaskId(event);
    if (timeline?.taskId && eventTaskId && eventTaskId !== timeline.taskId) continue;
    const details = event.details as Record<string, unknown>;
    if (!details || typeof details !== 'object') continue;
    const subtaskId = event.subtaskId || readString(details.subtaskId);
    if (!subtaskId) continue;
    const current = bySubtask.get(subtaskId);
    if (timeline && !current) continue;
    const eventAttemptId = event.attemptId || readString(details.attemptId) || null;
    // A retry keeps the same Subtask card while creating a new Attempt. Older
    // terminal events remain useful in the detail drawer, but must not
    // overwrite the current Attempt's step/status in the live card.
    if (current?.activeAttemptId && eventAttemptId && eventAttemptId !== current.activeAttemptId) continue;
    const existing = current ?? {
      subtaskId,
      activeAttemptId: eventAttemptId,
      subtaskTitle: '',
      executorDisplayName: '',
      harnessDisplayName: '',
      providerDisplayName: '',
      modelDisplayName: '',
      stepLabel: '',
      stepKey: '',
      progress: null as number | null,
      startedAt: null as string | null,
      executionStartedAt: null as string | null,
      executionCompletedAt: null as string | null,
      updatedAt: null as string | null,
      lastProgressAt: null as string | null,
      lastActivityAt: null as string | null,
      healthText: null as string | null,
      activityStatus: event.kind,
      activityState: null as ExecutorActivityState | null,
      state: stateFromTraceEvent(event),
    };
    // 事件按 sequence 有序，后到的事实覆盖先到的字段。
    const next: ExecutionCard = {
      ...existing,
      activeAttemptId: existing.activeAttemptId ?? eventAttemptId,
      subtaskTitle: titleBySubtask.get(subtaskId)
        || existing.subtaskTitle
        || presentationTitle(readString(details.subtaskTitle) || subtaskId, timeline?.title),
      executorDisplayName: readString(details.executorDisplayName)
        || readString(details.executorName)
        || existing.executorDisplayName,
      harnessDisplayName: readString(details.harnessDisplayName) || existing.harnessDisplayName,
      providerDisplayName: readString(details.providerDisplayName) || existing.providerDisplayName,
      modelDisplayName: readString(details.modelDisplayName) || existing.modelDisplayName,
      // Health facts describe liveness, never the current step: they must not
      // overwrite what the Subtask is actually doing.
      stepKey: event.kind === 'executor_health' ? existing.stepKey : readString(details.stepKey) || existing.stepKey,
      stepLabel: event.kind === 'executor_health'
        ? existing.stepLabel
        : readString(details.stepLabel) || event.title || existing.stepLabel,
      progress: typeof details.progress === 'number' && Number.isFinite(details.progress)
        ? details.progress
        : existing.progress,
      startedAt: typeof details.startedAt === 'string'
        ? details.startedAt
        : existing.startedAt ?? event.occurredAt,
      updatedAt: latestTimestamp(
        existing.updatedAt,
        typeof details.updatedAt === 'string' ? details.updatedAt : undefined,
        event.occurredAt,
      ),
      lastProgressAt: latestTimestamp(existing.lastProgressAt,
        typeof details.lastProgressAt === 'string' ? details.lastProgressAt
          : event.kind === 'executor_progress' && !details.operationObservation && !details.operationHealth ? event.occurredAt : undefined),
      lastActivityAt: latestTimestamp(existing.lastActivityAt,
        operationLastActivity(details.operationHealth),
        typeof details.lastActivityAt === 'string' ? details.lastActivityAt : undefined,
        event.kind === 'executor_progress' && !details.operationObservation && !details.operationHealth ? event.occurredAt : undefined),
      healthText: 'operationHealth' in details ? operationHealthText(details.operationHealth) : existing.healthText,
      activityStatus: activityStatusFor(event),
      activityState: executorActivityState(details.activityState),
    };
    bySubtask.set(subtaskId, next);
  }
  // A blocked Task's current reason outranks an older yield step: the card must
  // not keep narrating "waiting for a resource partition" when the Task is now
  // blocked on something else entirely (for example the official-account gate).
  const blockReason = timeline && timeline.status === 'needs_action' && timeline.reasonCode !== 'none'
    ? userFacingBlockReason(timeline.reasonMessage ?? timeline.explanation)
    : '';
  return [...bySubtask.values()].map(card => {
    const settled = settleTerminalStep(card);
    if (!blockReason || settled.state === 'completed' || settled.state === 'failed') return settled;
    return {
      ...settled,
      stepKey: 'task_blocked',
      stepLabel: blockReason,
      activityStatus: 'blocked',
      healthText: null,
    };
  });
}

/**
 * A settled card must not narrate work in progress.
 *
 * The verification handoff event (`executor_result_observed`) carries
 * `stepLabel: "正在校验 … 的执行结果"` because at that moment verification is
 * indeed pending. It stays the newest labelled event, so a card whose Subtask
 * and receipt already settled would otherwise read "已完成" and "正在校验" at the
 * same time. Terminal state wins: the label becomes a completed fact.
 */
function settleTerminalStep(card: ExecutionCard): ExecutionCard {
  if (card.state !== 'completed' && card.state !== 'failed') return card;
  card = { ...card, healthText: null, activityState: null,
    activityStatus: card.state === 'completed' ? 'completed' : 'failed', progress: null };
  const label = card.stepLabel.trim();
  const inFlight = /^(正在|等待|尚未|已启动|执行器已启动|Executor progress:|Executing Subtask:)/u.test(label);
  if (card.state === 'failed') {
    return inFlight ? { ...card, stepKey: 'executor_settled', stepLabel: '执行失败，详情见执行详情' } : card;
  }
  if (card.stepKey === 'executor_verifying') {
    const executor = card.executorDisplayName ? `${card.executorDisplayName} 的` : '';
    return { ...card, stepKey: 'executor_settled', stepLabel: `已完成校验${executor}执行结果` };
  }
  return inFlight ? { ...card, stepKey: 'executor_settled', stepLabel: '执行完成' } : card;
}

function operationLastActivity(value: unknown): string | null {
  return value && typeof value === 'object' && typeof (value as { lastActivityAt?: unknown }).lastActivityAt === 'string'
    ? (value as { lastActivityAt: string }).lastActivityAt : null;
}

function executionCardState(
  subtaskStatus: string,
  attempt: SubtaskCard['attempts'][number] | undefined,
): ExecutionCardState {
  // The Subtask is the canonical scheduling fact and decides the card's main
  // state. An Attempt only refines detail: a dispatch item that yielded (no
  // receipt) must not dress a `ready` Subtask up as completed.
  if (subtaskStatus === 'done') return 'completed';
  if (subtaskStatus === 'failed' || subtaskStatus === 'cancelled') return 'failed';
  if (subtaskStatus === 'blocked' || subtaskStatus === 'awaiting_decision') return 'blocked';
  if (subtaskStatus === 'running') {
    return attempt?.displayStatus === '已完成' ? 'waiting' : 'running';
  }
  if (subtaskStatus === 'ready' || subtaskStatus === 'awaiting_integration') return 'waiting';
  if (attempt?.displayStatus === '执行中' || attempt?.status === 'running') return 'running';
  if (attempt?.displayStatus === '未执行' || attempt?.displayStatus === '等待启动') return 'waiting';
  return 'unknown';
}

function stateFromTraceEvent(event: InteractionTraceEvent): ExecutionCardState {
  // The canonical card state comes from the Subtask/timeline. A trace event only
  // seeds this while the card has no timeline yet, so it claims nothing.
  if (event.kind.endsWith('_failed')) return 'failed';
  if (event.kind.includes('blocked') || event.kind === 'clarification_requested') return 'blocked';
  return 'unknown';
}

function activityStatusFor(event: InteractionTraceEvent): string {
  if (event.kind === 'executor_heartbeat') return 'heartbeat';
  if (event.kind === 'dependency_wait') return 'dependency_wait';
  if (event.kind === 'capacity_wait') return 'capacity_wait';
  if (event.kind.includes('blocked')) return 'blocked';
  if (event.kind.endsWith('_failed')) return 'failed';
  if (/\(completed\)$|[:_]completed$/u.test(event.kind)) return 'completed';
  // A progress line carries no outcome of its own; while the panel is live it is
  // the running activity.
  return 'active';
}

export function isActiveActivity(status: string): boolean {
  return ['active', 'running', 'heartbeat', 'dependency_wait', 'capacity_wait'].includes(status);
}

export function activityLabel(status: string, step: string): string {
  if (status === 'heartbeat') return '执行尚未结束，暂无新的实际进度';
  if (status === 'dependency_wait') return `等待依赖：${step}`;
  if (status === 'capacity_wait') return `等待容量：${step}`;
  if (status === 'blocked') return `已阻塞：${step}`;
  return step;
}

function operationHealthText(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const state = (value as { state?: string }).state;
  if (state === 'waiting') return '暂无新进展，等待执行活动';
  if (state === 'checking') return '持续无活动，正在检查执行状态';
  if (state === 'unknown') return '执行状态待确认：暂无可验证的工作状态；可继续等待或取消任务';
  if (state === 'unresponsive') return '操作检查未响应，状态待处理';
  if (state === 'exited') return '执行进程已退出，正在收集结果';
  return null;
}

function executorActivityState(value: unknown): ExecutorActivityState | null {
  return value === 'active_operation'
    || value === 'presentation_heartbeat'
    || value === 'idle'
    ? value
    : null;
}

function latestTimestamp(...values: Array<string | null | undefined>): string | null {
  const valid = values.filter((value): value is string => (
    typeof value === 'string' && Number.isFinite(Date.parse(value))
  ));
  return valid.sort((left, right) => Date.parse(right) - Date.parse(left))[0]
    ?? values.find(value => typeof value === 'string')
    ?? null;
}

function readString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : '';
}

function presentationTitle(value: string, taskTitle?: string): string {
  if (!looksLikeInternalSubtaskId(value)) return value;
  return taskTitle && !looksLikeInternalTaskId(taskTitle) ? taskTitle : value;
}

function looksLikeInternalSubtaskId(value: string): boolean {
  return /^task_[a-z0-9_-]+_r\d+_/iu.test(value);
}

function looksLikeInternalTaskId(value: string): boolean {
  return /^task_[a-z0-9_-]+$/iu.test(value);
}

/** One node's live execution detail, rendered inside the DAG node. */
export interface TaskDagNodeDetail {
  /** 执行中 / 已完成 / 等待中 / 已阻塞 / 已失败 / 状态待确认 */
  statusLabel: string;
  /** Executor · Provider/Model */
  binding: string;
  /** Current step or the reason it has not started. */
  step: string;
  /** Elapsed execution text, empty when there is nothing to time. */
  elapsed: string;
}

/** Header facts for the task DAG: where the work is and how much is done. */
export interface TaskDagSummary {
  state: ExecutionCardState;
  headline: string;
  detail: string;
}

export function taskDagNodeDetails(
  cards: readonly ExecutionCard[],
  nowMs: number,
  completed: boolean,
): Map<string, TaskDagNodeDetail> {
  const details = new Map<string, TaskDagNodeDetail>();
  for (const card of cards) {
    const running = !completed && isActiveActivity(card.activityStatus);
    const elapsed = formatExecutionDuration({
      executionStartedAt: card.executionStartedAt,
      executionCompletedAt: card.executionCompletedAt,
      updatedAt: card.updatedAt,
      running,
      nowMs,
    });
    const binding = [card.executorDisplayName, [card.providerDisplayName, card.modelDisplayName]
      .filter(Boolean).join('/')].filter(Boolean).join(' · ');
    const preparation = preparationStatus(card, nowMs, completed);
    // The node shows what the Subtask is doing; a health observation is appended
    // as a secondary signal instead of replacing the step it describes.
    const stepText = preparation
      ? `${preparation.label}：${preparation.detail}`
      : card.stepLabel || activityLabel(card.activityStatus, '');
    const health = card.healthText && card.healthText !== stepText ? card.healthText : '';
    details.set(card.subtaskId, {
      statusLabel: EXECUTION_STATE_LABEL[card.state],
      binding: binding || '尚未选定执行器',
      // A DAG node is a one-line surface: flatten Markdown instead of printing it.
      step: markdownPreview([stepText, health].filter(Boolean).join(' · '), 200),
      elapsed: elapsed ?? '',
    });
  }
  return details;
}

export function taskDagSummary(input: {
  cards: readonly ExecutionCard[];
  subtaskCount: number;
  turnStatus: string;
  artifactCount?: number;
}): TaskDagSummary {
  const { cards } = input;
  const total = Math.max(input.subtaskCount, cards.length);
  const done = cards.filter(card => card.state === 'completed').length;
  const failed = cards.filter(card => card.state === 'failed').length;
  const blocked = cards.filter(card => card.state === 'blocked').length;
  const running = cards.filter(card => card.state === 'running').length;
  const state: ExecutionCardState = failed > 0 ? 'failed'
    : blocked > 0 ? 'blocked'
      : running > 0 ? 'running'
        : total > 0 && done >= total ? 'completed'
          : 'waiting';
  const progress = total > 0 ? `已完成 ${done}/${total}` : '等待拆解子任务';
  const artifacts = input.artifactCount ?? 0;
  switch (state) {
    case 'failed':
      return { state, headline: '执行失败', detail: `${progress} · 失败 ${failed} 项` };
    case 'blocked':
      return { state, headline: '已阻塞，等待处理', detail: `${progress} · 阻塞 ${blocked} 项` };
    case 'running':
      return { state, headline: 'Executor 执行中', detail: `${progress} · 执行中 ${running} 项` };
    case 'completed':
      return { state, headline: '已完成', detail: artifacts > 0 ? `${progress} · 产物 ${artifacts} 个` : progress };
    default:
      return { state, headline: '等待执行', detail: progress };
  }
}
