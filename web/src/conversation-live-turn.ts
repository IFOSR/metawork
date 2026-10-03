import type {
  ConversationTurn,
  ConversationTurnProjection,
  WebSessionRecord,
} from './api/session-types';
import type {
  ExecutionTimeline,
  InteractionTrace,
  InteractionTraceEvent,
} from './api/types';
import type { ArtifactProjection } from './api/session-types';
import type {
  QueryBillProjection,
  TaskUsageSummary,
  TurnBillUserView,
} from './api/session-types';

export function mergeBilling(
  current: ConversationTurnProjection | null,
  turnId: string,
  queryBill: QueryBillProjection | null,
  taskUsageSummary: TaskUsageSummary | null,
  turnBilling?: TurnBillUserView | null,
): ConversationTurnProjection | null {
  if (!current || current.id !== turnId) return current;
  return {
    ...current,
    queryBill,
    taskUsageSummary,
    turnBilling: turnBilling ?? current.turnBilling ?? null,
  };
}

export function mergeTraceSnapshot(
  current: ConversationTurnProjection | null,
  trace: InteractionTrace,
): ConversationTurnProjection | null {
  if (!current || current.id !== trace.turnId) return current;
  return {
    ...current,
    taskId: trace.taskId,
    ...mergeTraceStatus(current, trace.status, trace.completedAt),
    startedAt: trace.startedAt,
    traceEvents: trace.events,
  };
}

export function mergeTraceDelta(
  current: ConversationTurnProjection | null,
  turnId: string,
  events: InteractionTraceEvent[],
  status?: InteractionTrace['status'],
  completedAt?: string | null,
): ConversationTurnProjection | null {
  if (!current || current.id !== turnId) return current;
  const byId = new Map(current.traceEvents.map(event => [event.id, event]));
  for (const event of events) byId.set(event.id, event);
  return {
    ...current,
    ...(status ? mergeTraceStatus(current, status, completedAt) : {}),
    traceEvents: [...byId.values()].sort((left, right) => left.sequence - right.sequence),
  };
}

export function mergeExecutionTimeline(
  current: ConversationTurnProjection | null,
  turnId: string,
  timeline: ExecutionTimeline,
): ConversationTurnProjection | null {
  if (
    !current
    || current.id !== turnId
    || (current.taskId !== null && current.taskId !== timeline.taskId)
  ) {
    return current;
  }
  const projectedStatus = turnStatusFromTimeline(timeline);
  const canReopenResume = current.status === 'blocked'
    && projectedStatus === 'running'
    && isExplicitResumeTurn(current.userInput);
  const status = projectedStatus && (current.status === 'running' || canReopenResume)
    ? projectedStatus
    : current.status;
  return {
    ...current,
    taskId: timeline.taskId,
    executionTimeline: timeline,
    status,
    completedAt: status === 'running'
      ? null
      : current.completedAt ?? new Date().toISOString(),
  };
}

export function mergeFinalAnswer(
  current: ConversationTurnProjection | null,
  turnId: string,
  lines: string[],
  completedAt: string,
  backgroundWorkPending?: boolean,
): ConversationTurnProjection | null {
  if (!current || current.id !== turnId) return current;
  return {
    ...current,
    ...(current.status === 'running' ? {
      status: backgroundWorkPending ? 'running' as const : 'completed' as const,
      completedAt: backgroundWorkPending ? null : completedAt,
    } : {}),
    ...(lines.length > 0 ? {
      finalAnswer: lines.join('\n'),
      deliveryStatus: mergeDeliveryStatus(current.deliveryStatus, 'ready'),
    } : {}),
    ...(backgroundWorkPending ? {
      deliveryStatus: mergeDeliveryStatus(current.deliveryStatus, 'streaming'),
    } : {}),
  };
}

