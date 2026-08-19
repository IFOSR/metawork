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
  submit(text: string): Promise<void>;
  listSessions(query?: string): Promise<WebSessionMetadata[]>;
  readSession(sessionId: string): Promise<WebSessionRecord | null>;
  createSession(title?: string): Promise<WebSessionCreationResult>;
  activateSession(sessionId: string): Promise<WebSessionActivationResult>;
  subscribe(listener: (event: WebSessionRuntimeEvent) => void): () => void;
  getReplayEvents(): WebSessionRuntimeEvent[];
}
