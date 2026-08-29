/**
 * Gateway 订阅（ADR-0031 第 10 节）。
 *
 * 事件中心按已授权账户与可选会话过滤发布。订阅只接收授权范围内的事件。
 */

import type { GatewayEventEnvelope, GatewayEventKind } from './client-events.js';
import type { GatewayTurnOrigin } from './gateway-delivery-context.js';

const ORIGIN_SCOPED_EVENT_KINDS = new Set<GatewayEventKind>([
  'conversation_snapshot',
  'conversation_history_page',
  'turn_started',
  'trace_delta',
  'task_projection',
  'execution_delta',
  'permission_request',
  'artifact',
  'result_delivery_available',
  'result_chunk',
  'result_completed',
  'final_answer',
  'terminal_error',
  'delivery_status',
]);

export interface GatewaySubscription {
  readonly accountId: string;
  readonly conversationId: string | null;
  readonly liveConnectionId?: string;
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
      if (ORIGIN_SCOPED_EVENT_KINDS.has(event.kind)) {
        if (!target || subscription.liveConnectionId !== target.connectionId) continue;
      }
      try {
        subscription.listener(event);
      } catch {
        // One slow or faulty client must not change the durable publish result
        // or prevent other authorized subscribers from receiving the event.
      }
    }
  }
}
