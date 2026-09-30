import type { WorkspaceConversationSummary } from './workspace-conversation-projector.js';
import type { WorkspaceConversationPage, WorkspaceConversationPageRequest } from './workspace-directory-service.js';
import type { ConversationActivityProjection } from './conversation-activity-projector.js';

export const WORKSPACE_DIRECTORY_PROJECTION_VERSION = 2;

export interface DirectoryProjectionState {
  readonly status: 'building' | 'ready';
  readonly sourceFingerprint: string;
  readonly checkpoint: string;
}

export interface DirectoryInvalidation {
  readonly conversationId: string;
  readonly revision: number;
}

/** Workspace-owned read model; no lifecycle or scheduling authority. */
export interface WorkspaceDirectoryProjection {
  listDirty(limit: number): DirectoryInvalidation[];
  acknowledgeDirty(item: DirectoryInvalidation): void;
  state(): DirectoryProjectionState | null;
  /** Capture candidates before reading the source; supersede older rebuild writers. */
  prepareRebuild(): string;
  beginRebuild(sourceFingerprint: string, token: string): void;
  writeBatch(items: readonly WorkspaceConversationSummary[], checkpoint: string, token: string): void;
  /** Reconcile one bounded batch; true only after the projection becomes ready. */
  finishRebuild(token: string): boolean;
  /** Live observations supersede a rebuild, including identical upserts. */
  upsert(item: WorkspaceConversationSummary): void;
  /** Keep a durable removal fence until an authoritative live upsert restores the row. */
  remove(conversationId: string): void;
  updateActivity(conversationId: string, activity: ConversationActivityProjection): void;
  find(conversationId: string): WorkspaceConversationSummary | null;
  page(workspaceId: string, request: WorkspaceConversationPageRequest): WorkspaceConversationPage;
}
