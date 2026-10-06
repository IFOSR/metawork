/** UI reports evidence age; it never declares process death or Kernel recovery. */
export interface ExecutorHealthBadge {
  level: 'stale' | 'lost';
  label: string;
}

export type ExecutorActivityState =
  | 'active_operation'
  | 'presentation_heartbeat'
  | 'idle';

const STALE_AFTER_MS = 60_000;
const LOST_AFTER_MS = 300_000;

export function executorHealthBadge(input: {
  updatedAt: string | null;
  nowMs: number;
  running: boolean;
  activityState: ExecutorActivityState | null;
}): ExecutorHealthBadge | null {
  if (
    !input.running
    || input.updatedAt === null
  ) return null;
  const updatedMs = Date.parse(input.updatedAt);
  if (Number.isNaN(updatedMs)) return null;
  const ageMs = input.nowMs - updatedMs;
  if (ageMs <= STALE_AFTER_MS) return null;
  const seconds = Math.round(ageMs / 1_000);
  if (ageMs <= LOST_AFTER_MS) {
    return { level: 'stale', label: `⚠️ 执行器 ${seconds} 秒无新活动` };
  }
  return { level: 'lost', label: `执行状态待确认（${seconds} 秒无新进展）；可继续等待或取消任务` };
}
