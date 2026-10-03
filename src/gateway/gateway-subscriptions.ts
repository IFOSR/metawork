/**
 * Gateway 订阅（ADR-0031 第 10 节）。
 *
 * 事件中心按已授权账户与可选会话过滤发布。订阅只接收授权范围内的事件。
 */

import type { GatewayEventEnvelope } from './client-events.js';
import type { GatewayTurnOrigin } from './gateway-delivery-context.js';

export interface GatewaySubscription {
  readonly accountId: string;
  readonly conversationId: string | null;
  readonly liveConnectionId?: string;
  /** External notifications select destinations separately from observation rights. */
  readonly deliveryFilter?: (event: GatewayEventEnvelope, origin?: GatewayTurnOrigin) => boolean;
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

  publish(event: GatewayEventEnvelope, target?: GatewayTurnOrigin): void {
    for (const subscription of this.subscriptions) {
      if (subscription.accountId !== event.accountId) continue;
      if (subscription.conversationId !== null
        && subscription.conversationId !== event.conversationId) {
        continue;
      }
      // A history query is a connection reply, not a shared business fact.
      if (event.kind === 'conversation_history_page') {
        if (!target || subscription.liveConnectionId !== target.connectionId) continue;
      }
      try {
        if (subscription.deliveryFilter && !subscription.deliveryFilter(event, target)) continue;
        subscription.listener(event);
      } catch {
        // One slow or faulty client must not change the durable publish result
        // or prevent other authorized subscribers from receiving the event.
      }
    }
  }
}
