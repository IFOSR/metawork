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
  const status = projectedStatus && current.status === 'running'
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
    finalAnswer: lines.join('\n'),
  };
}

function mergeTraceStatus(
  current: ConversationTurnProjection,
  incoming: InteractionTrace['status'],
  completedAt?: string | null,
): Pick<ConversationTurnProjection, 'status' | 'completedAt'> {
  // Late progress can enrich a terminal Turn, but cannot restart it.
  if (current.status === 'cancelled'
    || (current.status !== 'running' && incoming === 'running')) {
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
