import type {
  MetaclawSession,
  SessionSnapshot,
  SessionSwitchingState,
} from '../session/metaclaw-session.js';
import type { ExecutionTimeline } from './execution-projector.js';
import type { InteractionTrace, InteractionTraceEvent } from './interaction-trace.js';
import { WebConversationProjector } from './web-conversation-projector.js';
import type {
  ConversationTurn,
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
  appendTurn(sessionId: string, turn: ConversationTurn): Promise<unknown>;
}

export interface WebSessionRuntimeSession {
  initialize(options?: { showDashboard?: boolean }): void;
  getSnapshot(): SessionSnapshot;
  getSwitchingState?(): SessionSwitchingState;
  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void;
  subscribeInteractionTrace(
    listener: (trace: InteractionTrace | null) => void,
  ): () => void;
  getInteractionTrace(): InteractionTrace | null;
  submit(text: string): Promise<{ exitRequested: boolean }>;
  dispose(): Promise<void>;
}

export interface WebSessionRuntimeExecutionQuery {
  projectTimeline(taskId: string): ExecutionTimeline | null;
}

export interface WebSessionRuntimeDeps {
  catalog: WebSessionRuntimeCatalog;
  sessionFactory: (sessionId: string) => WebSessionRuntimeSession;
  executionQuery: WebSessionRuntimeExecutionQuery;
  timelinePollIntervalMs?: number;
}

export type WebSessionRuntimeEvent =
  | { type: 'active_session_changed'; sessionId: string }
  | {
    type: 'session_catalog';
    activeSessionId: string;
    sessions: WebSessionMetadata[];
  }
  | { type: 'output'; from: number; lines: string[] }
  | { type: 'trace_snapshot'; trace: InteractionTrace }
  | {
    type: 'trace_delta';
    turnId: string;
    fromSequence: number;
    events: InteractionTraceEvent[];
  }
  | { type: 'execution'; taskId: string; timeline: ExecutionTimeline }
  | { type: 'conversation_snapshot'; turn: ConversationTurnProjection };

export class WebSessionRuntime {
  private readonly listeners = new Set<(event: WebSessionRuntimeEvent) => void>();
  private session: WebSessionRuntimeSession | null = null;
  private projector: WebConversationProjector | null = null;
  private sessionUnsubscribe: (() => void) | null = null;
  private traceUnsubscribe: (() => void) | null = null;
  private conversationUnsubscribe: (() => void) | null = null;
  private timelinePollTimer: NodeJS.Timeout | null = null;
  private initialized = false;
  private inputInFlight = false;
  private observedOutputLength = 0;
  private lastTraceTurnId: string | null = null;
  private lastTraceSequence = 0;
  private lastTimeline: ExecutionTimeline | null = null;
  private lastTimelineJson: string | null = null;
  private _activeSessionId: string | null = null;

  constructor(private readonly deps: WebSessionRuntimeDeps) {}

  get activeSessionId(): string {
    if (!this._activeSessionId) throw new Error('Web session runtime is not initialized');
    return this._activeSessionId;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.deps.catalog.initialize();
    const sessions = await this.deps.catalog.list();
    const active = sessions.find(session => session.active && !session.archived);
    const record = active
      ? await this.deps.catalog.read(active.id)
      : await this.deps.catalog.create({ active: true });
    if (!record) throw new Error('Active Web session is unavailable');
    if (!record.session.active) {
      await this.deps.catalog.setActive(record.session.id);
    }
    this.attachSession(record.session.id);
    this.initialized = true;
  }

  getSession(): WebSessionRuntimeSession {
    if (!this.session) throw new Error('Web session runtime is not initialized');
    return this.session;
  }

  getConversationSnapshot(): ConversationTurnProjection | null {
    return this.projector?.getSnapshot() ?? null;
  }

  getExecutionTimeline(): ExecutionTimeline | null {
    return this.lastTimeline ? structuredClone(this.lastTimeline) : null;
  }

