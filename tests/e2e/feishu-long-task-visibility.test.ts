import { describe, expect, it, vi } from 'vitest';
import type { GatewayEventEnvelope } from '../../src/gateway/client-events.js';
import type { EventJournal } from '../../src/gateway/event-journal.js';
import type { FeishuGatewayAdapter } from '../../src/gateway/feishu-gateway-adapter.js';
import { FeishuGatewaySessionPort } from '../../src/gateway/feishu-gateway-session-port.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import {
  handleFeishuMessageEvent,
  subscribeFeishuGatewayDeliveries,
} from '../../src/integrations/feishu-app.js';

/**
 * User-perspective E2E for long-task visibility (2026-09-04 plan, revised
 * 2026-09-05): a Feishu user starts a long task; while the executor works
 * through 20 tool steps, hits a heartbeat loss and recovers, the chat must
 * show ONE self-updating activity card (no message flood), immediate
 * milestone one-liners, and finally the answer.
 */

const CHAT_ID = 'oc_chat_1';
const REQUEST_ID = 'om_user_msg_1';
const ORIGIN = { connectionId: `feishu:${CHAT_ID}:`, surface: 'feishu' as const };

let sequence = 0;
function traceEvent(kind: string, title: string, summary: string, extra: Record<string, unknown> = {}) {
  sequence += 1;
  return {
    id: `evt_${sequence}`,
    sequence,
    occurredAt: new Date().toISOString(),
    phase: 'execution',
    actor: kind === 'executor_progress' ? 'executor' : 'runtime',
    kind,
    status: 'running',
    title,
    summary,
    details: {},
    taskId: 'task_1',
    ...extra,
  };
}

function traceDelta(requestId: string, events: Array<Record<string, unknown>>): GatewayEventEnvelope {
  sequence += 1;
  return {
    protocolVersion: 1,
    eventId: `event_${sequence}`,
    sequence,
    accountId: 'local-default',
    conversationId: 'conv_1',
    requestId,
    turnId: 'turn_1',
    kind: 'trace_delta',
    payload: { turnId: 'turn_1', events },
    occurredAt: new Date().toISOString(),
  };
}

