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
  readonly updatedAt: string;
}

export interface ConversationActivityFacts {
  readonly plannerTurns: ReadonlyArray<{
    readonly conversationId: string;
    readonly updatedAt: string;
  }>;
  readonly tasks: ReadonlyArray<ConversationActivityTaskFact>;
  readonly activeAttemptTaskIds: ReadonlyArray<string>;
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
    const candidates: Candidate[] = this.facts.plannerTurns
      .filter(turn => turn.conversationId === conversationId)
      .map(turn => candidate('planning', null, turn.updatedAt, fallback));

    for (const task of this.facts.tasks) {
      if (task.originConversationId !== conversationId) continue;
      const state = taskState(task, activeAttempts.has(task.id));
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
  hasActiveAttempt: boolean,
): ConversationActivityState | null {
  if (task.status === 'blocked') return 'blocked';
  if (task.status === 'running' || hasActiveAttempt) return 'executing';
  if (
    ['created', 'ready', 'parked'].includes(task.status)
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
