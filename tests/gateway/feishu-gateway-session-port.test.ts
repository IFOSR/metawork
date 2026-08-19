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
