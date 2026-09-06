import type { InteractionTraceEvent } from '../management/interaction-trace.js';
import {
  createTaskActivityTracker,
  taskActivityHealthLabel,
} from '../gateway/task-activity-tracker.js';

/**
 * L5 — instant natural-language/slash-command status snapshot.
 *
 * Builds the `/status` reply (also usable for Planner-routed "进展如何"
 * utterances) from the current interaction trace without touching the
 * Planner or waiting for in-flight work.
 */
export function buildTaskStatusLines(input: {
  taskTitle: string | null;
  taskStatus: string | null;
  /** Turn/task start timestamp (ISO); used for elapsed time. */
  startedAt: string | null;
  traceEvents: InteractionTraceEvent[];
  nowMs?: number;
}): string[] {
  const nowMs = input.nowMs ?? Date.now();
  const tracker = createTaskActivityTracker();
  for (const event of input.traceEvents) tracker.consume(event);
  const snapshot = tracker.snapshot();
  const health = tracker.health(nowMs);

  if (!input.taskTitle && snapshot.lastActivityAt === null) {
    return ['📊 当前没有正在执行的任务。'];
  }

  const lines: string[] = ['📊 任务状态（即时快照）'];
  if (input.taskTitle) {
    lines.push(`- 任务：${input.taskTitle}${input.taskStatus ? `（${input.taskStatus}）` : ''}`);
  }
  if (input.startedAt) {
    const startedMs = Date.parse(input.startedAt);
    if (!Number.isNaN(startedMs)) {
      const elapsedMinutes = Math.max(0, Math.round((nowMs - startedMs) / 60_000));
      lines.push(`- 已用时：约 ${elapsedMinutes} 分钟`);
    }
  }
  if (snapshot.currentSubtask) lines.push(`- 当前子任务：${snapshot.currentSubtask}`);
  if (snapshot.currentStep) lines.push(`- 当前步骤：${snapshot.currentStep}`);
  if (snapshot.stepCount > 0) lines.push(`- 已完成步骤：${snapshot.stepCount}`);
  const ageMs = snapshot.lastActivityAt === null
    ? null
    : nowMs - Date.parse(snapshot.lastActivityAt);
  lines.push(`- 心跳：${taskActivityHealthLabel(health, ageMs)}`);
  if (snapshot.recoveryNote) lines.push(`- 恢复状态：${snapshot.recoveryNote}`);
  return lines;
}
