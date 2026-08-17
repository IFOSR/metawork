import { describe, expect, it } from 'vitest';
import {
  WebSessionRuntime,
  type WebSessionRuntimeCatalog,
  type WebSessionRuntimeEvent,
  type WebSessionRuntimeSession,
} from '../../src/management/web-session-runtime.js';
import type {
  ConversationTurn,
  WebSessionMetadata,
  WebSessionRecord,
} from '../../src/management/web-session-types.js';

function metadata(
  id: string,
  active: boolean,
  updatedAt = '2026-08-17T08:00:00.000Z',
): WebSessionMetadata {
  return {
    id,
    title: id,
    createdAt: '2026-08-17T08:00:00.000Z',
    updatedAt,
    active,
    archived: false,
  };
}

class FakeCatalog implements WebSessionRuntimeCatalog {
  readonly records = new Map<string, WebSessionRecord>();
  private nextId = 1;

  constructor(sessions: WebSessionMetadata[] = []) {
    for (const session of sessions) {
      this.records.set(session.id, { version: 1, session, turns: [] });
    }
  }

  async initialize() {}

  async create(input: { active?: boolean } = {}) {
    const id = `session_${this.nextId++}`;
    const record: WebSessionRecord = {
      version: 1,
      session: metadata(id, input.active ?? false),
      turns: [],
    };
    this.records.set(id, record);
    return structuredClone(record);
  }

  async list() {
    return [...this.records.values()].map(record => structuredClone(record.session));
  }

  async search(query: string) {
    return (await this.list()).filter(session => session.title.includes(query));
  }

  async read(sessionId: string) {
    const record = this.records.get(sessionId);
    return record ? structuredClone(record) : null;
  }

  async setActive(sessionId: string) {
    const target = this.records.get(sessionId);
    if (!target) return null;
    for (const [id, record] of this.records) {
      record.session.active = id === sessionId;
    }
    return structuredClone(target);
  }

  async appendTurn(sessionId: string, turn: ConversationTurn) {
    const record = this.records.get(sessionId);
    if (!record) return null;
    record.turns.push(structuredClone(turn));
    return structuredClone(record);
  }
}

class FakeSession implements WebSessionRuntimeSession {
  disposed = 0;
  initialized = 0;
  plannerTurnActive = false;
  taskRuntimeActive = false;
  output: string[] = [];
  private readonly snapshotListeners = new Set<(snapshot: ReturnType<FakeSession['getSnapshot']>) => void>();
  private readonly traceListeners = new Set<(trace: null) => void>();

  constructor(readonly id: string) {}

  initialize() {
    this.initialized += 1;
  }

  getSwitchingState() {
    return {
      plannerTurnActive: this.plannerTurnActive,
      taskRuntimeActive: this.taskRuntimeActive,
    };
  }

  getSnapshot() {
    return {
      output: [...this.output],
      currentTaskId: null,
      currentTask: null,
      runtimeState: {
        runningTaskId: null,
        runningExecutorName: null,
        readyTaskIds: [],
        blockedTaskIds: [],
        parkedTaskIds: [],
        lastEvent: null,
      },
      plannerState: { status: this.plannerTurnActive ? 'running' as const : 'idle' as const },
      latestGuidance: null,
    };
  }

  subscribe(listener: (snapshot: ReturnType<FakeSession['getSnapshot']>) => void) {
    this.snapshotListeners.add(listener);
    listener(this.getSnapshot());
    return () => this.snapshotListeners.delete(listener);
  }

  subscribeInteractionTrace(listener: (trace: null) => void) {
    this.traceListeners.add(listener);
    listener(null);
    return () => this.traceListeners.delete(listener);
  }

  getInteractionTrace() {
    return null;
  }

  async submit() {
    return { exitRequested: false };
  }

  async dispose() {
    this.disposed += 1;
  }
}

