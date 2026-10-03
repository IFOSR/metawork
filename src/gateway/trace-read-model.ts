import type { GatewayEventEnvelope } from './client-events.js';
import { traceEventsFromDeltaEvents, tracePosition, type TracePagePosition } from './trace-page-cursor.js';

/** Gateway owns extraction; Storage only indexes these already-sanitized facts. */
export interface IndexedTraceEvent {
  readonly turnId: string;
  readonly eventId: string;
  readonly gatewaySequence: number;
  readonly position: TracePagePosition;
  readonly value: Record<string, unknown>;
}

export function projectIndexedTraceEvents(events: readonly GatewayEventEnvelope[]): IndexedTraceEvent[] {
  const projected: IndexedTraceEvent[] = [];
  for (const event of events) {
    if (event.kind !== 'trace_delta' || !event.turnId) continue;
    for (const value of traceEventsFromDeltaEvents([event], event.turnId)) {
      projected.push({
        turnId: event.turnId,
        eventId: typeof value.id === 'string' ? value.id : JSON.stringify(value),
        gatewaySequence: event.sequence,
        position: tracePosition(value),
        value,
      });
    }
  }
  return projected;
}
