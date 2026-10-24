import type { TaskStatus } from '../core/types.js';
import type { ConversationActivityState } from './workspace-conversation-projector.js';

const MAX_TASK_ID_LENGTH = 160;

export interface ConversationActivityTaskFact {
  readonly id: string;
  readonly originConversationId: string | null;
  readonly status: TaskStatus;
  readonly dependencies: ReadonlyArray<{
    readonly type: string;
    readonly status: string;
  }>;
  readonly createdAt?: string;
  readonly updatedAt: string;
}

export interface ConversationActivityFacts {
  readonly plannerTurns: ReadonlyArray<{
    readonly conversationId: string;
    readonly updatedAt: string;
  }>;
  readonly tasks: ReadonlyArray<ConversationActivityTaskFact>;
  readonly activeAttemptTaskIds: ReadonlyArray<string>;
  readonly activeAttemptUpdatedAt?: ReadonlyArray<{
    readonly taskId: string;
    readonly updatedAt: string;
  }>;
  /**
   * Tasks with an outstanding durable Replan Job. Required so the activity card
   * derives the same canonical lifecycle as TaskView instead of assuming the
   * fact away (2026-09-25 review fix 6).
   */
  readonly openReplanJobTaskIds: ReadonlyArray<string>;
  /** Tasks with a Kernel-authorized retry wake pending. */
  readonly pendingRetryWakeTaskIds: ReadonlyArray<string>;
}

export interface ConversationActivityProjection {
  readonly state: ConversationActivityState;
  readonly taskId: string | null;
  readonly updatedAt: string;
  readonly latestTaskCreatedAt?: string;
}

interface Candidate extends ConversationActivityProjection {
  readonly priority: number;
}

const PRIORITY: Record<ConversationActivityState, number> = {
  idle: 0,
  planning: 1,
  queued: 2,
  waiting: 2,
  executing: 3,
  blocked: 4,
};

export class ConversationActivityProjector {
  constructor(private readonly facts: ConversationActivityFacts) {}

  project(conversationId: string, fallbackUpdatedAt: string): ConversationActivityProjection {
    const fallback = validTimestamp(fallbackUpdatedAt, new Date(0).toISOString());
    const conversationTasks = this.facts.tasks
      .filter(task => task.originConversationId === conversationId);
    const latestTaskCreatedAt = conversationTasks
      .map(task => validTimestamp(task.createdAt ?? fallback, fallback))
      .sort((left, right) => right.localeCompare(left))[0] ?? fallback;
    const activeAttempts = new Set(this.facts.activeAttemptTaskIds);
    const activeAttemptUpdatedAt = new Map(
      (this.facts.activeAttemptUpdatedAt ?? []).map(item => [item.taskId, item.updatedAt]),
    );
    const openReplanJobs = new Set(this.facts.openReplanJobTaskIds);
    const pendingRetryWakes = new Set(this.facts.pendingRetryWakeTaskIds);
    const candidates: Candidate[] = this.facts.plannerTurns
      .filter(turn => turn.conversationId === conversationId)
      .map(turn => candidate('planning', null, turn.updatedAt, fallback));

    for (const task of conversationTasks) {
      const state = taskState(task, {
        hasActiveAttempt: activeAttempts.has(task.id),
        hasOutstandingReplanJob: openReplanJobs.has(task.id),
        hasPendingRetryWake: pendingRetryWakes.has(task.id),
      });
      if (state) {
        candidates.push(candidate(
          state,
          task.id,
          latestTimestamp(task.updatedAt, activeAttemptUpdatedAt.get(task.id)),
          fallback,
        ));
      }
    }

    candidates.sort((left, right) => (
      right.priority - left.priority
      || right.updatedAt.localeCompare(left.updatedAt)
      || String(left.taskId).localeCompare(String(right.taskId))
    ));
    const selected = candidates[0];
    return selected
      ? {
          state: selected.state,
          taskId: selected.taskId,
          updatedAt: selected.updatedAt,
          latestTaskCreatedAt,
        }
      : { state: 'idle', taskId: null, updatedAt: fallback, latestTaskCreatedAt };
  }
}

function taskState(
  task: ConversationActivityTaskFact,
  _input: {
    hasActiveAttempt: boolean;
    hasOutstandingReplanJob: boolean;
    hasPendingRetryWake: boolean;
  },
): ConversationActivityState | null {
  // The activity card aggregates the committed six-state Task conclusion. It
  // does not re-interpret operational facts into its own lifecycle.
  switch (task.status) {
    case 'needs_action':
      return 'blocked';
    case 'running':
      return 'executing';
    case 'queued':
      return 'queued';
    case 'succeeded':
    case 'failed':
    case 'cancelled':
      return null;
  }
}

function candidate(
  state: ConversationActivityState,
  taskId: string | null,
  updatedAt: string,
  fallbackUpdatedAt: string,
): Candidate {
  return {
    state,
    taskId: taskId === null ? null : taskId.slice(0, MAX_TASK_ID_LENGTH),
    updatedAt: validTimestamp(updatedAt, fallbackUpdatedAt),
    priority: PRIORITY[state],
  };
}

function validTimestamp(value: string, fallback: string): string {
  return Number.isFinite(Date.parse(value)) ? value : fallback;
}

function latestTimestamp(...values: Array<string | undefined>): string {
  const valid = values.filter((value): value is string => (
    typeof value === 'string' && Number.isFinite(Date.parse(value))
  ));
  return valid.sort((left, right) => Date.parse(right) - Date.parse(left))[0]
    ?? values.find(value => typeof value === 'string')
    ?? new Date(0).toISOString();
}
