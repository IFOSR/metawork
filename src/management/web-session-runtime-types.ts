import type { ExecutionTimeline } from './execution-projector.js';
import type { InteractionTraceEvent } from './interaction-trace.js';
import type {
  ConversationTurnProjection,
  WebSessionActivationResult,
  WebSessionCreationResult,
  WebSessionDirectoryMetadata,
  WebSessionDirectoryMetadataProjection,
  WebSessionRecord,
  WebSessionRecordProjection,
  WorkspaceInitializationResult,
} from './web-session-types.js';
import type { WebLaunchContextInput } from './web-launch-context.js';
import type { WorkspaceSummary } from '../workspace/workspace-directory-service.js';

export interface WebSessionRuntimeCatalog {
  initialize(): Promise<void>;
  create(input: { workspaceId: string; principalId: string }): Promise<WebSessionRecord>;
  list(input: {
    workspaceId: string;
    principalId: string;
    activeConversationId?: string | null;
    query?: string;
  }): Promise<WebSessionDirectoryMetadata[]>;
  search(input: {
    workspaceId: string;
    principalId: string;
    activeConversationId?: string | null;
    query?: string;
  }): Promise<WebSessionDirectoryMetadata[]>;
  read(sessionId: string, activeConversationId?: string | null): Promise<WebSessionRecord | null>;
  workspaceIdForConversation(sessionId: string): Promise<string | null>;
  listWorkspaces(principalId: string): Promise<WorkspaceSummary[]>;
  archive(sessionId: string, workspaceId: string, principalId: string): Promise<boolean>;
  clearWorkspace(workspaceId: string, principalId: string, exceptId?: string): Promise<number>;
  appendTurn(sessionId: string, turn: import('./web-session-types.js').ConversationTurn): Promise<unknown>;
}

export type WebSessionRuntimeEvent =
  | { type: 'active_session_changed'; sessionId: string }
  | {
    type: 'session_catalog';
    activeSessionId: string;
    sessions: WebSessionDirectoryMetadataProjection[];
  }
  | {
    type: 'workspace_directory';
    activeWorkspaceId: string;
    activeSessionId: string | null;
    sessions: WebSessionDirectoryMetadataProjection[];
  }
  | { type: 'output'; from: number; lines: string[] }
  | {
    type: 'turn_started';
    requestId: string;
    turnId: string;
    userInput: string;
    startedAt: string;
  }
  | {
    type: 'final_answer';
    requestId: string;
    turnId: string;
    lines: string[];
    completedAt: string;
  }
  | {
    type: 'terminal_error';
    requestId: string;
    turnId: string;
    message: string;
    completedAt: string;
  }
  | {
    type: 'result_delivery_available';
    requestId: string;
    turnId: string;
    resultId: string;
    contentHash: string;
    byteLength: number;
    completeness: 'complete' | 'partial' | 'incomplete';
    certification: 'certified' | 'uncertified';
  }
  | {
    type: 'result_chunk';
    requestId: string;
    turnId: string;
    resultId: string;
    offset: number;
    chunk: string;
  }
  | {
    type: 'result_completed';
    requestId: string;
    turnId: string;
    resultId: string;
    content: string;
    contentHash: string;
    byteLength: number;
    completeness: 'complete' | 'partial' | 'incomplete';
    certification: 'certified' | 'uncertified';
  }
  | {
    type: 'trace_delta';
    turnId: string;
    fromSequence: number;
    events: InteractionTraceEvent[];
  }
  | { type: 'execution'; taskId: string; timeline: ExecutionTimeline }
  | { type: 'conversation_snapshot'; turn: ConversationTurnProjection }
  | {
    type: 'workspace_changed';
    sessionId: string;
    workspace: import('./web-session-types.js').ConversationWorkspaceProjection | null;
  };

export interface ManagementWebSessionRuntime {
  initialize(): Promise<void>;
  initializeClient(clientId: string, context: WebLaunchContextInput | null): Promise<WorkspaceInitializationResult>;
  closeClient(clientId: string): Promise<void>;
  dispose(): Promise<void>;
  getClientState(clientId: string): {
    activeWorkspaceId: string | null;
    activeSessionId: string | null;
  };
  listWorkspaces(clientId: string): Promise<WorkspaceSummary[]>;
  selectWorkspace(clientId: string, path: string): Promise<WorkspaceInitializationResult>;
  submit(clientId: string, text: string, attachments?: Array<{ attachmentId: string; kind: string }>): Promise<void>;
  listSessions(clientId: string, query?: string): Promise<WebSessionDirectoryMetadataProjection[]>;
  readSession(clientId: string, sessionId: string): Promise<WebSessionRecordProjection | null>;
  createSession(clientId: string): Promise<WebSessionCreationResult>;
  activateSession(clientId: string, sessionId: string): Promise<WebSessionActivationResult>;
  /** 硬删除历史会话；活跃会话拒绝删除。 */
  deleteSession(clientId: string, sessionId: string): Promise<'deleted' | 'not_found' | 'active'>;
  /** 清空除活跃外的全部会话，返回删除数量。 */
  clearAllSessions(clientId: string): Promise<{ deleted: number }>;
  subscribe(clientId: string, listener: (event: WebSessionRuntimeEvent) => void): () => void;
  getReplayEvents(clientId: string): WebSessionRuntimeEvent[];
}
