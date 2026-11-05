import type { TaskStatus } from '../task/task-state.js';
import type { ConversationTurnView } from './conversation-read-types.js';

/** Reconcile historical running projections against live ownership and terminal facts. */
export function settleObservedTurn(
  turn: ConversationTurnView,
  live: { turnId: string; status: string } | null,
  task: { status: TaskStatus; updatedAt?: string | null } | null,
): ConversationTurnView {
  if (turn.status !== 'running' || (live?.turnId === turn.id && live.status === 'running')) return turn;
  const status = task?.status === 'cancelled' ? 'cancelled'
    : task?.status === 'failed' ? 'failed'
      : task?.status === 'succeeded' ? 'completed'
        : turn.interactionKind === 'system_command' && turn.completedAt ? 'completed' : null;
  return status ? { ...turn, status, completedAt: turn.completedAt ?? task?.updatedAt ?? null } : turn;
}