  getReplayEvents(): WebSessionRuntimeEvent[] {
    if (!this.session) return [];
    const events: WebSessionRuntimeEvent[] = [];
    const output = this.session.getSnapshot().output;
    if (output.length > 0) events.push({ type: 'output', from: 0, lines: [...output] });
    const trace = this.session.getInteractionTrace();
    if (trace) events.push({ type: 'trace_snapshot', trace });
    if (this.lastTimeline) {
      events.push({
        type: 'execution',
        taskId: this.lastTimeline.taskId,
        timeline: structuredClone(this.lastTimeline),
      });
    }
    const conversation = this.projector?.getSnapshot();
    if (conversation) {
      events.push({ type: 'conversation_snapshot', turn: conversation });
    }
    return events;
  }

  subscribe(listener: (event: WebSessionRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async submit(text: string): Promise<void> {
    const session = this.getSession();
    if (this.inputInFlight) throw new Error('A Web session submission is already active');
    const outputFrom = session.getSnapshot().output.length;
    this.projector?.beginTurn({ userInput: text, outputFrom });
    this.inputInFlight = true;
    try {
      await session.submit(text);
      await this.projector?.finishSubmission();
    } catch (error) {
      await this.projector?.failSubmission(error);
      throw error;
    } finally {
      this.inputInFlight = false;
    }
  }

  async listSessions(query = ''): Promise<WebSessionMetadata[]> {
    return query.trim()
      ? this.deps.catalog.search(query)
      : this.deps.catalog.list();
  }

  async readSession(sessionId: string): Promise<WebSessionRecord | null> {
    return this.deps.catalog.read(sessionId);
  }

  async createSession(title?: string): Promise<WebSessionCreationResult> {
    const created = await this.deps.catalog.create({ title, active: false });
    const activation = await this.activate(created.session.id);
    const session = await this.deps.catalog.read(created.session.id) ?? created;
    await this.emitCatalog();
    return { session, activation };
  }

  async activateSession(sessionId: string): Promise<WebSessionActivationResult> {
    return this.activate(sessionId);
  }

  async browse(sessionId: string): Promise<WebSessionActivationResult> {
    if (sessionId === this._activeSessionId) {
      return { state: 'active', sessionId };
    }
    const record = await this.deps.catalog.read(sessionId);
    return record
      ? { state: 'browsable', sessionId }
      : {
        state: 'activation_blocked',
        sessionId,
        reason: 'session_unavailable',
      };
  }

  async activate(sessionId: string): Promise<WebSessionActivationResult> {
    if (sessionId === this._activeSessionId) {
      return { state: 'active', sessionId };
    }
    const target = await this.deps.catalog.read(sessionId);
    if (!target || target.session.archived) {
      return {
        state: 'activation_blocked',
        sessionId,
        reason: 'session_unavailable',
      };
    }

    const switchingState = this.switchingState();
    if (this.inputInFlight || switchingState.plannerTurnActive) {
      return {
        state: 'activation_blocked',
        sessionId,
        reason: 'planner_turn_active',
      };
    }
    if (switchingState.taskRuntimeActive) {
      return {
        state: 'activation_blocked',
        sessionId,
        reason: 'task_runtime_active',
      };
    }

    await this.detachSession();
    const activated = await this.deps.catalog.setActive(sessionId);
    if (!activated) {
      return {
        state: 'activation_blocked',
        sessionId,
        reason: 'session_unavailable',
      };
    }
    this.attachSession(sessionId);
    this.emit({ type: 'active_session_changed', sessionId });
    await this.emitCatalog();
    return { state: 'active', sessionId };
  }

  async dispose(): Promise<void> {
    await this.detachSession();
    this.initialized = false;
    this._activeSessionId = null;
  }

  private attachSession(sessionId: string): void {
    const session = this.deps.sessionFactory(sessionId);
    this.session = session;
    this._activeSessionId = sessionId;
    this.observedOutputLength = 0;
    this.lastTraceTurnId = null;
    this.lastTraceSequence = 0;
    this.lastTimeline = null;
    this.lastTimelineJson = null;
    this.projector = new WebConversationProjector({
      sessionId,
      store: {
        appendTurn: async (targetSessionId, turn) => {
          const result = await this.deps.catalog.appendTurn(targetSessionId, turn);
          await this.emitCatalog();
          return result;
        },
      },
    });
    this.conversationUnsubscribe = this.projector.subscribe(turn => {
      if (turn) this.emit({ type: 'conversation_snapshot', turn });
    });

    session.initialize({ showDashboard: false });
    this.sessionUnsubscribe = session.subscribe(snapshot => {
      const from = Math.min(this.observedOutputLength, snapshot.output.length);
      const lines = snapshot.output.slice(from);
      this.observedOutputLength = snapshot.output.length;
      if (lines.length > 0) {
        this.projector?.applyOutput(lines, from);
        this.emit({ type: 'output', from, lines });
      }
      this.refreshTimeline(snapshot.currentTaskId);
    });
    this.traceUnsubscribe = session.subscribeInteractionTrace(trace => {
      if (!trace) return;
      void this.projector?.applyTrace(trace);
      if (trace.turnId !== this.lastTraceTurnId) {
        this.lastTraceTurnId = trace.turnId;
        this.lastTraceSequence = trace.events.at(-1)?.sequence ?? 0;
        this.emit({ type: 'trace_snapshot', trace });
        return;
      }
      const events = trace.events.filter(event => event.sequence > this.lastTraceSequence);
      if (events.length === 0) return;
      this.lastTraceSequence = events.at(-1)!.sequence;
      this.emit({
        type: 'trace_delta',
        turnId: trace.turnId,
        fromSequence: events[0]!.sequence,
        events,
      });
    });
    this.timelinePollTimer = setInterval(() => {
      const current = this.session?.getSnapshot().currentTaskId ?? null;
      this.refreshTimeline(current);
    }, this.deps.timelinePollIntervalMs ?? 500);
    this.timelinePollTimer.unref?.();
  }

  private async detachSession(): Promise<void> {
    if (this.timelinePollTimer) {
      clearInterval(this.timelinePollTimer);
      this.timelinePollTimer = null;
    }
    this.sessionUnsubscribe?.();
    this.sessionUnsubscribe = null;
    this.traceUnsubscribe?.();
    this.traceUnsubscribe = null;
    this.conversationUnsubscribe?.();
    this.conversationUnsubscribe = null;
    const session = this.session;
    this.session = null;
    this.projector = null;
    if (session) await session.dispose();
  }

  private switchingState(): SessionSwitchingState {
    const session = this.getSession();
    if (session.getSwitchingState) return session.getSwitchingState();
    const snapshot = session.getSnapshot();
    return {
      plannerTurnActive: snapshot.plannerState.status === 'running',
      taskRuntimeActive: Boolean(
        snapshot.runtimeState.runningTaskId
        || (snapshot.currentTask
          && !['done', 'archived', 'cancelled'].includes(snapshot.currentTask.status)),
      ),
    };
  }

  private refreshTimeline(taskId: string | null): void {
    if (!taskId) {
      this.lastTimeline = null;
      this.lastTimelineJson = null;
      return;
    }
    const timeline = this.deps.executionQuery.projectTimeline(taskId);
    if (!timeline) return;
    const json = JSON.stringify(timeline);
    if (json === this.lastTimelineJson) return;
    this.lastTimeline = structuredClone(timeline);
    this.lastTimelineJson = json;
    this.emit({ type: 'execution', taskId, timeline });
    void this.projector?.applyTimeline(timeline);
  }

  private emit(event: WebSessionRuntimeEvent): void {
    for (const listener of this.listeners) listener(structuredClone(event));
  }

  private async emitCatalog(): Promise<void> {
    this.emit({
      type: 'session_catalog',
      activeSessionId: this.activeSessionId,
      sessions: await this.deps.catalog.list(),
    });
  }
}

export type MetaclawWebSessionRuntime = WebSessionRuntime & {
  getSession(): MetaclawSession;
};
