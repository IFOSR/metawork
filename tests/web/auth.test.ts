import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../../web/src/api/http.js';
import { WsClient } from '../../web/src/api/ws.js';
import {
  clearLaunchFragment,
  exchangeWebCredential,
  launchTokenFromHash,
  resolveWebLaunchSuggestion,
} from '../../web/src/auth.js';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = FakeWebSocket.OPEN;
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(text: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('InvalidStateError');
    this.sent.push(text);
  }

  close(): void {
    this.closeCalls += 1;
    this.onclose?.();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
});

describe('Web Cookie authentication', () => {
  it('restores drafts only for a terminal admission rejection and stops retrying that input', () => {
    vi.stubGlobal('window', { location: { protocol: 'http:', host: '127.0.0.1:8788' },
      setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const onError = vi.fn(); const client = new WsClient({ onError }); client.connect();
    const socket = FakeWebSocket.instances[0]!;
    const hello = JSON.stringify({ type: 'hello', sessionId: null,
      capabilities: ['conversation_observation_v1', 'conversation_resources_v1', 'multi_client_control_v1'],
      identity: { serverId: 'server', accountId: 'account' } });
    socket.onmessage?.({ data: hello });
    const requestId = client.sendCommand('conversation', { kind: 'user_message', text: 'input', attachments: [] });
    socket.onmessage?.({ data: JSON.stringify({ type: 'error', requestId, message: 'execution failed' }) });
    expect(onError).toHaveBeenLastCalledWith('execution failed', { requestId });
    socket.onmessage?.({ data: JSON.stringify({ type: 'receipt', receipt: { requestId, status: 'rejected', reason: 'admission denied' } }) });
    expect(onError).toHaveBeenLastCalledWith('admission denied', { requestId, code: undefined, admissionRejected: true });
    const before = socket.sent.length; socket.onmessage?.({ data: hello });
    expect(socket.sent).toHaveLength(before); client.close();
  });
  it('confirms a lost input receipt on reconnect with the identical request and target', () => {
    vi.stubGlobal('window', { location: { protocol: 'http:', host: '127.0.0.1:8788' },
      setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const client = new WsClient({});
    const hello = JSON.stringify({ type: 'hello', sessionId: 'different-focus',
      capabilities: ['conversation_observation_v1', 'conversation_resources_v1', 'multi_client_control_v1'],
      identity: { serverId: 'server', accountId: 'account' } });
    client.connect();
    const first = FakeWebSocket.instances[0]!;
    first.onmessage?.({ data: hello });
    client.sendCommand('captured-target', { kind: 'user_message', text: 'once', attachments: [] });
    const original = first.sent[0]!;
    first.onclose?.(); client.connect();
    const second = FakeWebSocket.instances[1]!;
    expect(second.sent).toEqual([]);
    second.onmessage?.({ data: hello });
    expect(second.sent).toEqual([original]);
    second.onmessage?.({ data: JSON.stringify({ type: 'receipt', receipt: {
      requestId: JSON.parse(original).envelope.requestId, status: 'duplicate',
    } }) });
    second.onclose?.(); client.connect();
    FakeWebSocket.instances[2]!.onmessage?.({ data: hello });
    expect(FakeWebSocket.instances[2]!.sent).toEqual([]);
    client.close();
  });
  it('distinguishes control admission from the applied result and binds each response to its request', async () => {
    vi.stubGlobal('window', { location: { protocol: 'http:', host: '127.0.0.1:8788' },
      setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const client = new WsClient({}); client.connect();
    const socket = FakeWebSocket.instances[0]!; const accepted = vi.fn(); const completed = vi.fn();
    const pending = client.control('conversation', { kind: 'cancel_task', taskId: 'old-task', expectedExecutionGeneration: 'generation' }, accepted).then(completed);
    const requestId = JSON.parse(socket.sent[0]!).envelope.requestId;
    socket.onmessage?.({ data: JSON.stringify({ type: 'receipt', receipt: { requestId, status: 'accepted' } }) });
    expect(accepted).toHaveBeenCalledOnce(); expect(completed).not.toHaveBeenCalled();
    socket.onmessage?.({ data: JSON.stringify({ type: 'gateway_reply', event: { requestId: 'other', kind: 'command_result', payload: { status: 'completed' } } }) });
    expect(completed).not.toHaveBeenCalled();
    socket.onmessage?.({ data: JSON.stringify({ type: 'gateway_reply', event: { requestId, kind: 'command_result', payload: { status: 'completed' } } }) });
    await pending; expect(completed).toHaveBeenCalledWith({ status: 'completed' }); client.close();
  });

  it('purges observations and stops reconnect when Server identity changes', () => {
    vi.stubGlobal('window', { location: { protocol: 'http:', host: '127.0.0.1:8788' },
      setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const onUnauthorized = vi.fn();
    const client = new WsClient({ onUnauthorized });
    const purge = vi.spyOn(client.conversations, 'purge');
    const hello = (serverId: string) => JSON.stringify({ type: 'hello', sessionId: null,
      capabilities: ['conversation_observation_v1', 'conversation_resources_v1', 'multi_client_control_v1'],
      identity: { serverId, accountId: 'account' } });
    client.connect();
    const first = FakeWebSocket.instances[0]!;
    first.onmessage?.({ data: hello('first') });
    first.onclose?.();
    client.connect();
    FakeWebSocket.instances[1]!.onmessage?.({ data: hello('replacement') });
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(purge).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances[1]!.closeCalls).toBe(1);
  });

  it('fails explicitly when observation capabilities are missing and ignores late messages', () => {
    vi.stubGlobal('window', { location: { protocol: 'http:', host: '127.0.0.1:8788' },
      setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const onHello = vi.fn(); const onError = vi.fn();
    const client = new WsClient({ onHello, onError });
    const purge = vi.spyOn(client.conversations, 'purge');
    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.onmessage?.({ data: JSON.stringify({ type: 'hello', sessionId: 'old', capabilities: [] }) });
    socket.onmessage?.({ data: JSON.stringify({ type: 'hello', sessionId: 'late', capabilities: [] }) });
    expect(onHello).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(purge).toHaveBeenCalledOnce();
  });
  it('extracts the launch hint token from the fragment and removes it', () => {
    expect(launchTokenFromHash('#launch=token%20value')).toBe('token value');
    const replaceState = vi.fn();

    clearLaunchFragment(
      { pathname: '/settings', search: '?tab=models' },
      { replaceState },
    );

    expect(replaceState).toHaveBeenCalledWith(null, '', '/settings?tab=models');
  });

  it('exchanges a launch hint without creating a session', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      workspaceHint: '/repo-a',
      conversationId: 'conv_1',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('window', {
      location: { pathname: '/', search: '', hash: '#launch=launch-token' },
      history: { replaceState: vi.fn() },
    });

    await expect(resolveWebLaunchSuggestion(fetchImpl)).resolves.toEqual({
      workspaceHint: '/repo-a',
      conversationId: 'conv_1',
    });
    expect(fetchImpl).toHaveBeenCalledWith('/api/auth/launch-context', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'launch-token' }),
    });
  });

  it('ignores an expired or already consumed launch hint', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 404 }));
    vi.stubGlobal('window', {
      location: { pathname: '/', search: '', hash: '#launch=stale' },
      history: { replaceState: vi.fn() },
    });

    await expect(resolveWebLaunchSuggestion(fetchImpl)).resolves.toBeNull();
  });

  it('exchanges the manual access token without browser storage', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      authenticated: true,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(exchangeWebCredential('manual-token', fetchImpl)).resolves.toEqual({
      authenticated: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith('/api/auth/bootstrap', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'manual-token' }),
    });
  });

  it('uses Cookie credentials without an Authorization header', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      revisionId: 'revision',
      runningRevisionId: 'revision',
      contentHash: 'hash',
      config: {},
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchImpl);
    const client = new HttpClient(vi.fn());

    await client.getConfig();

    expect(fetchImpl).toHaveBeenCalledWith('/api/config', expect.objectContaining({
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    }));
  });

  it('preserves structured activation failures returned by the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      code: 'activation_failed',
      issues: ['planner binding refresh failed'],
    }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })));
    const client = new HttpClient();

    await expect(client.activate('revision-test', { schemaVersion: 2 })).resolves.toEqual({
      ok: false,
      code: 'activation_failed',
      issues: ['planner binding refresh failed'],
    });
  });

  it('opens WebSocket without sending a token auth message', () => {
    vi.stubGlobal('window', {
      location: { protocol: 'http:', host: '127.0.0.1:8788' },
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
    });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const client = new WsClient({});

    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.onopen?.();

    expect(socket.sent).toEqual([]);
  });

  it('closes safely before the Cookie-authenticated WebSocket opens', () => {
    vi.stubGlobal('window', {
      location: { protocol: 'http:', host: '127.0.0.1:8788' },
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
    });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const client = new WsClient({});

    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.readyState = FakeWebSocket.CONNECTING;

    expect(() => client.close()).not.toThrow();
    expect(socket.sent).toEqual([]);
    expect(socket.closeCalls).toBe(1);
  });

  it('stops reconnecting when the session Cookie is rejected after disconnect', async () => {
    const onUnauthorized = vi.fn();
    const setTimeoutSpy = vi.fn(() => 1);
    vi.stubGlobal('window', {
      location: { protocol: 'http:', host: '127.0.0.1:8788' },
      setTimeout: setTimeoutSpy,
      clearTimeout: vi.fn(),
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const client = new WsClient({ onUnauthorized });

    client.connect();
    FakeWebSocket.instances[0]!.onclose?.();
    await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalledOnce());

    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('reports the server-side reason when the WebSocket handshake is rejected', async () => {
    const onError = vi.fn();
    const setTimeoutSpy = vi.fn(() => 1);
    vi.stubGlobal('window', {
      location: { protocol: 'http:', host: '127.0.0.1:5173' },
      setTimeout: setTimeoutSpy,
      clearTimeout: vi.fn(),
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      reason: 'forbidden_origin',
      message: 'WebSocket Origin 与服务端端口不匹配。',
    }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    })));
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const client = new WsClient({ onError });

    client.connect();
    FakeWebSocket.instances[0]!.onclose?.();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(
      'WebSocket Origin 与服务端端口不匹配。',
    ));

    expect(setTimeoutSpy).toHaveBeenCalled();
  });
});
