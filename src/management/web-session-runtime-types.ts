import type { ExecutionTimeline } from './execution-projector.js';
import type { InteractionTraceEvent } from './interaction-trace.js';
import type {
  ConversationTurnProjection,
  WebSessionActivationResult,
  WebSessionCreationResult,
  WebSessionMetadata,
  WebSessionRecord,
} from './web-session-types.js';

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
  | { type: 'conversation_snapshot'; turn: ConversationTurnProjection };

export interface ManagementWebSessionRuntime {
  readonly activeSessionId: string;
  initialize(): Promise<void>;
  dispose(): Promise<void>;
  submit(text: string, attachments?: Array<{ attachmentId: string; kind: string }>): Promise<void>;
  listSessions(query?: string): Promise<WebSessionMetadata[]>;
  readSession(sessionId: string): Promise<WebSessionRecord | null>;
  createSession(title?: string): Promise<WebSessionCreationResult>;
  activateSession(sessionId: string): Promise<WebSessionActivationResult>;
  /** 硬删除历史会话；活跃会话拒绝删除。 */
  deleteSession(sessionId: string): Promise<'deleted' | 'not_found' | 'active'>;
  /** 清空除活跃外的全部会话，返回删除数量。 */
  clearAllSessions(): Promise<{ deleted: number }>;
  subscribe(listener: (event: WebSessionRuntimeEvent) => void): () => void;
  getReplayEvents(): WebSessionRuntimeEvent[];
}
