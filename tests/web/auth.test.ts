import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../../web/src/api/http.js';
import { WsClient } from '../../web/src/api/ws.js';
import {
  bootstrapTokenFromHash,
  clearBootstrapFragment,
  exchangeWebCredential,
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
  it('extracts bootstrap credentials from the fragment and removes it', () => {
    expect(bootstrapTokenFromHash('#bootstrap=token%20value')).toBe('token value');
    const replaceState = vi.fn();

    clearBootstrapFragment(
      { pathname: '/settings', search: '?tab=models' },
      { replaceState },
    );

    expect(replaceState).toHaveBeenCalledWith(null, '', '/settings?tab=models');
  });

  it('exchanges a credential without browser storage', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      authenticated: true,
      launchContext: {
        workspaceHint: '/repo-a',
        conversationId: 'conv_1',
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(exchangeWebCredential('manual-token', fetchImpl)).resolves.toEqual({
      authenticated: true,
      launchContext: {
        workspaceHint: '/repo-a',
        conversationId: 'conv_1',
      },
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
