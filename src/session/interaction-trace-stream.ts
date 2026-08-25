import {
  interactionTraceEventId,
  sanitizeInteractionTraceDetails,
  sanitizeInteractionTraceText,
  type InteractionTrace,
  type InteractionTraceActor,
  type InteractionTraceEvent,
  type InteractionTraceEventStatus,
  type InteractionTracePhase,
  type InteractionTraceStatus,
} from '../management/interaction-trace.js';

export interface InteractionTraceStreamOptions {
  maxEvents?: number;
  now?: () => string;
}

export interface InteractionTraceAppendInput {
  phase: InteractionTracePhase;
  actor: InteractionTraceActor;
  kind: string;
  status: InteractionTraceEventStatus;
  title: string;
  summary: string;
  details: Record<string, unknown>;
  eventKey?: string;
  taskId?: string | null;
  traceStatus?: InteractionTraceStatus;
}

export class InteractionTraceStream {
  private readonly listeners = new Set<(trace: InteractionTrace | null) => void>();
  private readonly maxEvents: number;
  private readonly now: () => string;
  private current: InteractionTrace | null = null;
  private nextSequence = 1;

  constructor(
    private readonly sessionId: string,
    options: InteractionTraceStreamOptions = {},
  ) {
    this.maxEvents = Math.max(1, options.maxEvents ?? 200);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  beginTurn(input: { turnId: string; userInput: string }): InteractionTrace {
    if (this.current?.turnId === input.turnId) return this.getSnapshot()!;
    const startedAt = this.now();
    this.current = {
      sessionId: this.sessionId,
      turnId: input.turnId,
      taskId: null,
      status: 'running',
      startedAt,
      completedAt: null,
      events: [],
    };
    this.nextSequence = 1;
    this.append({
      phase: 'intake',
      actor: 'user',
      kind: 'query_received',
      status: 'completed',
      title: 'User query received',
      summary: input.userInput,
      details: {},
      eventKey: 'query',
    });
    return this.getSnapshot()!;
  }

  append(input: InteractionTraceAppendInput): InteractionTraceEvent {
    if (!this.current) throw new Error('Interaction trace turn has not started');
    const sequence = this.nextSequence;
    const id = interactionTraceEventId(
      this.current.turnId,
      input.kind,
      input.eventKey ?? String(sequence),
    );
    const existing = this.current.events.find(event => event.id === id);
    if (existing) return structuredClone(existing);
    this.nextSequence += 1;
    const occurredAt = this.now();
    const event: InteractionTraceEvent = {
      id,
      sequence,
      cursor: `${this.current.turnId}:${sequence}`,
      eventKey: input.eventKey ?? String(sequence),
      taskId: input.taskId ?? null,
      subtaskId: readDetailString(input.details, 'subtaskId'),
      attemptId: readDetailString(input.details, 'attemptId'),
      occurredAt,
      phase: input.phase,
      actor: input.actor,
      kind: sanitizeInteractionTraceText(input.kind, 120),
      status: input.status,
      title: sanitizeInteractionTraceText(input.title, 160),
      summary: sanitizeInteractionTraceText(input.summary, 500),
      details: sanitizeInteractionTraceDetails(input.details),
    };
    this.current.events.push(event);
    if (this.current.events.length > this.maxEvents) {
      this.current.events.splice(0, this.current.events.length - this.maxEvents);
    }
    if (input.taskId !== undefined) this.current.taskId = input.taskId;
    if (input.traceStatus) {
      this.current.status = input.traceStatus;
      this.current.completedAt = input.traceStatus === 'running' ? null : occurredAt;
    }
    this.publish();
    return structuredClone(event);
  }

  getSnapshot(): InteractionTrace | null {
    return this.current ? structuredClone(this.current) : null;
  }

  subscribe(listener: (trace: InteractionTrace | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function readDetailString(details: Record<string, unknown>, key: string): string | null {
  const value = details[key];
  return typeof value === 'string' && value.trim() ? value : null;
}
