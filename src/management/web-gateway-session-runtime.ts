import { nanoid } from 'nanoid';
import type { GatewayEventEnvelope, GatewayReplay } from '../gateway/client-events.js';
import type { GatewayCommand } from '../gateway/client-protocol.js';
import type { InteractionTraceEvent } from './interaction-trace.js';
import type { WebGatewayAdapter } from './web-gateway-adapter.js';
import type {
  WebSessionActivationResult,
  WebSessionCreationResult,
  WebSessionMetadata,
  WebSessionRecord,
} from './web-session-types.js';
import type {
  WebSessionRuntimeCatalog,
  WebSessionRuntimeEvent,
} from './web-session-runtime-types.js';

export interface WebGatewaySessionRuntimeDeps {
  readonly accountId: string;
  readonly catalog: WebSessionRuntimeCatalog;
  readonly gateway: WebGatewayAdapter;
  readonly createId?: (prefix: string) => string;
  readonly now?: () => string;
}

export class WebGatewaySessionRuntime {
  private readonly listeners = new Set<(event: WebSessionRuntimeEvent) => void>();
  private readonly pendingInputs = new Map<string, string>();
  private unsubscribe: (() => void) | null = null;
  private detachClient: (() => void) | null = null;
  private replayEvents: WebSessionRuntimeEvent[] = [];
  private _activeSessionId: string | null = null;
  private attachGeneration = 0;
  private readonly pendingAttaches = new Set<Promise<void>>();
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(private readonly deps: WebGatewaySessionRuntimeDeps) {}

  get activeSessionId(): string {
    if (!this._activeSessionId) throw new Error('Web Gateway runtime is not initialized');
    return this._activeSessionId;
  }

  async initialize(): Promise<void> {
    if (this.disposed) throw new Error('Web Gateway runtime is disposed');
    if (this._activeSessionId) return;
    await this.deps.catalog.initialize();
    const sessions = await this.deps.catalog.list();
    const active = sessions.find(session => session.active && !session.archived);
    const record = active
      ? await this.deps.catalog.read(active.id)
      : await this.deps.catalog.create({ active: true });
    if (!record) throw new Error('Active Web conversation is unavailable');
    if (!record.session.active) await this.deps.catalog.setActive(record.session.id);
    await this.attach(record.session.id);
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.attachGeneration += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.detachClient?.();
    this.detachClient = null;
    this._activeSessionId = null;
    this.replayEvents = [];
    this.pendingInputs.clear();
    this.disposePromise = Promise.allSettled([...this.pendingAttaches]).then(() => undefined);
    return this.disposePromise;
  }

  async submit(text: string): Promise<void> {
    const requestId = this.id('req');
    this.pendingInputs.set(requestId, text);
    const command: GatewayCommand = text.startsWith('/')
      ? { kind: 'slash_command', text }
      : { kind: 'user_message', text, attachments: [] };
    const receipt = await this.deps.gateway.submit({
      protocolVersion: 1,
      requestId,
      idempotencyKey: this.id('idem'),
      connectionId: 'web',
      conversation: { mode: 'attach', conversationId: this.activeSessionId },
      command,
      clientCapabilities: ['trace_v1'],
    });
    if ('kind' in receipt || receipt.status === 'rejected') {
      this.pendingInputs.delete(requestId);
      throw new Error('kind' in receipt ? receipt.message : receipt.reason ?? 'Gateway rejected the command');
    }
  }

  listSessions(query = ''): Promise<WebSessionMetadata[]> {
    return query.trim() ? this.deps.catalog.search(query) : this.deps.catalog.list();
  }

  readSession(sessionId: string): Promise<WebSessionRecord | null> {
    return this.deps.catalog.read(sessionId);
  }

  async createSession(title?: string): Promise<WebSessionCreationResult> {
    const created = await this.deps.catalog.create({ title, active: false });
    const activation = await this.activateSession(created.session.id);
    return {
      session: await this.deps.catalog.read(created.session.id) ?? created,
      activation,
    };
  }

  async activateSession(sessionId: string): Promise<WebSessionActivationResult> {
    const target = await this.deps.catalog.read(sessionId);
    if (!target || target.session.archived) {
      return { state: 'activation_blocked', sessionId, reason: 'session_unavailable' };
    }
    await this.deps.catalog.setActive(sessionId);
    await this.attach(sessionId);
    this.emit({ type: 'active_session_changed', sessionId });
    this.emit({
      type: 'session_catalog',
      activeSessionId: sessionId,
      sessions: await this.deps.catalog.list(),
    });
    return { state: 'active', sessionId };
  }

