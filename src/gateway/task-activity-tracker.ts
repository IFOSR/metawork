import type { InteractionTraceEvent } from '../management/interaction-trace.js';

/**
 * Task Activity Tracker (long-task visibility L1/L2/L3 core).
 *
 * Pure reducer over interaction-trace events that projects the executor's
 * internal activity into a user-facing activity snapshot:
 * - L1: step digest list (recentSteps/currentStep/stepCount)
 * - L2: heartbeat health derived from activity age and recovery events
 * - L3: milestone classification for immediate one-line delivery
 *
 * Surfaces (Feishu progress card, Web trace badge, /status snapshot) consume
 * the snapshot; this module owns no I/O and no timers.
 */

export type TaskHeartbeatHealth = 'active' | 'stale' | 'lost' | 'unknown';

export type TaskActivityTier = 'chat' | 'card';

export interface TaskActivityEntry {
  /** Stable dedupe key (subtaskId ?? details.subtaskId ?? kind ?? id). */
  key: string;
  kind: string;
  /** One-line human digest, already sanitized by the trace stream. */
  text: string;
  occurredAt: string;
  /**
   * Feishu notification governance: 'chat' milestones may become chat
   * messages; 'card' milestones only update the silent activity card.
   * Web surfaces never consume this field.
   */
  tier: TaskActivityTier;
}

export interface TaskActivitySnapshot {
  taskId: string | null;
  currentSubtask: string | null;
  currentStep: string | null;
  stepCount: number;
  lastActivityAt: string | null;
  recoveryNote: string | null;
  recentSteps: TaskActivityEntry[];
  milestones: TaskActivityEntry[];
}

export interface TaskActivityTrackerOptions {
  recentStepsLimit?: number;
  nowMs?: () => number;
  /** Health thresholds in milliseconds. */
  activeWindowMs?: number;
  staleWindowMs?: number;
}

export interface TaskActivityConsumeResult {
  /** Non-null when the event is a milestone worth an immediate one-line push. */
  milestone: TaskActivityEntry | null;
}

export interface TaskActivityCardParts {
  /** Main card body: status lines only (subtask, step, health, count). */
  markdown: string;
  /** Collapsed section: recent step timeline (null when empty). */
  collapsedMarkdown: string | null;
}

export interface TaskActivityTracker {
  consume(event: InteractionTraceEvent): TaskActivityConsumeResult;
  snapshot(): TaskActivitySnapshot;
  health(nowMs?: number): TaskHeartbeatHealth;
  /** Compact markdown card body for the Feishu progress card. */
  renderCard(nowMs?: number): string;
  /** Status body + collapsible step section for the Feishu activity card. */
  renderCardParts(nowMs?: number): TaskActivityCardParts;
  /** Terminal receipt painted over the activity card at task end. */
  renderReceipt(outcome: 'completed' | 'failed', detail?: string, nowMs?: number): string;
}

const DEFAULT_RECENT_STEPS_LIMIT = 10;
const DEFAULT_ACTIVE_WINDOW_MS = 30_000;
const DEFAULT_STALE_WINDOW_MS = 120_000;

const MILESTONE_KINDS = new Set([
  'subtask_execution_started',
  'executor_dispatch_authorized',
  'executor_result_observed',
  'publication_integrated',
  'delivery_completed',
  'execution_blocked',
  'executor_capacity_unavailable',
  'kernel_decision_applied',
]);

const MILESTONE_KIND_FRAGMENTS = [
  'failed',
  'blocked',
  'retry',
  'heartbeat_lost',
  'verification',
  'recovery',
];

const RECOVERY_KIND_FRAGMENTS = ['heartbeat_lost', 'retry', 'recovery'];

/** Milestones that may interrupt the user as chat messages (Feishu only). */
const CHAT_MILESTONE_KINDS = new Set([
  'executor_result_observed',
  'execution_blocked',
  'executor_capacity_unavailable',
]);

function milestoneTier(kind: string, text: string): TaskActivityTier {
  if (CHAT_MILESTONE_KINDS.has(kind)) return 'chat';
  // Recovery events always deserve a chat notice.
  if (RECOVERY_KIND_FRAGMENTS.some(fragment => kind.includes(fragment) || text.includes(fragment))) {
    return 'chat';
  }
  return 'card';
}

