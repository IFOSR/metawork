import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { GatewayEventEnvelope, GatewayReplay } from '../../src/gateway/client-events.js';
import type { EventJournal } from '../../src/gateway/event-journal.js';
import type { FeishuGatewayAdapter } from '../../src/gateway/feishu-gateway-adapter.js';
import { FeishuGatewaySessionPort } from '../../src/gateway/feishu-gateway-session-port.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';

describe('FeishuGatewaySessionPort', () => {
  it('consumes a terminal snapshot exactly once when replay overlaps deltas', async () => {
    const terminal = finalEvent();
    const progress = progressEvent();
    const replay: GatewayReplay = {
      lastSequence: terminal.sequence,
      snapshot: [terminal],
      deltas: [progress, progress],
    };
    const subscriptions = new GatewaySubscriptions();
    const journal: EventJournal = {
      append: async event => event,
      replay: async () => {
        subscriptions.publish(progress);
        return replay;
      },
    };
    const adapter = {
      handleMessage: async () => ({
        requestId: 'req_1',
        idempotencyKey: 'feishu:req_1',
        status: 'accepted',
        conversationId: 'conv_1',
      }),
    } as unknown as FeishuGatewayAdapter;
    const port = new FeishuGatewaySessionPort({
      accountId: 'local-default',
      tenantKey: 'tenant_1',
      adapter,
      journal,
      subscriptions,
      timeoutMs: 100,
    });
    const progressMessages: string[] = [];

    await expect(port.submitGatewayMessage({
      senderId: 'user_1',
      chatId: 'chat_1',
      text: 'hello',
      requestId: 'req_1',
      onProgress: message => progressMessages.push(message),
    })).resolves.toEqual(['final answer']);
    expect(progressMessages).toEqual(['Planning：Inspecting context']);
  });

  it('reassembles a large replayed result instead of relying on final-answer lines', async () => {
    const answer = `开头\n${'长结果'.repeat(30_000)}\n结尾`;
    const first = answer.slice(0, 50_001);
    const second = answer.slice(50_001);
    const contentHash = `sha256:${createHash('sha256')
      .update(Buffer.from(answer))
      .digest('hex')}`;
    const resultEvents = [
      resultEvent(1, 'result_delivery_available', {
        resultId: 'result_large',
        contentHash,
        byteLength: Buffer.byteLength(answer),
        completeness: 'complete',
        certification: 'certified',
      }),
      resultEvent(2, 'result_chunk', {
        resultId: 'result_large',
        offset: 0,
        chunk: first,
        byteLength: Buffer.byteLength(first),
      }),
      resultEvent(3, 'result_chunk', {
        resultId: 'result_large',
        offset: Buffer.byteLength(first),
        chunk: second,
        byteLength: Buffer.byteLength(second),
      }),
      resultEvent(4, 'result_completed', {
        resultId: 'result_large',
        contentHash,
        byteLength: Buffer.byteLength(answer),
        completeness: 'complete',
        certification: 'certified',
      }),
      resultEvent(5, 'final_answer', {
        resultId: 'result_large',
        lines: [],
      }),
    ];
    const subscriptions = new GatewaySubscriptions();
    const port = new FeishuGatewaySessionPort({
      accountId: 'local-default',
      tenantKey: 'tenant_1',
      adapter: {
        handleMessage: async () => ({
          requestId: 'req_1',
          idempotencyKey: 'feishu:req_1',
          status: 'accepted',
          conversationId: 'conv_1',
        }),
      } as unknown as FeishuGatewayAdapter,
      journal: {
        append: async event => event,
        replay: async () => ({
          lastSequence: 5,
          snapshot: [resultEvents[3]!, resultEvents[4]!],
          deltas: resultEvents.slice(0, 4),
        }),
      },
      subscriptions,
      timeoutMs: 100,
    });

    await expect(port.submitGatewayMessage({
      senderId: 'user_1',
      chatId: 'chat_1',
      text: 'large answer',
      requestId: 'req_1',
      onProgress: () => undefined,
    })).resolves.toEqual(answer.split('\n'));
  });
});

function finalEvent(): GatewayEventEnvelope {
  return {
    protocolVersion: 1,
    eventId: 'event_final',
    sequence: 2,
    accountId: 'local-default',
    conversationId: 'conv_1',
    requestId: 'req_1',
    turnId: 'turn_1',
    kind: 'final_answer',
    payload: { lines: ['final answer'] },
    occurredAt: '2026-08-19T00:00:00.000Z',
  };
}

function progressEvent(): GatewayEventEnvelope {
  return {
    ...finalEvent(),
    eventId: 'event_progress',
    sequence: 1,
    kind: 'trace_delta',
    payload: {
      events: [{ title: 'Planning', summary: 'Inspecting context' }],
    },
  };
}

function resultEvent(
  sequence: number,
  kind: GatewayEventEnvelope['kind'],
  payload: unknown,
): GatewayEventEnvelope {
  return {
    protocolVersion: 1,
    eventId: `event_${sequence}`,
    sequence,
    accountId: 'local-default',
    conversationId: 'conv_1',
    requestId: 'req_1',
    turnId: 'turn_1',
    kind,
    payload,
    occurredAt: '2026-08-21T00:00:00.000Z',
  };
}
