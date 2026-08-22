/**
 * Gateway 事件日志端口（ADR-0031 第 8、10 节）。
 *
 * 持久化脱敏后的 Gateway 事件，支持按账户/会话回放。只存 sanitized 投影，
 * 绝不存隐藏思维链、原始 prompt、凭证或未脱敏 stdout/stderr。
 */

import type { GatewayEventEnvelope, GatewayReplay } from './client-events.js';

export interface EventJournal {
  append(event: GatewayEventEnvelope): Promise<GatewayEventEnvelope>;
  appendBatch?(events: GatewayEventEnvelope[]): Promise<GatewayEventEnvelope[]>;
  replay(accountId: string, conversationId: string, afterSequence?: number): Promise<GatewayReplay>;
}
