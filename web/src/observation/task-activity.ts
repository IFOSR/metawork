import type { ConversationTaskSummary } from '../../../src/session/conversation-activity-types';

/**
 * Activity is derived from the committed six-state Task conclusion. The card
 * never re-interprets operational facts into its own lifecycle.
 */
export function taskHasOngoingWork(task: Pick<ConversationTaskSummary, 'status'>): boolean {
  return task.status === 'running';
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

/**
 * The Tasks a Stop must cancel.
 *
 * The Task a stopped Turn produced wins over the running Tasks: it is the work
 * that Turn created, and it may already have left the running state (a blocked
 * or uncertain Task is still live work). `canCancel` is the authority for
 * whether a Task may be cancelled at all - it excludes terminal Tasks.
 */
export function selectStopTargets(
  tasks: readonly ConversationTaskSummary[],
  attachedTaskId: string | null,
): ConversationTaskSummary[] {
  const attached = attachedTaskId
    ? tasks.find(task => task.taskId === attachedTaskId && task.canCancel) ?? null
    : null;
  if (attached) return [attached];
  return tasks.filter(task => task.canCancel && taskHasOngoingWork(task));
}

export function taskNeedsAttention(
  task: Pick<ConversationTaskSummary, 'status' | 'pendingActions'>,
): boolean {
  return task.status === 'needs_action' || task.status === 'failed' || task.pendingActions.length > 0;
}

/** One user-facing explanation, taken from the committed Task state. */
export function taskActivityMessage(task: Pick<ConversationTaskSummary, 'explanation'>): string {
  return task.explanation;
}