function finalAnswer(requestId: string): GatewayEventEnvelope {
  sequence += 1;
  return {
    protocolVersion: 1,
    eventId: `event_${sequence}`,
    sequence,
    accountId: 'local-default',
    conversationId: 'conv_1',
    requestId,
    turnId: 'turn_1',
    kind: 'final_answer',
    payload: { lines: ['任务完成报告：视频号调研结论'] },
    occurredAt: new Date().toISOString(),
  };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('Feishu long-task visibility (user-perspective E2E)', () => {
  it('runs a long task with one updating card, milestone notices and the final answer', async () => {
    const subscriptions = new GatewaySubscriptions();
    const journal: EventJournal = {
      append: async event => event,
      replay: async () => ({ lastSequence: 0, snapshot: [], deltas: [] }),
    };

    let runScript: () => void = () => undefined;
    const adapter = {
      handleMessage: async () => {
        // The executor starts working asynchronously after admission.
        setTimeout(runScript, 0);
        return {
          requestId: REQUEST_ID,
          idempotencyKey: `feishu:${REQUEST_ID}`,
          status: 'accepted',
          conversationId: 'conv_1',
        };
      },
    } as unknown as FeishuGatewayAdapter;

    const port = new FeishuGatewaySessionPort({
      accountId: 'local-default',
      tenantKey: 'tenant_1',
      adapter,
      journal,
      subscriptions,
      timeoutMs: 30_000,
      activityCardMinIntervalMs: 5,
    });

    let sendCounter = 0;
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_1'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn(async () => `om_send_${(sendCounter += 1)}`),
      updateMarkdownCard: vi.fn().mockResolvedValue(true),
    };
    subscribeFeishuGatewayDeliveries({
      session: port as never,
      client: client as never,
      cardDeliveryOptions: { updateCooldownMs: 0 },
    });

    runScript = () => {
      void (async () => {
        subscriptions.publish(traceDelta(REQUEST_ID, [
          traceEvent('subtask_execution_started', 'Executing Subtask: 收集视频号数据', '', { subtaskId: 'sub_1' }),
        ]), ORIGIN);
        for (let step = 1; step <= 20; step += 1) {
          subscriptions.publish(traceDelta(REQUEST_ID, [
            traceEvent('executor_progress', 'Executor progress: skill', `Executor started tool: web_search — 查询 ${step}`),
          ]), ORIGIN);
          if (step % 5 === 0) await sleep(10); // let the throttled card repaint fire
        }
        subscriptions.publish(traceDelta(REQUEST_ID, [
          traceEvent('kernel_decision', 'heartbeat_lost: retry scheduled', 'Kernel 正在恢复执行器'),
        ]), ORIGIN);
        await sleep(10);
        subscriptions.publish(traceDelta(REQUEST_ID, [
          traceEvent('executor_progress', 'Executor progress: skill', 'Executor started tool: web_fetch — 恢复后继续'),
        ]), ORIGIN);
        await sleep(10);
        subscriptions.publish(finalAnswer(REQUEST_ID), ORIGIN);
      })();
    };

    await handleFeishuMessageEvent({
      sender: { sender_id: { open_id: 'ou_user' } },
      message: {
        message_id: REQUEST_ID,
        chat_id: CHAT_ID,
        chat_type: 'p2p',
        message_type: 'text',
        content: '{"text":"帮我调研视频号"}',
      },
    }, {
      session: port as never,
      client: client as never,
      seenMessageIds: new Set<string>(),
      // Wall-clock update throttling is covered by the card delivery machine
      // unit tests; this user-perspective E2E observes the governance rules
      // (one card, in-place updates, no flood) at compressed speed.
      cardDeliveryOptions: { updateCooldownMs: 0 },
    });
    await sleep(20);

    const sentTexts = client.sendMarkdownCardToChat.mock.calls.map(([, markdown]) => String(markdown));

    // 1. The final answer reached the chat.
    expect(sentTexts.some(text => text.includes('任务完成报告'))).toBe(true);

    // 2. Chat-tier milestones arrive as one-line notices; card-tier events
    //    (subtask start) never interrupt the chat.
    expect(sentTexts.some(text => text.includes('heartbeat_lost'))).toBe(true);
    expect(sentTexts.some(text => text.includes('Executing Subtask: 收集视频号数据'))).toBe(false);

    // 3. Exactly ONE activity card message was created for the 21 steps;
    //    every later repaint went through in-place updates on that message.
    const cardSends = sentTexts.filter(text => text.includes('**任务执行中**'));
    expect(cardSends).toHaveLength(1);
    expect(client.updateMarkdownCard.mock.calls.length).toBeGreaterThan(0);
    const updateTargetIds = new Set(client.updateMarkdownCard.mock.calls.map(([id]) => id));
    expect(updateTargetIds.size).toBe(1);

    // 4. Card updates carried live step detail; the final edit is the receipt.
    const allCardUpdates = client.updateMarkdownCard.mock.calls.map(([, markdown]) => String(markdown));
    expect(allCardUpdates.some(text => text.includes('web_search') && text.includes('收集视频号数据'))).toBe(true);
    const lastCardUpdate = allCardUpdates.at(-1) ?? '';
    expect(lastCardUpdate).toContain('任务已完成');
    expect(lastCardUpdate).toContain('收集视频号数据');

    // 5. No per-step message flood: total sends stay tiny despite 21 steps.
    expect(client.sendMarkdownCardToChat.mock.calls.length).toBeLessThanOrEqual(5);

    // 6. Background activity after the answer converges into the live card
    //    (first live paint is a new card, later repaints update in place).
    subscriptions.publish(traceDelta('req_background', [
      traceEvent('executor_progress', 'Executor progress: skill', 'Executor started tool: web_fetch — 后台续跑'),
    ]), ORIGIN);
    await sleep(20);
    const postFinalSends = client.sendMarkdownCardToChat.mock.calls.map(([, markdown]) => String(markdown));
    expect(postFinalSends.some(text => text.includes('后台续跑'))).toBe(true);
    subscriptions.publish(traceDelta('req_background', [
      traceEvent('executor_progress', 'Executor progress: skill', 'Executor started tool: web_fetch — 后台续跑 2'),
    ]), ORIGIN);
    await sleep(20);
    const liveUpdates = client.updateMarkdownCard.mock.calls.filter(([, markdown]) =>
      String(markdown).includes('后台续跑 2'));
    expect(liveUpdates.length).toBeGreaterThan(0);
  });
});
