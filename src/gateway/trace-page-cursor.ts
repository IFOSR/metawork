type TraceRecord = Record<string, unknown>;

export interface TracePagePosition {
  readonly sequence: number;
  readonly eventKey: string;
  readonly eventId?: string;
}

/** Stable ordering within a turn; one Gateway delta may contain many trace events. */
export function tracePosition(event: TraceRecord): TracePagePosition {
  const sequence = typeof event.sequence === 'number' && Number.isSafeInteger(event.sequence)
    ? event.sequence
    : 0;
  const eventKey = typeof event.eventKey === 'string' && event.eventKey.length > 0
    ? event.eventKey
    : typeof event.id === 'string' ? event.id : '';
  return { sequence, eventKey, ...(typeof event.id === 'string' && event.id !== eventKey ? { eventId: event.id } : {}) };
}

export function compareTracePositions(left: TracePagePosition, right: TracePagePosition): number {
  return left.sequence - right.sequence || compareKey(left.eventKey, right.eventKey)
    || compareKey(left.eventId ?? left.eventKey, right.eventId ?? right.eventKey);
}

function compareKey(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

export type TracePageScope = readonly [accountId: string, conversationId: string, turnId: string];

export function encodeTracePageCursor(position: TracePagePosition, scope: TracePageScope): string {
  return Buffer.from(JSON.stringify({ version: 1, scope, ...position }), 'utf8').toString('base64url');
}

export function decodeTracePageCursor(cursor: string | undefined, scope: TracePageScope): TracePagePosition | null {
  if (!cursor) return null;
  if (cursor.length > 2_048) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    const cursorScope = record.scope;
    if (record.version !== 1 || !Array.isArray(cursorScope) || cursorScope.length !== 3
      || !scope.every((part, index) => part === cursorScope[index])) return null;
    if (typeof record.sequence !== 'number' || !Number.isSafeInteger(record.sequence) || record.sequence < 0
      || typeof record.eventKey !== 'string'
      || (record.eventId !== undefined && typeof record.eventId !== 'string')) return null;
    return { sequence: record.sequence, eventKey: record.eventKey,
      ...(typeof record.eventId === 'string' ? { eventId: record.eventId } : {}) };
  } catch {
    return null;
  }
}

export function traceEventsFromDeltaEvents(events: readonly {
  readonly kind: string;
  readonly turnId: string | null;
  readonly payload: unknown;
}[], turnId: string): TraceRecord[] {
  const byId = new Map<string, TraceRecord>();
  for (const event of events) {
    if (event.kind !== 'trace_delta' || event.turnId !== turnId) continue;
    if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) continue;
    const rawEvents = (event.payload as Record<string, unknown>).events;
    if (!Array.isArray(rawEvents)) continue;
    for (const raw of rawEvents) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const record = raw as TraceRecord;
      const id = typeof record.id === 'string' ? record.id : JSON.stringify(record);
      byId.set(id, record);
    }
  }
  return [...byId.values()].sort((left, right) =>
    compareTracePositions(tracePosition(left), tracePosition(right))
    || String(left.id ?? '').localeCompare(String(right.id ?? '')),
  );
}
