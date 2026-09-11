import type { ConversationTurnProjection } from './api/session-types';
import type { InteractionTraceEvent } from './api/types';

export function projectTurnForPresentation(
  turn: ConversationTurnProjection,
): ConversationTurnProjection {
  const taskId = turn.taskId ?? turn.executionTimeline?.taskId ?? null;
  const executionTimeline = turn.executionTimeline?.taskId === taskId
    ? turn.executionTimeline
    : null;
  return {
    ...turn,
    taskId,
    executionTimeline,
    traceEvents: traceEventsForTask(turn.traceEvents, taskId),
  };
}

export function traceEventsForTask(
  events: InteractionTraceEvent[],
  taskId: string | null,
): InteractionTraceEvent[] {
  return events.filter(event => {
    const eventTaskId = traceEventTaskId(event);
    return !eventTaskId || eventTaskId === taskId;
  });
}

export function traceEventTaskId(event: InteractionTraceEvent): string | null {
  const detailTaskId = event.details.taskId;
  return event.taskId
    ?? (typeof detailTaskId === 'string' && detailTaskId.trim() ? detailTaskId : null);
}
