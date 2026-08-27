import type { ExecutionTimeline } from './execution-projector.js';
import type { InteractionTraceEvent } from './interaction-trace.js';
import type {
  ConversationTurnProjection,
  WebSessionActivationResult,
  WebSessionCreationResult,
  WebSessionMetadata,
  WebSessionMetadataProjection,
  WebSessionRecord,
  WebSessionRecordProjection,
  WorkspaceInitializationResult,
} from './web-session-types.js';
import type { WebLaunchContextInput } from './web-launch-context.js';

export interface WebSessionRuntimeCatalog {
  initialize(): Promise<void>;
  create(input?: { title?: string; active?: boolean }): Promise<WebSessionRecord>;
  list(): Promise<WebSessionMetadata[]>;
  search(query: string): Promise<WebSessionMetadata[]>;
  read(sessionId: string): Promise<WebSessionRecord | null>;
  setActive(sessionId: string): Promise<WebSessionRecord | null>;
  deleteSession(sessionId: string): Promise<boolean>;
  clearAll(exceptId?: string): Promise<number>;
  appendTurn(sessionId: string, turn: import('./web-session-types.js').ConversationTurn): Promise<unknown>;
}

export type WebSessionRuntimeEvent =
  | { type: 'active_session_changed'; sessionId: string }
  | {
    type: 'session_catalog';
    activeSessionId: string;
    sessions: WebSessionMetadata[];
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
  readonly activeSessionId: string;
  initialize(): Promise<void>;
  initializeClient?(context: WebLaunchContextInput): Promise<WorkspaceInitializationResult>;
  dispose(): Promise<void>;
  submit(text: string, attachments?: Array<{ attachmentId: string; kind: string }>): Promise<void>;
  listSessions(query?: string): Promise<WebSessionMetadataProjection[]>;
  readSession(sessionId: string): Promise<WebSessionRecordProjection | null>;
  createSession(title?: string, workspaceHint?: string): Promise<WebSessionCreationResult>;
  activateSession(sessionId: string): Promise<WebSessionActivationResult>;
  /** 硬删除历史会话；活跃会话拒绝删除。 */
  deleteSession(sessionId: string): Promise<'deleted' | 'not_found' | 'active'>;
  /** 清空除活跃外的全部会话，返回删除数量。 */
  clearAllSessions(): Promise<{ deleted: number }>;
  subscribe(listener: (event: WebSessionRuntimeEvent) => void): () => void;
  getReplayEvents(): WebSessionRuntimeEvent[];
}
