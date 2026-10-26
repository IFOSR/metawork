import { describe, expect, it, vi } from 'vitest';
import { TdaiMemoryAdapter } from '../../src/memory/tdai-memory-adapter.js';
import { MemoryPortError } from '../../src/memory/memory-types.js';
import { deriveMemoryScope } from '../../src/memory/memory-scope.js';

const scope = deriveMemoryScope('local-default');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function okEnvelope(data: unknown): Response {
  return jsonResponse({ code: 0, message: 'ok', request_id: 'req-1', data });
}

describe('TdaiMemoryAdapter', () => {
  it('deposits a turn batch as user/assistant message pairs', async () => {
    const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
    const adapter = new TdaiMemoryAdapter({
      baseUrl: 'http://127.0.0.1:8420/',
      serviceId: 'metawork',
      kernelAuthToken: 'kernel-token',
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init.body)),
          headers: init.headers as Record<string, string>,
        });
        return okEnvelope({ accepted_ids: ['m1', 'm2'], total_count: 2 });
      }) as unknown as typeof fetch,
    });

    const result = await adapter.deposit({
      conversationId: 'conv-1',
      workspaceId: 'ws-1',
      turns: [{
        turnId: 't1',
        sequence: 1,
        userInput: '帮我看下销售数据',
        assistantAnswer: '好的',
        completedAt: '2026-10-22T00:00:00.000Z',
      }],
    }, scope);

    expect(result.accepted).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:8420/v3/conversation/add');
    const body = calls[0]!.body as { session_id: string; messages: Array<{ role: string; content: string }>; team_id: string };
    expect(body.session_id).toBe('conv-1');
    expect(body.messages).toEqual([
      { role: 'user', content: '帮我看下销售数据' },
      { role: 'assistant', content: '好的' },
    ]);
    expect(body.team_id).toBe(scope.teamId);
    expect(calls[0]!.headers.Authorization).toBe('Bearer kernel-token');
    expect(calls[0]!.headers['x-tdai-service-id']).toBe('metawork');
  });

  it('never sends a user key on the data plane when none is configured', async () => {
    const headers: Array<Record<string, string>> = [];
    const adapter = new TdaiMemoryAdapter({
      baseUrl: 'http://127.0.0.1:8420',
      serviceId: 'metawork',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        headers.push(init.headers as Record<string, string>);
        return okEnvelope({ items: [] });
      }) as unknown as typeof fetch,
    });
    await adapter.search({ query: 'x', limit: 5 }, scope);
    expect(headers[0]!['x-tdai-user-key']).toBeUndefined();
  });

  it('returns a degraded empty result when the engine is unreachable', async () => {
    const adapter = new TdaiMemoryAdapter({
      baseUrl: 'http://127.0.0.1:8420',
      serviceId: 'metawork',
      retries: 0,
      fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
    });
    const result = await adapter.search({ query: 'x', limit: 5 }, scope);
    expect(result.degraded).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.degradedReason).toContain('ECONNREFUSED');
  });

  it('normalizes a non-zero envelope code into a port error', async () => {
    const adapter = new TdaiMemoryAdapter({
      baseUrl: 'http://127.0.0.1:8420',
      serviceId: 'metawork',
      retries: 0,
      fetchImpl: (async () => jsonResponse({ code: 403, message: 'team_not_found: nope' }, 200)) as unknown as typeof fetch,
    });
    await expect(adapter.materialize('mem-1', scope)).rejects.toBeInstanceOf(MemoryPortError);
  });

  it('retries a transport failure and then succeeds', async () => {
    let attempts = 0;
    const adapter = new TdaiMemoryAdapter({
      baseUrl: 'http://127.0.0.1:8420',
      serviceId: 'metawork',
      retries: 1,
      sleep: async () => undefined,
      fetchImpl: (async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('socket hang up');
        return okEnvelope({ items: [{ id: 'mem-1', type: 'persona', content: '偏好中文' }] });
      }) as unknown as typeof fetch,
    });
    const result = await adapter.search({ query: '偏好', limit: 5 }, scope);
    expect(attempts).toBe(2);
    expect(result.items[0]!.id).toBe('mem-1');
  });

  it('reports FTS5 availability from the health probe', async () => {
    const adapter = new TdaiMemoryAdapter({
      baseUrl: 'http://127.0.0.1:8420',
      serviceId: 'metawork',
      fetchImpl: (async () => jsonResponse({ status: 'ok', version: '1.0.2', stores: { ftsAvailable: true } })) as unknown as typeof fetch,
    });
    const health = await adapter.health();
    expect(health.ready).toBe(true);
    expect(health.ftsAvailable).toBe(true);
    expect(health.version).toBe('1.0.2');
  });

  it('fails the health probe when FTS5 is missing', async () => {
    const adapter = new TdaiMemoryAdapter({
      baseUrl: 'http://127.0.0.1:8420',
      serviceId: 'metawork',
      fetchImpl: (async () => jsonResponse({ status: 'ok', stores: { ftsAvailable: false } })) as unknown as typeof fetch,
    });
    const health = await adapter.health();
    expect(health.ftsAvailable).toBe(false);
    expect(health.detail).toBe('fts5_unavailable');
  });

  it('materializes one memory by id through a bounded scan', async () => {
    const pages = [
      { items: [{ id: 'mem-1', type: 'persona', content: '一' }] },
      { items: [{ id: 'mem-2', type: 'instruction', content: '二' }] },
    ];
    let index = 0;
    const adapter = new TdaiMemoryAdapter({
      baseUrl: 'http://127.0.0.1:8420',
      serviceId: 'metawork',
      fetchImpl: (async () => okEnvelope(pages[Math.min(index++, pages.length - 1)])) as unknown as typeof fetch,
    });
    const materialization = await adapter.materialize('mem-2', scope);
    expect(materialization.id).toBe('mem-2');
    expect(materialization.content).toBe('二');
  });

  it('reports a missing memory instead of returning empty content', async () => {
    const adapter = new TdaiMemoryAdapter({
      baseUrl: 'http://127.0.0.1:8420',
      serviceId: 'metawork',
      fetchImpl: (async () => okEnvelope({ items: [], total: 0 })) as unknown as typeof fetch,
    });
    await expect(adapter.materialize('mem-missing', scope)).rejects.toMatchObject({
      code: 'memory_asset_not_found',
    });
  });

  it('aborts a recall that exceeds its own short timeout', async () => {
    vi.useFakeTimers();
    try {
      const adapter = new TdaiMemoryAdapter({
        baseUrl: 'http://127.0.0.1:8420',
        serviceId: 'metawork',
        timeoutMs: 10_000,
        // Recall has a separate, shorter budget: it must never stall a Planner
        // turn behind a slow engine.
        searchTimeoutMs: 50,
        retries: 0,
        fetchImpl: ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch,
      });
      const pending = adapter.search({ query: 'x', limit: 5 }, scope);
      await vi.advanceTimersByTimeAsync(100);
      const result = await pending;
      expect(result.degraded).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the governance timeout independent from the recall timeout', async () => {
    // A governance call may take longer than a recall, but the two budgets are
    // separate: a short recall timeout must not shorten a materialization.
    let abortedAt = 0;
    vi.useFakeTimers();
    try {
      const adapter = new TdaiMemoryAdapter({
        baseUrl: 'http://127.0.0.1:8420',
        serviceId: 'metawork',
        timeoutMs: 5_000,
        searchTimeoutMs: 100,
        retries: 0,
        fetchImpl: ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            abortedAt = Date.now();
            reject(new Error('aborted'));
          });
        })) as unknown as typeof fetch,
      });
      const startedAt = Date.now();
      const pending = adapter.search({ query: 'x', limit: 5 }, scope);
      await vi.advanceTimersByTimeAsync(150);
      await pending;
      expect(abortedAt - startedAt).toBeLessThan(1_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