function makeRuntime(input: {
  catalog?: FakeCatalog;
  sessions?: Map<string, FakeSession>;
} = {}) {
  const catalog = input.catalog ?? new FakeCatalog();
  const sessions = input.sessions ?? new Map<string, FakeSession>();
  const createdIds: string[] = [];
  const runtime = new WebSessionRuntime({
    catalog,
    sessionFactory: sessionId => {
      createdIds.push(sessionId);
      const session = sessions.get(sessionId) ?? new FakeSession(sessionId);
      sessions.set(sessionId, session);
      return session;
    },
    executionQuery: {
      projectTimeline: () => null,
    },
    timelinePollIntervalMs: 60_000,
  });
  return { runtime, catalog, sessions, createdIds };
}

describe('WebSessionRuntime', () => {
  it('creates one active session and binds the same stable ID to the Planner session', async () => {
    const { runtime, createdIds } = makeRuntime();

    await runtime.initialize();

    expect(runtime.activeSessionId).toBe('session_1');
    expect(createdIds).toEqual(['session_1']);
    expect(runtime.getSession().initialized).toBe(1);
    await runtime.dispose();
  });

  it('browses history without replacing the live session', async () => {
    const catalog = new FakeCatalog([
      metadata('session_live', true),
      metadata('session_history', false),
    ]);
    const { runtime, sessions, createdIds } = makeRuntime({ catalog });
    await runtime.initialize();

    const result = await runtime.browse('session_history');

    expect(result).toEqual({ state: 'browsable', sessionId: 'session_history' });
    expect(createdIds).toEqual(['session_live']);
    expect(sessions.get('session_live')?.disposed).toBe(0);
    await runtime.dispose();
  });

  it('activates an idle historical session and broadcasts the active change', async () => {
    const catalog = new FakeCatalog([
      metadata('session_live', true),
      metadata('session_history', false),
    ]);
    const { runtime, sessions, createdIds } = makeRuntime({ catalog });
    const events: WebSessionRuntimeEvent[] = [];
    runtime.subscribe(event => events.push(event));
    await runtime.initialize();

    const result = await runtime.activate('session_history');

    expect(result).toEqual({ state: 'active', sessionId: 'session_history' });
    expect(sessions.get('session_live')?.disposed).toBe(1);
    expect(createdIds).toEqual(['session_live', 'session_history']);
    expect(runtime.activeSessionId).toBe('session_history');
    expect(events).toContainEqual({
      type: 'active_session_changed',
      sessionId: 'session_history',
    });
    await runtime.dispose();
  });

  it('rejects activation while the Planner turn is active without disposal', async () => {
    const catalog = new FakeCatalog([
      metadata('session_live', true),
      metadata('session_history', false),
    ]);
    const sessions = new Map([
      ['session_live', new FakeSession('session_live')],
    ]);
    sessions.get('session_live')!.plannerTurnActive = true;
    const { runtime } = makeRuntime({ catalog, sessions });
    await runtime.initialize();

    const result = await runtime.activate('session_history');

    expect(result).toEqual({
      state: 'activation_blocked',
      sessionId: 'session_history',
      reason: 'planner_turn_active',
    });
    expect(sessions.get('session_live')?.disposed).toBe(0);
    await runtime.dispose();
  });

  it('rejects activation while a Task still owns runtime work', async () => {
    const catalog = new FakeCatalog([
      metadata('session_live', true),
      metadata('session_history', false),
    ]);
    const sessions = new Map([
      ['session_live', new FakeSession('session_live')],
    ]);
    sessions.get('session_live')!.taskRuntimeActive = true;
    const { runtime } = makeRuntime({ catalog, sessions });
    await runtime.initialize();

    expect(await runtime.activate('session_history')).toEqual({
      state: 'activation_blocked',
      sessionId: 'session_history',
      reason: 'task_runtime_active',
    });
    expect(sessions.get('session_live')?.disposed).toBe(0);
    await runtime.dispose();
  });

  it('reports unavailable sessions without replacing the current runtime', async () => {
    const catalog = new FakeCatalog([metadata('session_live', true)]);
    const { runtime, sessions } = makeRuntime({ catalog });
    await runtime.initialize();

    expect(await runtime.activate('missing')).toEqual({
      state: 'activation_blocked',
      sessionId: 'missing',
      reason: 'session_unavailable',
    });
    expect(sessions.get('session_live')?.disposed).toBe(0);
    await runtime.dispose();
  });
});
