/**
 * L2 — Web heartbeat health badge.
 *
 * Derived from the age of the latest executor activity on a live execution
 * card. Quiet while fresh; warns after 30s of silence; flags a likely-lost
 * executor (Kernel recovery in progress) after 120s. Mirrors the Feishu
 * activity card thresholds in src/gateway/task-activity-tracker.ts.
 */
export interface ExecutorHealthBadge {
  level: 'stale' | 'lost';
  label: string;
}

export type ExecutorActivityState =
  | 'active_operation'
  | 'presentation_heartbeat'
  | 'idle';

const STALE_AFTER_MS = 30_000;
const LOST_AFTER_MS = 120_000;

export function executorHealthBadge(input: {
  updatedAt: string | null;
  nowMs: number;
  running: boolean;
  activityState: ExecutorActivityState | null;
}): ExecutorHealthBadge | null {
  if (
    !input.running
    || input.updatedAt === null
    || input.activityState !== 'idle'
  ) return null;
  const updatedMs = Date.parse(input.updatedAt);
  if (Number.isNaN(updatedMs)) return null;
  const ageMs = input.nowMs - updatedMs;
  if (ageMs <= STALE_AFTER_MS) return null;
  const seconds = Math.round(ageMs / 1_000);
  if (ageMs <= LOST_AFTER_MS) {
    return { level: 'stale', label: `⚠️ 执行器 ${seconds} 秒无新活动` };
  }
  return { level: 'lost', label: `⛔ 执行器疑似失联（${seconds} 秒无活动），Kernel 正在恢复` };
}
