import type { ExecutionTimeline } from './execution-projector.js';
import type {
  InteractionTraceEvent,
  InteractionTraceStatus,
} from './interaction-trace.js';
import type { ArtifactProjection } from '../delivery/user-artifact-types.js';

export const WEB_SESSION_FORMAT_VERSION = 1 as const;
export const MAX_WEB_SESSION_TURNS = 100;
export const MAX_WEB_SESSION_EVENTS_PER_TURN = 400;

export type WebSessionAvailability = 'active' | 'browsable' | 'activation_blocked';
export type ConversationTurnStatus = Exclude<InteractionTraceStatus, 'running'>;

export type WebSessionActivationBlockReason =
  | 'planner_turn_active'
  | 'task_runtime_active'
  | 'session_unavailable';

export interface WebSessionMetadata {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
  archived: boolean;
}

export interface WebSessionActivityProjection {
  state: 'idle' | 'planning' | 'executing' | 'waiting' | 'blocked';
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
  interactionKind?: 'system_command' | 'ai_turn';
  status: ConversationTurnStatus;
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

export interface ConversationTurnProjection
  extends Omit<ConversationTurn, 'status'> {
  status: InteractionTraceStatus;
}

export interface WebSessionRecord {
  version: typeof WEB_SESSION_FORMAT_VERSION;
  session: WebSessionMetadata;
  turns: ConversationTurn[];
}

export interface WebSessionRecordProjection
  extends Omit<WebSessionRecord, 'session'> {
  session: WebSessionMetadataProjection;
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
  workspaceInitialization: WorkspaceInitializationResult;
}

export type WorkspaceInitializationResult =
  | { status: 'not_requested' }
  | { status: 'accepted' }
  | { status: 'failed'; reason: string };

export function boundWebSessionTurns(turns: ConversationTurn[]): ConversationTurn[] {
  return turns.slice(-MAX_WEB_SESSION_TURNS);
}

export function boundConversationTraceEvents(
  events: InteractionTraceEvent[],
): InteractionTraceEvent[] {
  return events.slice(-MAX_WEB_SESSION_EVENTS_PER_TURN);
}
