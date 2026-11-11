import type {
  ExecutionTimeline,
  InteractionTraceEvent,
  InteractionTraceStatus,
} from './types';
export type { QuotaGuidance } from '../../../src/metering/quota-guidance';

export type ResultDeliveryStatus = 'none' | 'streaming' | 'verifying' | 'ready' | 'failed';

export const WEB_SESSION_FORMAT_VERSION = 1 as const;
export const MAX_WEB_SESSION_TURNS = 100;
export const MAX_WEB_SESSION_EVENTS_PER_TURN = 400;

export type WebSessionAvailability = 'active' | 'browsable' | 'activation_blocked';
export type ConversationTurnStatus = InteractionTraceStatus;

export type WebSessionActivationBlockReason =
  | 'planner_turn_active'
  | 'task_runtime_active'
  | 'session_unavailable';

export interface WorkspaceSummary {
  id: string;
  accountId: string;
  displayName: string;
  canonicalPath: string;
  availability: 'available' | 'unavailable';
  createdAt: string;
  updatedAt: string;
  createdByPrincipal: string;
  archived: boolean;
  gitState?: 'initializing' | 'ready' | 'recovering' | 'failed';
  gitError?: string;
}

export interface ConversationActivityProjection {
  state: 'idle' | 'planning' | 'queued' | 'executing' | 'waiting' | 'blocked';
  taskId: string | null;
  updatedAt: string;
  latestTaskCreatedAt?: string;
}

export interface WebSessionMetadata {
  id: string;
  workspaceId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  latestTaskCreatedAt?: string;
  archived: boolean;
  preview?: string;
  activity?: ConversationActivityProjection;
  workspace: ConversationWorkspaceProjection | null;
}

export interface ConversationWorkspaceProjection {
  path: string;
  selectedAt: string;
}

export interface ArtifactProjection {
  artifactId: string;
  taskId: string;
  publicationId: string | null;
  displayName: string;
  relativePath: string;
  mediaType: string;
  previewKind: 'markdown' | 'text' | 'code' | 'image' | 'unsupported';
  documentFormat?: import('../../../src/delivery/document-preview-format').DocumentPreviewFormat;
  previewable: boolean;
  byteLength: number;
  contentHash: string;
  publishedAt: string;
}

export interface ConversationTurn {
  id: string;
  sessionId: string;
  userInput: string;
  attachments?: ConversationAttachment[];
  interactionKind?: 'system_command' | 'ai_turn';
  status: ConversationTurnStatus;
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

export interface ConversationTurnProjection
  extends Omit<ConversationTurn, 'status'> {
  status: InteractionTraceStatus;
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

export interface WebSessionRecord {
  historyCursor?: string | null;
  version: typeof WEB_SESSION_FORMAT_VERSION;
  session: WebSessionMetadata;
  turns: ConversationTurn[];
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
  session: WebSessionRecord;
  activation: WebSessionActivationResult;
}

export interface AttachmentMetadata {
  attachmentId: string;
  accountId: string;
  conversationId: string;
  workspaceId: string;
  name: string;
  mime: string;
  mediaClass: 'image' | 'text' | 'document' | 'archive' | 'binary' | 'unknown';
  /** Legacy projection retained for older persisted client state. */
  kind?: 'image' | 'text' | 'file';
  size: number;
  sha256: string;
  status: 'available' | 'unavailable';
  createdAt: string;
}
