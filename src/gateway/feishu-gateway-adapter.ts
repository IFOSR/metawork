/**
 * Feishu Gateway 适配器（ADR-0031 第 5、6、7 节）。
 *
 * 把飞书入站消息归一化为版本化 Gateway 命令：发送者身份 + 租户 → Principal，
 * chatId/threadId → bound Conversation 绑定，文本 → user_message 命令。所有
 * 进度/终态/产物交付都来自 Gateway 事件，适配器不直接持有 MetaclawSession。
 */

import type { Principal } from '../account/types.js';
import type { ClientGateway, ClientGatewayResult } from './client-gateway.js';
import type { GatewayCommandEnvelope } from './client-protocol.js';

export interface FeishuSenderIdentity {
  readonly tenantKey: string;
  readonly userId: string;
}

export interface FeishuChannelBinding {
  readonly chatId: string;
  readonly threadId?: string;
}

export interface FeishuGatewayAdapterDeps {
  gateway: ClientGateway;
}

export class FeishuGatewayAdapter {
  constructor(private readonly deps: FeishuGatewayAdapterDeps) {}

  feishuPrincipal(sender: FeishuSenderIdentity): Principal {
    return { kind: 'feishu', id: `${sender.tenantKey}:${sender.userId}` };
  }

  async handleMessage(
    sender: FeishuSenderIdentity,
    channel: FeishuChannelBinding,
    text: string,
    requestId: string,
    idempotencyKey: string,
  ): Promise<ClientGatewayResult> {
    const envelope: GatewayCommandEnvelope = {
      protocolVersion: 1,
      requestId,
      idempotencyKey,
      connectionId: 'feishu',
      conversation: {
        mode: 'bound',
        binding: {
          platform: 'feishu',
          channelId: channel.chatId,
          ...(channel.threadId !== undefined ? { threadId: channel.threadId } : {}),
        },
      },
      command: { kind: 'user_message', text, attachments: [] },
      clientCapabilities: [],
    };
    return this.deps.gateway.handle(envelope, 'feishu', sender);
  }
}
