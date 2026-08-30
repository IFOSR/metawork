import type { Task } from '../core/types.js';

/**
 * Tasks created before Conversation ownership was persisted have the fixed
 * migration defaults below. They remain readable by the retained legacy
 * MetaclawSession surface; all newly admitted Tasks must use an explicit owner.
 */
export const LEGACY_TASK_OWNER = {
  accountId: 'legacy-account',
  conversationId: 'legacy-conversation',
  ownerPlannerSessionId: 'legacy-planner-session',
} as const;

export function taskBelongsToConversation(
  task: Task,
  conversationId: string,
  includeLegacyOwner = false,
): boolean {
  if (task.conversationId === conversationId) return true;
  return includeLegacyOwner
    && task.accountId === LEGACY_TASK_OWNER.accountId
    && task.conversationId === LEGACY_TASK_OWNER.conversationId
    && task.ownerPlannerSessionId === LEGACY_TASK_OWNER.ownerPlannerSessionId;
}
