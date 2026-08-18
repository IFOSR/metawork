/**
 * Gateway 订阅（ADR-0031 第 10 节）。
 *
 * 事件中心按已授权账户与可选会话过滤发布。订阅只接收授权范围内的事件。
 */

import type { GatewayEventEnvelope } from './client-events.js';

export interface GatewaySubscription {
  readonly accountId: string;
  readonly conversationId: string | null;
  readonly listener: (event: GatewayEventEnvelope) => void;
}

export class GatewaySubscriptions {
  private readonly subscriptions = new Set<GatewaySubscription>();

  subscribe(subscription: GatewaySubscription): () => void {
    this.subscriptions.add(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  publish(event: GatewayEventEnvelope): void {
    for (const subscription of this.subscriptions) {
      if (subscription.accountId !== event.accountId) continue;
      if (subscription.conversationId !== null
        && subscription.conversationId !== event.conversationId) {
        continue;
      }
      subscription.listener(event);
    }
  }
}