export type LiveTurnEvent =
  | { type: 'snapshot'; turn: ConversationTurnProjection }
  | { type: 'trace'; turnId: string; events: InteractionTraceEvent[]; status?: InteractionTrace['status']; completedAt?: string | null }
  | { type: 'execution'; turnId: string; taskId: string; timeline: ExecutionTimeline }
  | { type: 'artifacts'; turnId: string; taskId: string; artifacts: ArtifactProjection[] }
  | { type: 'result_delivery_available'; turnId: string; resultId: string; certification: 'certified' | 'uncertified' }
  | { type: 'result_chunk'; turnId: string; resultId: string; offset: number; chunk: string }
  | { type: 'result_completed'; turnId: string; resultId: string; content: string; certification: 'certified' | 'uncertified' }
  | { type: 'delivery_status'; turnId: string; resultId: string; status: ConversationTurnProjection['deliveryStatus']; message?: string }
  | { type: 'final_answer'; turnId: string; lines: string[]; completedAt: string; backgroundWorkPending?: boolean }
  | { type: 'terminal_error'; turnId: string; message: string; completedAt: string }
  | { type: 'billing'; turnId: string; queryBill: QueryBillProjection | null; taskUsageSummary: TaskUsageSummary | null; turnBilling?: TurnBillUserView | null };

/** One reducer for all live Turn facts. Empty streamed final answers never erase content. */
export function mergeLiveTurnEvent(
  current: ConversationTurnProjection | null,
  event: LiveTurnEvent,
): ConversationTurnProjection | null {
  if (event.type === 'snapshot') {
    if (!current || current.id !== event.turn.id) return event.turn;
    return {
      ...event.turn,
      finalAnswer: event.turn.finalAnswer && event.turn.finalAnswer.length > 0
        ? event.turn.finalAnswer : current.finalAnswer ?? event.turn.finalAnswer,
      deliveryStatus: mergeDeliveryStatus(current.deliveryStatus, event.turn.deliveryStatus),
    };
  }
  if (event.type === 'trace') return mergeTraceDelta(current, event.turnId, event.events, event.status, event.completedAt);
  if (event.type === 'execution') return mergeExecutionTimeline(current, event.turnId, event.timeline);
  if (event.type === 'artifacts') {
    if (!current || current.id !== event.turnId || (current.taskId !== null && current.taskId !== event.taskId)) return current;
    return {
      ...current,
      taskId: event.taskId,
      artifactRefs: [...new Set([...current.artifactRefs, ...event.artifacts.map(artifact => artifact.relativePath)])],
      artifacts: mergeArtifacts(current.artifacts, event.artifacts),
    };
  }
  if (event.type === 'result_delivery_available') {
    if (!current || current.id !== event.turnId) return current;
    return { ...current, deliveryStatus: mergeDeliveryStatus(current.deliveryStatus, 'streaming') };
  }
  if (event.type === 'result_chunk') {
    if (!current || current.id !== event.turnId) return current;
    return {
      ...current,
      deliveryStatus: mergeDeliveryStatus(current.deliveryStatus, 'streaming'),
      finalAnswer: appendUtf8Chunk(current.finalAnswer ?? '', event.offset, event.chunk),
    };
  }
  if (event.type === 'result_completed') {
    if (!current || current.id !== event.turnId) return current;
    return { ...current, deliveryStatus: 'ready', finalAnswer: event.content };
  }
  if (event.type === 'delivery_status') {
    if (!current || current.id !== event.turnId || !event.status) return current;
    return { ...current, deliveryStatus: mergeDeliveryStatus(current.deliveryStatus, event.status) };
  }
  if (event.type === 'final_answer') {
    return mergeFinalAnswer(current, event.turnId, event.lines, event.completedAt, event.backgroundWorkPending);
  }
  if (event.type === 'terminal_error') {
    if (!current || current.id !== event.turnId) return current;
    return { ...current, status: 'failed', deliveryStatus: 'failed', finalAnswer: event.message, completedAt: event.completedAt };
  }
  return mergeBilling(current, event.turnId, event.queryBill, event.taskUsageSummary, event.turnBilling);
}

