import type { ConversationMetadata } from '../session/conversation-store.js';
import type { ConversationActivityProjection } from './conversation-activity-projector.js';

export type ConversationActivityState = 'idle' | 'planning' | 'queued' | 'executing' | 'waiting' | 'blocked';
const MAX_CONVERSATION_SUMMARY_TITLE_LENGTH = 160;
const MAX_CONVERSATION_SUMMARY_PREVIEW_LENGTH = 240;

export interface WorkspaceConversationSummary {
  readonly conversationId: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestTaskCreatedAt?: string;
  readonly archived: boolean;
  readonly preview: string;
  readonly activity: {
    readonly state: ConversationActivityState;
    readonly taskId: string | null;
    readonly updatedAt: string;
  };
}

export class WorkspaceConversationProjector {
  constructor(private readonly activity?: {
    project(conversationId: string, fallbackUpdatedAt: string): ConversationActivityProjection;
  }) {}

  project(metadata: ConversationMetadata): WorkspaceConversationSummary | null {
    const binding = metadata.workspaceBinding;
    if (!binding) return null;
    const activity = this.activity?.project(metadata.id, metadata.updatedAt) ?? {
      state: 'idle' as const,
      taskId: null,
      updatedAt: metadata.updatedAt,
      latestTaskCreatedAt: metadata.createdAt,
    };
    return {
      conversationId: metadata.id,
      workspaceId: binding.workspaceId,
      title: metadata.title.slice(0, MAX_CONVERSATION_SUMMARY_TITLE_LENGTH),
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      latestTaskCreatedAt: activity.latestTaskCreatedAt,
      archived: metadata.archived,
      preview: metadata.title.slice(0, MAX_CONVERSATION_SUMMARY_PREVIEW_LENGTH),
      activity,
    };
  }
}
