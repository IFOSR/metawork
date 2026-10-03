/**
 * Web Gateway 适配器（ADR-0031 第 5 节）。
 *
 * Web 会话流量通过统一 Gateway 门面处理：命令准入、事件回放与订阅。
 * 静态托管与配置管理 HTTP 仍留在 ManagementServer；本适配器只承载会话
 * conversation 流量，绝不直接构造或持有 MetaclawSession。
 */

import type { ClientGateway, ClientGatewayResult } from '../gateway/client-gateway.js';
import type { GatewayEventEnvelope, GatewayReplay } from '../gateway/client-events.js';
import type { TracePage } from '../gateway/event-journal.js';
import type { GatewayCommandEnvelope } from '../gateway/client-protocol.js';
import type { EventJournal } from '../gateway/event-journal.js';
import type { GatewaySubscriptions } from '../gateway/gateway-subscriptions.js';

export interface WebGatewayAdapterDeps {
  gateway: ClientGateway;
  journal: EventJournal;
  subscriptions: GatewaySubscriptions;
  attachClient?: (accountId: string, conversationId: string) => Promise<() => void>;
  restoreWorkspace?: (connectionId: string, workspaceId: string) => void;
  closeConnection?: (connectionId: string) => void;
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

  snapshot(accountId: string, conversationId: string): Promise<GatewayReplay> {
    return this.deps.journal.snapshot?.(accountId, conversationId)
      ?? this.deps.journal.replay(accountId, conversationId);
  }

  /**
   * Historical attachment path. Unlike reconnect, this deliberately replays
   * the retained journal from the beginning so a compact snapshot's bounded
   * Trace suffix cannot hide Planner or Kernel events from Web history.
   */
  history(accountId: string, conversationId: string): Promise<GatewayReplay> {
    return this.deps.journal.replay(accountId, conversationId, 0);
  }

  tracePage(accountId: string, conversationId: string, turnId: string, cursor?: string, limit?: number, latest = false): Promise<TracePage> {
    if (this.deps.journal.readTracePage) {
      return this.deps.journal.readTracePage(accountId, conversationId, turnId, cursor, limit, latest);
    }
    return Promise.resolve({
      turnId, streamRevision: 0, firstSequence: null, lastSequence: null,
      events: [], nextCursor: null,
    });
  }

  subscribe(
    accountId: string,
    conversationId: string | null,
    listener: (event: GatewayEventEnvelope) => void,
    liveConnectionId?: string,
  ): () => void {
    return this.deps.subscriptions.subscribe({
      accountId,
      conversationId,
      liveConnectionId,
      listener,
    });
  }

  attachClient(accountId: string, conversationId: string): Promise<() => void> {
    return this.deps.attachClient?.(accountId, conversationId)
      ?? Promise.resolve(() => undefined);
  }

  restoreWorkspace(connectionId: string, workspaceId: string): void {
    this.deps.restoreWorkspace?.(connectionId, workspaceId);
  }

  closeConnection(connectionId: string): void {
    this.deps.closeConnection?.(connectionId);
  }
}
