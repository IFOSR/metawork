import type { ConversationTaskSummary } from '../../../src/session/conversation-activity-types';

/** Render canonical TaskView user states; cancellation permission is not activity. */
export function taskHasOngoingWork(task: Pick<ConversationTaskSummary, 'userState'>): boolean {
  return task.userState === 'executing';
}

export function conversationHasOngoingWork(
  tasks: readonly ConversationTaskSummary[],
  turn: { status: string; taskId: string | null } | null,
): boolean {
  if (tasks.some(taskHasOngoingWork)) return true;
  return turnHasOngoingWork(tasks, turn);
}

export function turnHasOngoingWork(
  tasks: readonly ConversationTaskSummary[],
  turn: { status: string; taskId: string | null } | null,
): boolean {
  if (turn?.status !== 'running') return false;
  // The live Task projection takes precedence over an old running Turn after
  // handoff. An unbound Planner turn still has its own independent activity.
  const attached = tasks.find(task => task.taskId === turn.taskId);
  return attached ? taskHasOngoingWork(attached) : true;
}

export function taskNeedsAttention(task: Pick<ConversationTaskSummary, 'userState'>): boolean {
  return task.userState === 'needs_action';
}

export function taskActivityMessage(task: Pick<ConversationTaskSummary, 'userStateReason'>): string {
  return task.userStateReason;
}
