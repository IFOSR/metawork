/**
 * Web Gateway 适配器（ADR-0031 第 5 节）。
 *
 * Web 会话流量通过统一 Gateway 门面处理：命令准入、事件回放与订阅。
 * 静态托管与配置管理 HTTP 仍留在 ManagementServer；本适配器只承载会话
 * conversation 流量，绝不直接构造或持有 MetaclawSession。
 */

import type { ClientGateway, ClientGatewayResult } from '../gateway/client-gateway.js';
import type { GatewayEventEnvelope, GatewayReplay } from '../gateway/client-events.js';
import type { GatewayCommandEnvelope } from '../gateway/client-protocol.js';
import type { EventJournal } from '../gateway/event-journal.js';
import type { GatewaySubscriptions } from '../gateway/gateway-subscriptions.js';

export interface WebGatewayAdapterDeps {
  gateway: ClientGateway;
  journal: EventJournal;
  subscriptions: GatewaySubscriptions;
  attachClient?: (accountId: string, conversationId: string) => Promise<() => void>;
}

export class WebGatewayAdapter {
  constructor(private readonly deps: WebGatewayAdapterDeps) {}

  submit(envelope: GatewayCommandEnvelope): Promise<ClientGatewayResult> {
    return this.deps.gateway.handle(envelope, 'web');
  }

  replay(
    accountId: string,
    conversationId: string,
    afterSequence?: number,
  ): Promise<GatewayReplay> {
    return this.deps.journal.replay(accountId, conversationId, afterSequence);
  }

  subscribe(
    accountId: string,
    conversationId: string | null,
    listener: (event: GatewayEventEnvelope) => void,
  ): () => void {
    return this.deps.subscriptions.subscribe({ accountId, conversationId, listener });
  }

  attachClient(accountId: string, conversationId: string): Promise<() => void> {
    return this.deps.attachClient?.(accountId, conversationId)
      ?? Promise.resolve(() => undefined);
  }
}
