import type { TaskStatus } from '../core/types.js';
import { deriveTaskLifecycleState } from '../task/task-lifecycle.js';
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
  readonly updatedAt: string;
}

export interface ConversationActivityFacts {
  readonly plannerTurns: ReadonlyArray<{
    readonly conversationId: string;
    readonly updatedAt: string;
  }>;
  readonly tasks: ReadonlyArray<ConversationActivityTaskFact>;
  readonly activeAttemptTaskIds: ReadonlyArray<string>;
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
}

interface Candidate extends ConversationActivityProjection {
  readonly priority: number;
}

const PRIORITY: Record<ConversationActivityState, number> = {
  idle: 0,
  planning: 1,
  waiting: 2,
  executing: 3,
  blocked: 4,
};

export class ConversationActivityProjector {
  constructor(private readonly facts: ConversationActivityFacts) {}

  project(conversationId: string, fallbackUpdatedAt: string): ConversationActivityProjection {
    const fallback = validTimestamp(fallbackUpdatedAt, new Date(0).toISOString());
    const activeAttempts = new Set(this.facts.activeAttemptTaskIds);
    const openReplanJobs = new Set(this.facts.openReplanJobTaskIds);
    const pendingRetryWakes = new Set(this.facts.pendingRetryWakeTaskIds);
    const candidates: Candidate[] = this.facts.plannerTurns
      .filter(turn => turn.conversationId === conversationId)
      .map(turn => candidate('planning', null, turn.updatedAt, fallback));

    for (const task of this.facts.tasks) {
      if (task.originConversationId !== conversationId) continue;
      const state = taskState(task, {
        hasActiveAttempt: activeAttempts.has(task.id),
        hasOutstandingReplanJob: openReplanJobs.has(task.id),
        hasPendingRetryWake: pendingRetryWakes.has(task.id),
      });
      if (state) candidates.push(candidate(state, task.id, task.updatedAt, fallback));
    }

    candidates.sort((left, right) => (
      right.priority - left.priority
      || right.updatedAt.localeCompare(left.updatedAt)
      || String(left.taskId).localeCompare(String(right.taskId))
    ));
    const selected = candidates[0];
    return selected
      ? { state: selected.state, taskId: selected.taskId, updatedAt: selected.updatedAt }
      : { state: 'idle', taskId: null, updatedAt: fallback };
  }
}

function taskState(
  task: ConversationActivityTaskFact,
  input: {
    hasActiveAttempt: boolean;
    hasOutstandingReplanJob: boolean;
    hasPendingRetryWake: boolean;
  },
): ConversationActivityState | null {
  // 2026-09-25 plan §7: the activity card consumes the same canonical lifecycle
  // as TaskView instead of re-deriving its own rule, so a persisted `running`
  // Task with no authorized Attempt is never "executing" and an outstanding
  // Replan Job is never reported as idle.
  const lifecycle = deriveTaskLifecycleState({
    status: task.status,
    hasActiveAttempt: input.hasActiveAttempt,
    hasOutstandingReplanJob: input.hasOutstandingReplanJob,
    hasPendingRetryWake: input.hasPendingRetryWake,
    hasPendingUserDecision: false,
  });
  if (lifecycle === 'blocked') return 'blocked';
  if (lifecycle === 'executing') return 'executing';
  // Coordinating work (Plan, retry wake, user decision) is reported as waiting;
  // the card must not claim the Conversation is idle.
  if (lifecycle === 'coordinating' || lifecycle === 'waiting_for_user') return 'waiting';
  if (
    lifecycle === 'queued'
    && task.dependencies.some(dependency => (
      dependency.status === 'waiting'
      && ['kernel_capacity', 'kernel_retry', 'kernel_availability'].includes(dependency.type)
    ))
  ) return 'waiting';
  return null;
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