  subscribe(listener: (event: WebSessionRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getReplayEvents(): WebSessionRuntimeEvent[] {
    return structuredClone(this.replayEvents);
  }

  private attach(sessionId: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Web Gateway runtime is disposed'));
    const generation = this.attachGeneration += 1;
    const attachment = this.attachOnce(sessionId, generation);
    this.pendingAttaches.add(attachment);
    return attachment.finally(() => {
      this.pendingAttaches.delete(attachment);
    });
  }

  private async attachOnce(sessionId: string, generation: number): Promise<void> {
    const detachClient = await this.deps.gateway.attachClient(this.deps.accountId, sessionId);
    const detachOnce = once(detachClient);
    if (this.disposed) {
      detachOnce();
      throw new Error('Web Gateway runtime is disposed');
    }
    if (generation !== this.attachGeneration) {
      detachOnce();
      return;
    }
    this.unsubscribe?.();
    this.detachClient?.();
    this._activeSessionId = sessionId;
    this.replayEvents = [];
    const buffered: GatewayEventEnvelope[] = [];
    let replaying = true;
    const unsubscribe = this.deps.gateway.subscribe(
      this.deps.accountId,
      sessionId,
      event => {
        if (this.disposed || generation !== this.attachGeneration) return;
        if (replaying) buffered.push(event);
        else this.consume(event, false);
      },
    );
    const unsubscribeOnce = once(unsubscribe);
    this.unsubscribe = unsubscribeOnce;
    this.detachClient = detachOnce;

    let replay: GatewayReplay;
    try {
      replay = await this.deps.gateway.replay(this.deps.accountId, sessionId);
    } catch (error) {
      if (generation === this.attachGeneration) {
        unsubscribeOnce();
        this.unsubscribe = null;
        detachOnce();
        this.detachClient = null;
      }
      throw error;
    }
    if (this.disposed) {
      unsubscribeOnce();
      detachOnce();
      throw new Error('Web Gateway runtime is disposed');
    }
    if (generation !== this.attachGeneration) {
      unsubscribeOnce();
      detachOnce();
      return;
    }

    const seen = new Set<string>();
    for (const event of orderedUniqueReplayEvents(replay)) {
      seen.add(event.eventId);
      this.consume(event, true);
    }
    for (const event of orderedUniqueEvents(buffered)) {
      if (event.sequence <= replay.lastSequence || seen.has(event.eventId)) continue;
      seen.add(event.eventId);
      this.consume(event, true);
    }
    replaying = false;
  }

  private consume(event: GatewayEventEnvelope, replay: boolean): void {
    const mapped = mapGatewayEvent(event);
    if (mapped) {
      if (replay) this.replayEvents.push(mapped);
      else this.emit(mapped);
    }
    if (event.kind === 'final_answer' && event.requestId) {
      const userInput = this.pendingInputs.get(event.requestId);
      this.pendingInputs.delete(event.requestId);
      if (userInput) {
        const payload = event.payload as { lines?: string[] };
        void this.deps.catalog.appendTurn(event.conversationId, {
          id: event.turnId ?? this.id('turn'),
          sessionId: event.conversationId,
          userInput,
          status: 'completed',
          finalAnswer: payload.lines?.join('\n') ?? null,
          taskId: null,
          startedAt: event.occurredAt,
          completedAt: event.occurredAt,
          traceEvents: [],
          executionTimeline: null,
          artifactRefs: [],
        });
      }
    }
  }

  private emit(event: WebSessionRuntimeEvent): void {
    for (const listener of this.listeners) listener(structuredClone(event));
  }

  private id(prefix: string): string {
    return this.deps.createId?.(prefix) ?? `${prefix}_${nanoid(12)}`;
  }
}

function once(operation: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    operation();
  };
}

function orderedUniqueReplayEvents(replay: GatewayReplay): GatewayEventEnvelope[] {
  return orderedUniqueEvents([...replay.snapshot, ...replay.deltas]);
}

function orderedUniqueEvents(events: GatewayEventEnvelope[]): GatewayEventEnvelope[] {
  const seen = new Set<string>();
  return [...events]
    .sort((left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId))
    .filter(event => {
      if (seen.has(event.eventId)) return false;
      seen.add(event.eventId);
      return true;
    });
}

function mapGatewayEvent(event: GatewayEventEnvelope): WebSessionRuntimeEvent | null {
  if (event.kind === 'conversation_snapshot') {
    const payload = event.payload as { from?: number; lines?: string[] };
    return {
      type: 'output',
      from: payload.from ?? 0,
      lines: payload.lines ?? [],
    };
  }
  if (event.kind === 'trace_delta') {
    const payload = event.payload as { turnId?: string; events?: InteractionTraceEvent[] };
    return {
      type: 'trace_delta',
      turnId: payload.turnId ?? event.turnId ?? 'turn_unknown',
      fromSequence: payload.events?.[0]?.sequence ?? 0,
      events: payload.events ?? [],
    };
  }
  if (event.kind === 'terminal_error') {
    const payload = event.payload as { message?: string };
    return { type: 'output', from: 0, lines: [`错误: ${payload.message ?? 'Gateway execution failed'}`] };
  }
  return null;
}
