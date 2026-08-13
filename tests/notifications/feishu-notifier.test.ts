import { describe, expect, it, vi } from 'vitest';
import { createNotificationService, FeishuGatewayHomeNotifier, FeishuNotifier } from '../../src/notifications/feishu.js';

describe('FeishuNotifier', () => {
  it('sends the pre-formatted completion text as a Feishu interactive Markdown card', async () => {
    const postJson = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });
    const notifier = new FeishuNotifier({
      enabled: true,
      webhook_url: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-token',
    }, { postJson });

    await notifier.notifyTaskCompleted('MetaClaw 旧阻塞任务已完成', {
      taskId: 'task_123',
      title: '后台恢复任务',
      summary: '已经完成恢复后的调研',
      output: 'full output',
      artifactPaths: ['/tmp/report.md'],
      durationMs: 1200,
      executionMode: 'resume-blocked',
      origin: 'system',
    });

    expect(postJson).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/bot/v2/hook/test-token',
      {
        msg_type: 'interactive',
        card: expect.objectContaining({
          elements: [
            expect.objectContaining({
              tag: 'div',
              text: expect.objectContaining({
                tag: 'lark_md',
                content: 'MetaClaw 旧阻塞任务已完成',
              }),
            }),
          ],
        }),
      },
    );
  });

  it('does not format completion text itself (formatting happens once in DeliveryService)', async () => {
    const postJson = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });
    const notifier = new FeishuNotifier({
      enabled: true,
      webhook_url: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-token',
    }, { postJson });

    await notifier.notifyTaskCompleted('exact formatted text', {
      taskId: 'task_fresh',
      title: '新任务',
      summary: '新任务完成',
      output: 'full output',
      artifactPaths: [],
      durationMs: 1200,
      executionMode: 'fresh',
      origin: 'user',
    });

    const body = postJson.mock.calls[0][1] as { card: { elements: Array<{ text: { content: string } }> } };
    expect(body.card.elements[0].text.content).toBe('exact formatted text');
  });

  it('uses Gateway home channel notifications when webhook notifications are not configured', async () => {
    const notifier = createNotificationService({
      version: 1,
      executor: { command: 'codex', timeout: 300 },
      orchestration: {
        max_concurrent_attempts: 4,
        reminder_enabled: true,
        reminder_throttle: 300,
        top_k_preferences: 5,
      },
      ui: { language: 'zh-CN', dashboard_on_start: true },
      gateway: {
        enabled: true,
        platforms: {
          feishu: {
            enabled: true,
            app_id: 'cli_test',
            app_secret_env: 'FEISHU_SECRET',
            home_channel: 'oc_home',
          },
        },
      },
    });

    expect(notifier).toBeInstanceOf(FeishuGatewayHomeNotifier);
  });

  it('sends the pre-formatted completion text through the Gateway home channel', async () => {
    const client = {
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };
    const notifier = new FeishuGatewayHomeNotifier({
      config: {
        enabled: true,
        app_id: 'cli_test',
        app_secret: 'secret',
        event_port: 8787,
        event_path: '/feishu/events',
      },
      homeChannel: 'oc_home',
      client,
    });

    await notifier.notifyTaskCompleted('MetaClaw 旧阻塞任务已完成', {
      taskId: 'task_123',
      title: '后台恢复任务',
      summary: '已经完成恢复后的调研',
      output: 'full output',
      artifactPaths: ['/tmp/report.md'],
      durationMs: 1200,
      executionMode: 'resume-blocked',
      origin: 'system',
    });

    expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith(
      'oc_home',
      'MetaClaw 旧阻塞任务已完成',
    );
  });
});
