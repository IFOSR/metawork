import type { ConversationTurnProjection } from './api/session-types';
import type { ExecutionTimeline } from './api/types';
import { isTaskStatus, taskStatusLabel, type TaskStatus } from './task-status';
import { projectTurnForPresentation } from './turn-task-presentation';

/**
 * Names the fact each Turn conclusion actually describes.
 *
 * A Planner answer, a queued Task and an executing Attempt are different
 * entities with different completion facts. They must never impersonate each
 * other in a card, so every surface reads its label and duration from this
 * projection instead of mapping Turn status alone
 * (2026-10-28 transparent execution §status and trajectory consistency).
 */
export type TurnExecutionPhase =
  | 'planning'
  | 'queued'
  | 'executing'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export interface TurnExecutionPresentation {
  /** Durable execution entity of this Turn, when one exists. */
  taskId: string | null;
  phase: TurnExecutionPhase;
  /**
   * The Task's canonical six-state conclusion, when this Turn owns a Task.
   * `label` is derived from it, so every surface names the same status.
   */
  taskStatus: TaskStatus | null;
  /** Task status label (six states) or the plannner-only phase label. */
  label: string;
  /** An Attempt reported a real execution start (Runtime/Attempt fact). */
  executionStarted: boolean;
  /** End-to-end Turn duration; null when no real completion time exists. */
  turnDurationMs: number | null;
  /** Planner-only duration; null for Turns that own execution. */
  planningDurationMs: number | null;
  /** Measured execution duration; null when nothing was measured. */
  executionDurationMs: number | null;
}

/**
 * Planner-only Turns own no Task, so they name the Turn phase instead of a task
 * status. A Turn that owns a Task always uses the six-state label.
 */
const PHASE_LABEL: Record<TurnExecutionPhase, string> = {
  planning: '已完成规划，未启动执行',
  queued: '尚未开始执行',
  executing: '尚未开始执行',
  completed: '尚未开始执行',
  blocked: '尚未开始执行',
  failed: '尚未开始执行',
  cancelled: '尚未开始执行',
};

export function turnExecutionPresentation(
  turn: ConversationTurnProjection,
  nowMs: number = Date.now(),
): TurnExecutionPresentation {
  const projected = projectTurnForPresentation(turn);
  const timeline = projected.executionTimeline;
  const attempts = timeline ? timelineAttempts(timeline) : [];
  const executionStarted = attempts.some(attempt => Boolean(attempt.executionStartedAt));
  const executionDurationMs = measuredExecutionDurationMs(attempts, nowMs);
  const startedMs = parseTime(turn.startedAt);
  const completedMs = parseTime(turn.completedAt);
  const turnDurationMs = startedMs !== null && completedMs !== null && completedMs >= startedMs
    ? completedMs - startedMs
    : null;
  const phase = turnPhase(turn, timeline, executionStarted, projected.taskId);
  // A Turn that owns a Task names that Task's conclusion with the single
  // six-state vocabulary. Only a planner-only Turn uses a phase label, and a
  // Task whose status fact is not loaded yet shows no label instead of
  // inventing one from the Turn/trace status.
  const taskStatus = projected.taskId && timeline && isTaskStatus(timeline.status)
    ? timeline.status
    : null;
  const label = projected.taskId
    ? taskStatusLabel(taskStatus) ?? ''
    : phaseLabel(phase, turn);

  return {
    taskId: projected.taskId,
    phase,
    taskStatus,
    label,
    executionStarted,
    turnDurationMs,
    planningDurationMs: projected.taskId === null ? turnDurationMs : null,
    executionDurationMs,
  };
}

function phaseLabel(phase: TurnExecutionPhase, turn: ConversationTurnProjection): string {
  if (phase === 'planning' && turn.status === 'running') return '正在规划';
  return PHASE_LABEL[phase];
}

function turnPhase(
  turn: ConversationTurnProjection,
  timeline: ExecutionTimeline | null,
  executionStarted: boolean,
  taskId: string | null,
): TurnExecutionPhase {
  // Terminal Turn facts win: they describe the whole Turn, including a Planner
  // failure that never reached execution.
  if (turn.status === 'failed') return 'failed';
  if (turn.status === 'cancelled') return 'cancelled';
  if (turn.status === 'blocked') return 'blocked';
  if (turn.status === 'running') {
    return executionStarted ? 'executing' : taskId ? 'queued' : 'planning';
  }
  // A completed Turn with no execution entity is planning work, not a Task that
  // finished. Any real execution fact settles the Turn as completed.
  if (!taskId && !timeline) return 'planning';
  if (executionStarted) return 'completed';
  if (timeline?.status === 'needs_action') return 'blocked';
  if (timeline?.status === 'failed') return 'failed';
  if (timeline?.status === 'cancelled') return 'cancelled';
  if (timeline?.status === 'queued' || timeline?.status === 'running') return 'queued';
  if (timeline?.status === 'succeeded') return 'completed';
  // A completed Turn that owns a Task but has no loaded timeline still owns an
  // execution entity: it is not a planner-only Turn.
  return taskId ? 'completed' : 'planning';
}

function timelineAttempts(timeline: ExecutionTimeline) {
  return (timeline.stages
    .find(stage => stage.phase === 'execution')?.subtasks ?? [])
    .flatMap(subtask => subtask.attempts);
}

function measuredExecutionDurationMs(
  attempts: ReadonlyArray<{
    executionStartedAt?: string;
    executionCompletedAt?: string;
    displayStatus?: string;
  }>,
  nowMs: number,
): number | null {
  let measured = 0;
  let found = false;
  for (const attempt of attempts) {
    const startedMs = parseTime(attempt.executionStartedAt);
    if (startedMs === null) continue;
    const completedMs = parseTime(attempt.executionCompletedAt);
    const endMs = completedMs ?? (attempt.displayStatus === '执行中' ? nowMs : null);
    if (endMs === null || endMs < startedMs) continue;
    measured += endMs - startedMs;
    found = true;
  }
  return found ? measured : null;
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
