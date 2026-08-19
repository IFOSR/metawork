import { describe, expect, it } from 'vitest';
import type { GatewayEventEnvelope, GatewayReplay } from '../../src/gateway/client-events.js';
import type { WebGatewayAdapter } from '../../src/management/web-gateway-adapter.js';
import { WebGatewaySessionRuntime } from '../../src/management/web-gateway-session-runtime.js';
import type { WebSessionRuntimeCatalog } from '../../src/management/web-session-runtime-types.js';
import type { WebSessionRecord } from '../../src/management/web-session-types.js';

describe('WebGatewaySessionRuntime', () => {
  it('subscribes before replay and merges buffered events without duplicates', async () => {
    let listener: ((event: GatewayEventEnvelope) => void) | null = null;
    let resolveReplay!: (replay: GatewayReplay) => void;
    const replayPromise = new Promise<GatewayReplay>(resolve => {
      resolveReplay = resolve;
    });
    const calls: string[] = [];
    const gateway = {
      attachClient: async () => {
        calls.push('attach-client');
        return () => calls.push('detach-client');
      },
      subscribe: (
        _accountId: string,
        _conversationId: string,
        next: (event: GatewayEventEnvelope) => void,
      ) => {
        calls.push('subscribe');
        listener = next;
        return () => undefined;
      },
      replay: async () => {
        calls.push('replay');
        return replayPromise;
      },
    } as unknown as WebGatewayAdapter;
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogFixture(),
      gateway,
    });

    const initializing = runtime.initialize();
    await waitFor(() => listener !== null);
    const buffered = outputEvent('event_2', 2, ['buffered']);
    listener!(buffered);
    resolveReplay({
      lastSequence: 2,
      snapshot: [],
      deltas: [
        outputEvent('event_1', 1, ['replayed']),
        buffered,
      ],
    });
    await initializing;

    expect(calls).toEqual(['attach-client', 'subscribe', 'replay']);
    expect(runtime.getReplayEvents()).toEqual([
      { type: 'output', from: 0, lines: ['replayed'] },
      { type: 'output', from: 0, lines: ['buffered'] },
    ]);

    await runtime.dispose();
    expect(calls.at(-1)).toBe('detach-client');
  });

  it('invalidates and detaches an attach that completes during dispose', async () => {
    const attached = deferred<() => void>();
    const calls: string[] = [];
    const gateway = {
      attachClient: async () => {
        calls.push('attach-start');
        return attached.promise;
      },
      subscribe: () => {
        calls.push('subscribe');
        return () => calls.push('unsubscribe');
      },
      replay: async () => {
        calls.push('replay');
        return { lastSequence: 0, snapshot: [], deltas: [] };
      },
    } as unknown as WebGatewayAdapter;
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogFixture(),
      gateway,
    });

    const initializing = runtime.initialize();
    await waitFor(() => calls.includes('attach-start'));
    const disposing = runtime.dispose();
    let disposed = false;
    void disposing.then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);

    attached.resolve(() => calls.push('detach-client'));
    await expect(initializing).rejects.toThrow('disposed');
    await disposing;

    expect(calls).toEqual(['attach-start', 'detach-client']);
    expect(() => runtime.activeSessionId).toThrow('not initialized');
  });
});

function catalogFixture(): WebSessionRuntimeCatalog {
  const record: WebSessionRecord = {
    version: 1,
    session: {
      id: 'conv_1',
      title: 'Conversation',
      createdAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-19T00:00:00.000Z',
      active: true,
      archived: false,
    },
    turns: [],
  };
  return {
    initialize: async () => undefined,
    create: async () => record,
    list: async () => [record.session],
    search: async () => [record.session],
    read: async () => record,
    setActive: async () => record,
    appendTurn: async () => record,
  };
}

function outputEvent(
  eventId: string,
  sequence: number,
  lines: string[],
): GatewayEventEnvelope {
  return {
    protocolVersion: 1,
    eventId,
    sequence,
    accountId: 'local-default',
    conversationId: 'conv_1',
    requestId: null,
    turnId: null,
    kind: 'conversation_snapshot',
    payload: { from: 0, lines },
    occurredAt: '2026-08-19T00:00:00.000Z',
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