function isMilestoneKind(kind: string): boolean {
  if (MILESTONE_KINDS.has(kind)) return true;
  return MILESTONE_KIND_FRAGMENTS.some(fragment => kind.includes(fragment));
}

function isRecoveryKind(kind: string, text: string): boolean {
  return RECOVERY_KIND_FRAGMENTS.some(fragment => kind.includes(fragment) || text.includes(fragment));
}

function entryKey(event: InteractionTraceEvent): string {
  const details = event.details as { subtaskId?: unknown };
  const subtaskId = event.subtaskId
    ?? (typeof details?.subtaskId === 'string' ? details.subtaskId : null);
  return subtaskId ?? event.kind ?? event.id;
}

function entryText(event: InteractionTraceEvent): string {
  return [event.title, event.summary].filter(Boolean).join('：').slice(0, 500);
}

function subtaskTitleFrom(event: InteractionTraceEvent): string | null {
  const prefix = 'Executing Subtask: ';
  if (event.title.startsWith(prefix)) return event.title.slice(prefix.length).trim() || null;
  return null;
}

export function taskActivityHealthLabel(health: TaskHeartbeatHealth, ageMs: number | null): string {
  const seconds = ageMs === null ? null : Math.max(0, Math.round(ageMs / 1000));
  switch (health) {
    case 'active':
      return seconds === null ? '⏱ 活跃' : `⏱ 活跃（${seconds} 秒前有活动）`;
    case 'stale':
      return seconds === null ? '⚠️ 执行器暂无新活动' : `⚠️ 执行器 ${seconds} 秒无新活动`;
    case 'lost':
      return '⛔ 执行器失联，Kernel 正在恢复（重试/换执行器）';
    default:
      return '⏳ 等待执行器活动';
  }
}

/** @deprecated use taskActivityHealthLabel */
function healthLabel(health: TaskHeartbeatHealth, ageMs: number | null): string {
  return taskActivityHealthLabel(health, ageMs);
}

