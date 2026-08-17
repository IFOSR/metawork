import type { ExecutionTimeline } from './execution-projector.js';
import type {
  InteractionTraceEvent,
  InteractionTraceStatus,
} from './interaction-trace.js';

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

export interface ConversationTurnProjection
  extends Omit<ConversationTurn, 'status'> {
  status: InteractionTraceStatus;
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

export interface WebSessionCreationResult {
  session: WebSessionRecord;
  activation: WebSessionActivationResult;
}

export function boundWebSessionTurns(turns: ConversationTurn[]): ConversationTurn[] {
  return turns.slice(-MAX_WEB_SESSION_TURNS);
}

export function boundConversationTraceEvents(
  events: InteractionTraceEvent[],
): InteractionTraceEvent[] {
  return events.slice(-MAX_WEB_SESSION_EVENTS_PER_TURN);
}
