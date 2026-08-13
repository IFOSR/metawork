import { createHmac } from 'crypto';
import type { Config } from '../core/types.js';
import { createFeishuWebhookMarkdownCard, FeishuAppClient, resolveAppSecret, type FeishuAppConfig } from '../integrations/feishu-app.js';
import { resolveFeishuGatewayConfig, toFeishuAppConfig } from '../gateway/feishu-config.js';
import { NoopNotificationService, type NotificationService, type TaskCompletedNotification } from './types.js';

export interface FeishuNotificationConfig {
  enabled: boolean;
  webhook_url?: string;
  secret?: string;
}

interface JsonResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

interface FeishuNotifierDeps {
  postJson?: (url: string, body: Record<string, unknown>) => Promise<JsonResponse>;
  nowSeconds?: () => number;
}

type FeishuHomeClient = Pick<FeishuAppClient, 'sendMarkdownCardToChat'>;

export function createFeishuSign(timestamp: string, secret: string): string {
  const stringToSign = `${timestamp}\n${secret}`;
  return createHmac('sha256', stringToSign).update('').digest('base64');
}

export class FeishuNotifier implements NotificationService {
  private readonly postJson: (url: string, body: Record<string, unknown>) => Promise<JsonResponse>;
  private readonly nowSeconds: () => number;

  constructor(
    private readonly config: FeishuNotificationConfig,
    deps: FeishuNotifierDeps = {},
  ) {
    this.postJson = deps.postJson ?? defaultPostJson;
    this.nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  async notifyTaskCompleted(text: string, _input: TaskCompletedNotification): Promise<void> {
    if (!this.config.enabled || !this.config.webhook_url) {
      return;
    }

    const body: Record<string, unknown> = {
      msg_type: 'interactive',
      ...createFeishuWebhookMarkdownCard(text),
    };

    if (this.config.secret) {
      const timestamp = String(this.nowSeconds());
      body.timestamp = timestamp;
      body.sign = createFeishuSign(timestamp, this.config.secret);
    }

    const response = await this.postJson(this.config.webhook_url, body);
    if (!response.ok) {
      const responseText = await response.text();
      throw new Error(`飞书任务完成通知发送失败: HTTP ${response.status} ${responseText}`);
    }
  }
}

export class FeishuGatewayHomeNotifier implements NotificationService {
  constructor(
    private readonly input: {
      config: FeishuAppConfig;
      homeChannel: string;
      client?: FeishuHomeClient;
    },
  ) {}

  async notifyTaskCompleted(text: string, _input: TaskCompletedNotification): Promise<void> {
    const client = this.input.client ?? this.createClient();
    await client.sendMarkdownCardToChat(this.input.homeChannel, text);
  }

  private createClient(): FeishuAppClient {
    const appSecret = resolveAppSecret(this.input.config);
    if (!this.input.config.app_id || !appSecret) {
      throw new Error('飞书 Gateway home channel 通知缺少 app_id 或 app_secret');
    }
    return new FeishuAppClient({
      app_id: this.input.config.app_id,
      app_secret: appSecret,
    });
  }
}

async function defaultPostJson(url: string, body: Record<string, unknown>): Promise<JsonResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  return response;
}

export function createNotificationService(config: Config): NotificationService {
  const feishu = config.notifications?.feishu;
  if (feishu?.enabled && feishu.webhook_url) {
    return new FeishuNotifier(feishu);
  }

  const gatewayFeishu = resolveFeishuGatewayConfig(config);
  const homeChannel = config.gateway?.platforms?.feishu?.home_channel;
  if (gatewayFeishu.enabled && gatewayFeishu.appId && homeChannel) {
    return new FeishuGatewayHomeNotifier({
      config: toFeishuAppConfig(gatewayFeishu),
      homeChannel,
    });
  }

  return new NoopNotificationService();
}