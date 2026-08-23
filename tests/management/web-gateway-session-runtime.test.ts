import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { GatewayEventEnvelope, GatewayReplay } from '../../src/gateway/client-events.js';
import type { WebGatewayAdapter } from '../../src/management/web-gateway-adapter.js';
import { FileAttachmentStore } from '../../src/storage/file-attachment-store.js';
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

  it('enriches submitted user input with resolved attachment context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-runtime-attachments-'));
    try {
      const store = new FileAttachmentStore(join(root, 'attachments'));
      await store.initialize();
      const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const image = await store.saveAttachment({
        sessionId: 'conv_1',
        name: 'chart.png',
        bytes: pngMagic,
      });
      const doc = await store.saveAttachment({
        sessionId: 'conv_1',
        name: 'notes.md',
        bytes: Buffer.from('# 标题\n第一行内容', 'utf8'),
      });

      let capturedText = '';
      let capturedAttachments: Array<{ attachmentId: string; kind: string }> = [];
      const gateway = {
        attachClient: async () => () => undefined,
        subscribe: () => () => undefined,
        replay: async () => ({ lastSequence: 0, snapshot: [], deltas: [] }),
        submit: async (envelope: {
          requestId: string;
          command?: {
            text?: string;
            attachments?: Array<{ attachmentId: string; kind: string }>;
          };
        }) => {
          capturedText = envelope.command?.text ?? '';
          capturedAttachments = envelope.command?.attachments ?? [];
          return {
            requestId: envelope.requestId,
            idempotencyKey: 'idem_1',
            status: 'accepted' as const,
            conversationId: 'conv_1',
          };
        },
      } as unknown as WebGatewayAdapter;
      const runtime = new WebGatewaySessionRuntime({
        accountId: 'local-default',
        catalog: catalogFixture(),
        gateway,
        attachments: store,
        createId: prefix => `${prefix}_1`,
      });

      await runtime.initialize();
      await runtime.submit('分析这些材料', [
        { attachmentId: image.attachmentId, kind: 'file' },
        { attachmentId: doc.attachmentId, kind: 'file' },
      ]);
      await runtime.dispose();

      expect(capturedText.startsWith('分析这些材料')).toBe(true);
      expect(capturedText).toContain('[附件] 2 个文件');
      expect(capturedText).toContain('chart.png (image/png');
      expect(capturedText).toContain('notes.md (text/markdown');
      expect(capturedText).toContain('第一行内容');
      expect(capturedAttachments).toEqual([
        { attachmentId: image.attachmentId, kind: 'file' },
        { attachmentId: doc.attachmentId, kind: 'file' },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('projects live turn lifecycle events with the pending user input', async () => {
    let listener: ((event: GatewayEventEnvelope) => void) | null = null;
    let submittedRequestId = '';
    const projected: unknown[] = [];
    const gateway = {
      attachClient: async () => () => undefined,
      subscribe: (
        _accountId: string,
        _conversationId: string,
        next: (event: GatewayEventEnvelope) => void,
      ) => {
        listener = next;
        return () => undefined;
      },
      replay: async () => ({ lastSequence: 0, snapshot: [], deltas: [] }),
      submit: async (envelope: { requestId: string }) => {
        submittedRequestId = envelope.requestId;
        return {
          requestId: envelope.requestId,
          idempotencyKey: 'idem_1',
          status: 'accepted' as const,
          conversationId: 'conv_1',
        };
      },
    } as unknown as WebGatewayAdapter;
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogFixture(),
      gateway,
      createId: prefix => `${prefix}_1`,
    });
    runtime.subscribe(event => projected.push(event));

    await runtime.initialize();
    await runtime.submit('回答这个问题');
    listener!({
      ...outputEvent('event_started', 1, []),
      requestId: submittedRequestId,
      turnId: 'turn_1',
      kind: 'turn_started',
      payload: { commandKind: 'user_message' },
    });
    listener!({
      ...outputEvent('event_final', 2, []),
      requestId: submittedRequestId,
      turnId: 'turn_1',
      kind: 'final_answer',
      payload: { lines: ['这是最终答案'] },
    });

    expect(projected).toEqual([
      {
        type: 'turn_started',
        requestId: submittedRequestId,
        turnId: 'turn_1',
        userInput: '回答这个问题',
        startedAt: '2026-08-19T00:00:00.000Z',
      },
      {
        type: 'final_answer',
        requestId: submittedRequestId,
        turnId: 'turn_1',
        lines: ['这是最终答案'],
        completedAt: '2026-08-19T00:00:00.000Z',
      },
    ]);
  });

  it('streams and reassembles result chunks before the terminal answer', async () => {
    let listener: ((event: GatewayEventEnvelope) => void) | null = null;
    const projected: unknown[] = [];
    const gateway = {
      attachClient: async () => () => undefined,
      subscribe: (
        _accountId: string,
        _conversationId: string,
        next: (event: GatewayEventEnvelope) => void,
      ) => {
        listener = next;
        return () => undefined;
      },
      replay: async () => ({ lastSequence: 0, snapshot: [], deltas: [] }),
    } as unknown as WebGatewayAdapter;
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogFixture(),
      gateway,
    });
    runtime.subscribe(event => projected.push(event));
    await runtime.initialize();

    const content = '第一段\n第二段';
    const bytes = Buffer.from(content, 'utf8');
    const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const base = {
      ...outputEvent('event_result', 1, []),
      requestId: 'req_1',
      turnId: 'turn_1',
    };
    listener!({
      ...base,
      eventId: 'event_available',
      sequence: 1,
      kind: 'result_delivery_available',
      payload: {
        resultId: 'result_1',
        contentHash,
        byteLength: bytes.byteLength,
        mediaType: 'text/markdown',
        completeness: 'complete',
        certification: 'uncertified',
      },
    });
    listener!({
      ...base,
      eventId: 'event_chunk_1',
      sequence: 2,
      kind: 'result_chunk',
      payload: {
        resultId: 'result_1',
        offset: 0,
        chunk: '第一段\n',
        byteLength: Buffer.byteLength('第一段\n'),
      },
    });
    listener!({
      ...base,
      eventId: 'event_chunk_2',
      sequence: 3,
      kind: 'result_chunk',
      payload: {
        resultId: 'result_1',
        offset: Buffer.byteLength('第一段\n'),
        chunk: '第二段',
        byteLength: Buffer.byteLength('第二段'),
      },
    });
    listener!({
      ...base,
      eventId: 'event_completed',
      sequence: 4,
      kind: 'result_completed',
      payload: {
        resultId: 'result_1',
        contentHash,
        byteLength: bytes.byteLength,
        mediaType: 'text/markdown',
        completeness: 'complete',
        certification: 'uncertified',
      },
    });
    listener!({
      ...base,
      eventId: 'event_final',
      sequence: 5,
      kind: 'final_answer',
      payload: {
        resultId: 'result_1',
        contentHash,
        byteLength: bytes.byteLength,
        lines: [],
      },
    });

    expect(projected).toEqual([
      expect.objectContaining({
        type: 'result_delivery_available',
        resultId: 'result_1',
        certification: 'uncertified',
      }),
      expect.objectContaining({
        type: 'result_chunk',
        resultId: 'result_1',
        offset: 0,
        chunk: '第一段\n',
      }),
      expect.objectContaining({
        type: 'result_chunk',
        resultId: 'result_1',
        offset: Buffer.byteLength('第一段\n'),
        chunk: '第二段',
      }),
      expect.objectContaining({
        type: 'result_completed',
        resultId: 'result_1',
        content,
        certification: 'uncertified',
      }),
      expect.objectContaining({
        type: 'final_answer',
        lines: ['第一段', '第二段'],
      }),
    ]);
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
