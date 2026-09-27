/**
 * Gateway 事件日志端口（ADR-0031 第 8、10 节）。
 *
 * 持久化脱敏后的 Gateway 事件，支持按账户/会话回放。只存 sanitized 投影，
 * 绝不存隐藏思维链、原始 prompt、凭证或未脱敏 stdout/stderr。
 */

import type { GatewayEventEnvelope, GatewayReplay } from './client-events.js';
import type { TurnTaskObservation } from './turn-task-observation.js';

export interface EventJournal {
  /** Exact indexed historical evidence plus the watermark from the same serialized read. */
  readTurnTaskObservation?(accountId: string, conversationId: string, turnId: string): Promise<{
    lastSequence: number; observation: TurnTaskObservation | null;
  }>;
  /** Migration must preserve retained event identity, not synthesize replay summaries. */
  exportRetained?(accountId: string, conversationId: string): Promise<{
    lastSequence: number; events: GatewayEventEnvelope[];
  }>;
  snapshot?(accountId: string, conversationId: string): Promise<import('./event-journal-segment-index.js').ConversationSnapshot>;
  /** Client reconnect is bounded; replay remains the explicit audit/recovery path. */
  resume?(accountId: string, conversationId: string, afterSequence: number): Promise<GatewayReplay>;
  append(event: GatewayEventEnvelope): Promise<GatewayEventEnvelope>;
  appendBatch?(events: GatewayEventEnvelope[]): Promise<GatewayEventEnvelope[]>;
  replay(accountId: string, conversationId: string, afterSequence?: number): Promise<GatewayReplay>;
  /**
   * 为不持久的连接流只读响应分配序号（统一 TUI 设计 §9.3）。
   * 与同一流上的持久事件共用序号分配器：返回的序号单调递增且不会被后续
   * append 复用，但不写入任何持久事件正文。
   */
  reserveSequence?(accountId: string, conversationId: string): Promise<number>;
  /** 流的当前水位；无事件时为 0。 */
  lastSequence?(accountId: string, conversationId: string): Promise<number>;
}
