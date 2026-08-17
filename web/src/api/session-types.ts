import type {
  ExecutionTimeline,
  InteractionTraceEvent,
  InteractionTraceStatus,
} from './types';

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

export interface ConversationTurn {
  id: string;
  sessionId: string;
  userInput: string;
  status: ConversationTurnStatus;
  finalAnswer: string | null;
  taskId: string | null;
  startedAt: string;
  completedAt: string | null;
  traceEvents: InteractionTraceEvent[];
  executionTimeline: ExecutionTimeline | null;
  artifactRefs: string[];
}

export interface WebSessionRecord {
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
