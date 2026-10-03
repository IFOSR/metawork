import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { NotificationRoutingService } from '../../src/delivery/notification-routing.js';
import { SqliteNotificationRoutingStore } from '../../src/storage/notification-routing-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { FeishuGatewaySessionPort } from '../../src/gateway/feishu-gateway-session-port.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import { handleFeishuMessageEvent, subscribeFeishuGatewayDeliveries } from '../../src/integrations/feishu-app.js';

/** Real durable Delivery + production Feishu bridge; only the external HTTP platform is substituted. */
describe('Feishu long-task visibility through durable routes', () => {
  it('acknowledges promptly, coalesces progress into one card, restores after restart and delivers the full result', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    let now = 100_000;
    const route = { accountId: 'local-default', principalId: 'feishu:tenant:sender', conversationId: 'conversation',
      requestId: 'message', taskId: null, source: 'default_reply' as const,
      destination: { platform: 'feishu' as const, tenantKey: 'tenant', senderId: 'sender', chatId: 'chat', chatType: 'dm' as const } };
    const port = new FeishuGatewaySessionPort({ accountId: 'local-default', tenantKey: 'tenant',
      subscriptions: new GatewaySubscriptions(), observation: { content: async () => null },
      adapter: {
        handleMessage: async () => {
          await delivery.follow(route);
          return { requestId: 'message', idempotencyKey: 'feishu:message', status: 'accepted', conversationId: 'conversation' };
        },
        handleCardAction: async () => { throw new Error('unused'); },
      } });
    const makeDelivery = () => new NotificationRoutingService({ store: new SqliteNotificationRoutingStore(db),
      authorize: async () => true, deliver: job => port.deliverNotification(job), now: () => now, onError: error => { throw error; } });
    let delivery = makeDelivery();
    let messages = 0;
    const client = {
      addReactionToMessage: vi.fn(async () => 'reaction'), removeReactionFromMessage: vi.fn(async () => undefined),
      sendMarkdownCardToChat: vi.fn(async (_chat: string, _markdown: string) => `sent_${++messages}`),
      updateMarkdownCard: vi.fn(async (_id: string, _markdown: string) => true),
    };
    const unsubscribe = subscribeFeishuGatewayDeliveries({ session: port, client: client as never, cardDeliveryOptions: { updateCooldownMs: 0 } });
    const fact = { accountId: 'local-default', conversationId: 'conversation', subjectId: 'task',
      requestId: 'message', taskId: 'task', category: 'progress' as const, version: 'v0', payload: {} };
    try {
      await handleFeishuMessageEvent({ sender: { sender_id: { open_id: 'sender' } }, message: {
        message_id: 'message', chat_id: 'chat', chat_type: 'p2p', message_type: 'text', content: '{"text":"research"}',
      } }, { session: port, client: client as never, seenMessageIds: new Set(), cardDeliveryOptions: { updateCooldownMs: 0 } });
      expect(client.sendMarkdownCardToChat.mock.calls.some(([, text]) => text.includes('消息已接收'))).toBe(true);
      for (let step = 1; step <= 20; step++) {
        delivery.capture({ ...fact, version: `step_${step}`, payload: { title: 'Research', explanation: '正在执行',
          progressSummary: `查阅来源 ${step}`, canCancel: true, executionGeneration: 'generation' } });
        now += 500; await delivery.drain();
      }
      await delivery.stop(); delivery = makeDelivery();
      delivery.capture({ ...fact, version: 'recovery', payload: { title: 'Research', explanation: '恢复后继续执行', canCancel: true } });
      now += 2001; await delivery.drain();
      delivery.capture({ ...fact, version: 'terminal', payload: { title: 'Research', explanation: '任务已完成', canCancel: false } });
      delivery.capture({ ...fact, subjectId: 'turn', category: 'result', version: 'final', payload: { answer: '任务完成报告：调研结论', deliveryStatus: 'ready' } });
      await delivery.drain();
      const sent = client.sendMarkdownCardToChat.mock.calls.map(([, text]) => text);
      expect(sent.some(text => text.includes('任务完成报告'))).toBe(true);
      expect(sent.filter(text => text.includes('Research'))).toHaveLength(1);
      const edits = client.updateMarkdownCard.mock.calls;
      expect(edits.length).toBeGreaterThan(1);
      expect(new Set(edits.map(([id]) => id)).size).toBe(1);
      expect(edits.some(([, text]) => text.includes('查阅来源'))).toBe(true);
      expect(edits.at(-1)?.[1]).toContain('任务已完成');
      expect(sent.length).toBeLessThanOrEqual(4);
      const before = messages; await delivery.drain(); expect(messages).toBe(before);
    } finally { await delivery.stop(); unsubscribe(); db.close(); }
  });
});
