export type SchedulerPriority = 'normal' | 'high' | 'urgent';
export type SchedulerSlotState = 'free' | 'occupied' | 'releasing' | 'recovery_blocked';

export interface TaskSchedulerSnapshot {
  account: {
    maxConcurrentTasks: number;
    maxConcurrentAttempts: number;
    maxConcurrentAttemptsPerTask: number;
    activeTaskCount: number;
    activeAttemptCount: number;
  };
  conversations: Array<{
    conversationId: string;
    slotState: SchedulerSlotState;
    fairnessSequence: number;
  }>;
  candidates: Array<{
    taskId: string;
    conversationId: string;
    eligibleSince: string;
    priority: SchedulerPriority;
    aged: boolean;
    runnableAttemptCount: number;
    activeAttemptCount: number;
    resourceConflict: boolean;
  }>;
}

export interface TaskSchedulerSelection {
  dispatches: Array<{ taskId: string; attemptCount: number }>;
  waiting: Array<{ taskId: string; reason: 'resource_conflict' | 'capacity' | 'conversation_slot' }>;
  preemptions: never[];
}

const PRIORITY_RANK: Record<SchedulerPriority, number> = {
  normal: 0,
  high: 1,
  urgent: 2,
};

export function selectTaskDispatches(snapshot: TaskSchedulerSnapshot): TaskSchedulerSelection {
  const slots = new Map(snapshot.conversations.map(conversation => [
    conversation.conversationId,
    conversation,
  ]));
  const waiting: TaskSchedulerSelection['waiting'] = [];
  const eligible = snapshot.candidates.filter(candidate => {
    const conversation = slots.get(candidate.conversationId);
    if (!conversation || conversation.slotState !== 'free') {
      waiting.push({ taskId: candidate.taskId, reason: 'conversation_slot' });
      return false;
    }
    if (candidate.resourceConflict) {
      waiting.push({ taskId: candidate.taskId, reason: 'resource_conflict' });
      return false;
    }
    return candidate.runnableAttemptCount > 0;
  });
  const ordered = [...eligible].sort((left, right) => compareCandidates(
    left,
    right,
    slots.get(left.conversationId)?.fairnessSequence ?? Number.MAX_SAFE_INTEGER,
    slots.get(right.conversationId)?.fairnessSequence ?? Number.MAX_SAFE_INTEGER,
  ));
  const availableTaskSlots = Math.max(
    0,
    snapshot.account.maxConcurrentTasks - snapshot.account.activeTaskCount,
  );
  const availableAttemptSlots = Math.max(
    0,
    snapshot.account.maxConcurrentAttempts - snapshot.account.activeAttemptCount,
  );
  const dispatches: TaskSchedulerSelection['dispatches'] = [];
  const selectedConversations = new Set<string>();
  let remainingAttempts = availableAttemptSlots;
  for (const candidate of ordered) {
    if (selectedConversations.has(candidate.conversationId)) continue;
    if (dispatches.length >= availableTaskSlots || remainingAttempts <= 0) {
      waiting.push({ taskId: candidate.taskId, reason: 'capacity' });
      continue;
    }
    const availablePerTask = Math.max(
      0,
      snapshot.account.maxConcurrentAttemptsPerTask - candidate.activeAttemptCount,
    );
    const attemptCount = Math.min(
      candidate.runnableAttemptCount,
      availablePerTask,
      remainingAttempts,
    );
    if (attemptCount <= 0) continue;
    selectedConversations.add(candidate.conversationId);
    dispatches.push({ taskId: candidate.taskId, attemptCount });
    remainingAttempts -= attemptCount;
  }
  return { dispatches, waiting, preemptions: [] };
}

function compareCandidates(
  left: TaskSchedulerSnapshot['candidates'][number],
  right: TaskSchedulerSnapshot['candidates'][number],
  leftFairness: number,
  rightFairness: number,
): number {
  const priority = PRIORITY_RANK[right.priority] - PRIORITY_RANK[left.priority]
    || Number(right.aged) - Number(left.aged);
  if (priority !== 0) return priority;
  return leftFairness - rightFairness
    || left.eligibleSince.localeCompare(right.eligibleSince)
    || left.taskId.localeCompare(right.taskId);
}