function appendUtf8Chunk(current: string, offset: number, chunk: string): string {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(current);
  if (offset === bytes.byteLength) return current + chunk;
  if (offset > bytes.byteLength) return current;
  return decoder.decode(bytes.slice(0, offset)) + chunk;
}

function mergeDeliveryStatus(
  current: ConversationTurnProjection['deliveryStatus'],
  incoming: ConversationTurnProjection['deliveryStatus'],
): ConversationTurnProjection['deliveryStatus'] {
  if (!incoming || incoming === 'none') return current ?? incoming;
  if (incoming === 'failed' || incoming === 'ready') return incoming;
  if (current === 'failed' || current === 'ready') return current;
  return incoming;
}

function mergeArtifacts(current: ArtifactProjection[], incoming: ArtifactProjection[]): ArtifactProjection[] {
  const byId = new Map(current.map(artifact => [artifact.artifactId, artifact]));
  for (const artifact of incoming) byId.set(artifact.artifactId, artifact);
  return [...byId.values()].sort((left, right) => left.publishedAt.localeCompare(right.publishedAt)
    || left.artifactId.localeCompare(right.artifactId));
}

function mergeTraceStatus(
  current: ConversationTurnProjection,
  incoming: InteractionTrace['status'],
  completedAt?: string | null,
): Pick<ConversationTurnProjection, 'status' | 'completedAt'> {
  // Late progress can enrich a terminal Turn, but cannot restart it.
  const canReopenResume = current.status === 'blocked'
    && incoming === 'running'
    && isExplicitResumeTurn(current.userInput);
  if (current.status === 'cancelled'
    || (current.status !== 'running' && !canReopenResume && incoming === 'running')) {
    return { status: current.status, completedAt: current.completedAt };
  }
  return {
    status: incoming,
    completedAt: incoming === 'running' ? null : completedAt ?? current.completedAt,
  };
}

function turnStatusFromTimeline(
  timeline: ExecutionTimeline,
): ConversationTurnProjection['status'] | null {
  if (['created', 'ready', 'running', 'waiting_retry'].includes(timeline.status)) {
    return 'running';
  }
  if (['done', 'archived'].includes(timeline.status)) return 'completed';
  if (['blocked', 'parked'].includes(timeline.status)) return 'blocked';
  if (timeline.status === 'cancelled') return 'cancelled';
  if (timeline.status === 'failed') return 'failed';

  const delivery = timeline.stages.find(stage => stage.phase === 'delivery');
  if (delivery?.status === 'done') return 'completed';
  if (delivery?.status === 'blocked') return 'blocked';
  if (delivery?.status === 'failed') return 'failed';
  return null;
}

function isExplicitResumeTurn(userInput: string): boolean {
  return /^\/task\s+(?:resume|recover|unblock)\b/iu.test(userInput.trim());
}

export function retainLiveTurnForConversation(
  turn: ConversationTurnProjection | null,
  sessionId: string,
): ConversationTurnProjection | null {
  return turn?.sessionId === sessionId ? turn : null;
}

export function isCurrentConversationRecordRequest(input: {
  requestId: number;
  latestRequestId: number;
  requestedSessionId: string;
  browsedSessionId: string | null;
}): boolean {
  return input.requestId === input.latestRequestId
    && input.requestedSessionId === input.browsedSessionId;
}

export function retainTerminalLiveTurnInRecord(
  record: WebSessionRecord | null,
  turn: ConversationTurnProjection | null,
): WebSessionRecord | null {
  if (
    !record
    || !turn
    || turn.status === 'running'
    || record.session.id !== turn.sessionId
    || record.turns.some(item => item.id === turn.id)
  ) {
    return record;
  }
  const terminalTurn: ConversationTurn = {
    ...turn,
    status: turn.status,
  };
  return {
    ...record,
    turns: [...record.turns, terminalTurn],
  };
}