export function createTaskActivityTracker(
  options: TaskActivityTrackerOptions = {},
): TaskActivityTracker {
  const recentStepsLimit = options.recentStepsLimit ?? DEFAULT_RECENT_STEPS_LIMIT;
  const activeWindowMs = options.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;
  const staleWindowMs = options.staleWindowMs ?? DEFAULT_STALE_WINDOW_MS;
  const nowMs = options.nowMs ?? Date.now;

  let taskId: string | null = null;
  let firstActivityAt: string | null = null;
  let currentSubtask: string | null = null;
  let currentStep: string | null = null;
  let stepCount = 0;
  let lastActivityAt: string | null = null;
  let recoveryNote: string | null = null;
  const recentSteps: TaskActivityEntry[] = [];
  const milestones: TaskActivityEntry[] = [];
  const pushedMilestoneKeys = new Set<string>();

  const noteActivity = (event: InteractionTraceEvent): void => {
    lastActivityAt = event.occurredAt;
    firstActivityAt ??= event.occurredAt;
    if (event.taskId) taskId = event.taskId;
  };

  return {
    consume(event) {
      const text = entryText(event);
      const entry: TaskActivityEntry = {
        key: entryKey(event),
        kind: event.kind,
        text,
        occurredAt: event.occurredAt,
        tier: milestoneTier(event.kind, text),
      };

      noteActivity(event);

      const subtaskTitle = event.kind === 'subtask_execution_started'
        ? subtaskTitleFrom(event)
        : null;
      if (subtaskTitle) currentSubtask = subtaskTitle;

      if (event.kind === 'executor_heartbeat') {
        // Heartbeats only prove liveness: refresh activity and clear recovery,
        // but never count them as steps or overwrite the current step digest.
        recoveryNote = null;
        return { milestone: null };
      }

      if (event.kind === 'executor_progress') {
        stepCount += 1;
        if (text) currentStep = text;
        if (text) {
          recentSteps.push(entry);
          if (recentSteps.length > recentStepsLimit) {
            recentSteps.splice(0, recentSteps.length - recentStepsLimit);
          }
        }
        // New executor activity clears a previous recovery state.
        recoveryNote = null;
        return { milestone: null };
      }

      if (isRecoveryKind(event.kind, text)) {
        recoveryNote = text || event.kind;
        // Recovery events (heartbeat_lost/retry/recovery) are milestones too:
        // the user must know immediately when the executor is being recovered.
        const milestoneKey = `${entry.key}:${event.kind}:${text.slice(0, 64)}`;
        if (!pushedMilestoneKeys.has(milestoneKey)) {
          pushedMilestoneKeys.add(milestoneKey);
          milestones.push(entry);
          return { milestone: entry };
        }
        return { milestone: null };
      }

      if (!isMilestoneKind(event.kind)) {
        // Planner narration and other non-milestone activity still refresh the
        // card's current-step line, but never reach the chat as messages.
        if (text) currentStep = text;
        return { milestone: null };
      }
      const milestoneKey = `${entry.key}:${event.kind}`;
      if (pushedMilestoneKeys.has(milestoneKey)) return { milestone: null };
      pushedMilestoneKeys.add(milestoneKey);
      milestones.push(entry);
      return { milestone: entry };
    },

    snapshot() {
      return {
        taskId,
        currentSubtask,
        currentStep,
        stepCount,
        lastActivityAt,
        recoveryNote,
        recentSteps: [...recentSteps],
        milestones: [...milestones],
      };
    },

    health(atMs = nowMs()) {
      if (recoveryNote !== null) return 'lost';
      if (lastActivityAt === null) return 'unknown';
      const lastMs = Date.parse(lastActivityAt);
      if (Number.isNaN(lastMs)) return 'unknown';
      const ageMs = atMs - lastMs;
      if (ageMs <= activeWindowMs) return 'active';
      if (ageMs <= staleWindowMs) return 'stale';
      return 'lost';
    },

    renderCardParts(atMs = nowMs()): TaskActivityCardParts {
      const health = this.health(atMs);
      const ageMs = lastActivityAt === null ? null : atMs - Date.parse(lastActivityAt);
      const lines: string[] = [];
      lines.push(`**任务执行中** ${taskActivityHealthLabel(health, ageMs)}`);
      if (currentSubtask) lines.push(`📌 当前子任务：${currentSubtask}`);
      if (currentStep) lines.push(`🔧 当前步骤：${currentStep}`);
      if (stepCount > 0) lines.push(`🧭 已完成 ${stepCount} 步`);
      if (recoveryNote) lines.push(`♻️ 恢复状态：${recoveryNote}`);
      const collapsed = recentSteps.length > 0
        ? recentSteps.slice(-5).map(step => `- ${step.text}`).join('\n')
        : null;
      return { markdown: lines.join('\n'), collapsedMarkdown: collapsed };
    },

    renderReceipt(outcome: 'completed' | 'failed', detail?: string, atMs = nowMs()): string {
      const elapsedMinutes = firstActivityAt === null
        ? null
        : Math.max(0, Math.round((atMs - Date.parse(firstActivityAt)) / 60_000));
      const elapsed = elapsedMinutes === null
        ? ''
        : `（用时约 ${elapsedMinutes} 分钟，共 ${stepCount} 步）`;
      const lines: string[] = [];
      if (outcome === 'completed') {
        lines.push(`**✅ 任务已完成**${elapsed}`);
      } else {
        lines.push(`**❌ 任务失败**${elapsed}`);
        if (detail) lines.push(`原因：${detail}`);
      }
      if (currentSubtask) lines.push(`📌 子任务：${currentSubtask}`);
      return lines.join('\n');
    },

    renderCard(atMs = nowMs()) {
      const health = this.health(atMs);
      const ageMs = lastActivityAt === null ? null : atMs - Date.parse(lastActivityAt);
      const lines: string[] = [];
      lines.push(`**任务执行中** ${healthLabel(health, ageMs)}`);
      if (currentSubtask) lines.push(`📌 当前子任务：${currentSubtask}`);
      if (currentStep) lines.push(`🔧 当前步骤：${currentStep}`);
      if (stepCount > 0) lines.push(`🧭 已完成 ${stepCount} 步`);
      if (recoveryNote) lines.push(`♻️ 恢复状态：${recoveryNote}`);
      if (recentSteps.length > 0) {
        lines.push('', '**最近步骤**');
        for (const step of recentSteps.slice(-5)) {
          lines.push(`- ${step.text}`);
        }
      }
      return lines.join('\n');
    },
  };
}
