import type { ExecutionTimeline } from './execution-projector.js';
import type {
  InteractionTraceEvent,
  InteractionTraceStatus,
} from './interaction-trace.js';
import type { ArtifactProjection } from '../delivery/user-artifact-types.js';

export const WEB_SESSION_FORMAT_VERSION = 1 as const;
export const MAX_WEB_SESSION_TURNS = 100;
// Gateway events are individually bounded at 64 KiB. Keep a generous history
// ceiling so Planner/Kernel milestones are not discarded merely because a
// long Executor run produced more than the old 400-event UI suffix.
export const MAX_WEB_SESSION_EVENTS_PER_TURN = 10_000;

export type WebSessionAvailability = 'active' | 'browsable' | 'activation_blocked';
export type ConversationTurnStatus = InteractionTraceStatus;

/** Independent delivery state for answers that arrive after execution facts. */
export type ResultDeliveryStatus = 'none' | 'streaming' | 'verifying' | 'ready' | 'failed';

export type WebSessionActivationBlockReason =
  | 'planner_turn_active'
  | 'task_runtime_active'
  | 'session_unavailable';

export interface WebSessionMetadata {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface WebSessionActivityProjection {
  state: import('../workspace/workspace-conversation-projector.js').ConversationActivityState;
  taskId: string | null;
  updatedAt: string;
}

export interface WebSessionDirectoryMetadata extends WebSessionMetadata {
  workspaceId: string;
  preview: string;
  activity: WebSessionActivityProjection;
}

export interface ConversationWorkspaceProjection {
  path: string;
  selectedAt: string;
}

export interface WebSessionMetadataProjection extends WebSessionMetadata {
  workspaceId: string | null;
  workspace: ConversationWorkspaceProjection | null;
}

export interface WebSessionDirectoryMetadataProjection
  extends WebSessionDirectoryMetadata {
  workspace: ConversationWorkspaceProjection | null;
}

export interface ConversationTurn {
  id: string;
  sessionId: string;
  userInput: string;
  /** User supplied resources attached to this turn; safe metadata only. */
  attachments?: ConversationAttachment[];
  interactionKind?: 'system_command' | 'ai_turn';
  status: ConversationTurnStatus;
  /** Optional for legacy records; absent means no result delivery is pending. */
  deliveryStatus?: ResultDeliveryStatus;
  finalAnswer: string | null;
  taskId: string | null;
  startedAt: string;
  completedAt: string | null;
  traceEvents: InteractionTraceEvent[];
  executionTimeline: ExecutionTimeline | null;
  /** 兼容字段：历史客户端继续可用。 */
  artifactRefs: string[];
  /** 受限的用户 artifact projection；不含任何内部路径。 */
  artifacts: ArtifactProjection[];

}

export interface ConversationAttachment {
  attachmentId: string;
  name: string;
  mime: string;
  mediaClass: 'image' | 'text' | 'document' | 'archive' | 'binary' | 'unknown';
  size: number;
  status: 'available' | 'unavailable';
  createdAt?: string;
}

export interface ConversationTurnProjection
  extends Omit<ConversationTurn, 'status'> {
  status: InteractionTraceStatus;
}

export interface WebSessionRecord {
  version: typeof WEB_SESSION_FORMAT_VERSION;
  session: WebSessionMetadata;
  turns: ConversationTurn[];
  /** Opaque cursor for the next older history page, not an array offset. */
  historyCursor?: string | null;
}

export interface WebSessionRecordProjection
  extends Omit<WebSessionRecord, 'session' | 'turns'> {
  session: WebSessionMetadataProjection;
  turns: ConversationTurnProjection[];
}

export type WebSessionActivationResult =
  | { state: 'active'; sessionId: string }
  | { state: 'browsable'; sessionId: string }
  | {
    state: 'activation_blocked';
    sessionId: string;
    reason: WebSessionActivationBlockReason;
  };

export interface WebSessionCreationResult {
  session: WebSessionRecordProjection;
  activation: WebSessionActivationResult;
}

export type WorkspaceInitializationResult =
  | { status: 'not_requested' }
  | {
    status: 'accepted';
    workspace?: import('../workspace/workspace-types.js').WorkspaceRecord;
    conversations?: WebSessionDirectoryMetadataProjection[];
    nextCursor?: string | null;
    projectionVersion?: number;
  }
  | { status: 'failed'; reason: string };

export function boundWebSessionTurns(turns: ConversationTurn[]): ConversationTurn[] {
  return turns.slice(-MAX_WEB_SESSION_TURNS);
}

export function boundConversationTraceEvents(
  events: InteractionTraceEvent[],
): InteractionTraceEvent[] {
  return events.slice(-MAX_WEB_SESSION_EVENTS_PER_TURN);
}
