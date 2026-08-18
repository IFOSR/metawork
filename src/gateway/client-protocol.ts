/**
 * 版本化 Gateway 命令入口契约（ADR-0031 第 8 节）。
 *
 * 客户端只能提供非信任字段；`accountId` 与 `principal` 由服务端在认证后
 * 注入（`AuthenticatedGatewayCommand`）。解析器拒绝任何携带受信身份字段的
 * 客户端载荷。
 *
 * 纯协议模块：不 import repository / socket / http / planner / kernel /
 * executor 实现。
 */

import type { AccountId, Principal } from '../account/types.js';
import type { ConversationSelection } from '../session/conversation-types.js';

export const GATEWAY_PROTOCOL_VERSION = 1;

export interface GatewayAttachmentRef {
  readonly attachmentId: string;
  readonly kind: string;
}

export type GatewayCommand =
  | { readonly kind: 'user_message'; readonly text: string; readonly attachments: GatewayAttachmentRef[] }
  | { readonly kind: 'slash_command'; readonly text: string }
  | { readonly kind: 'permission_resolution'; readonly requestId: string; readonly resolution: 'approve' | 'deny' }
  | { readonly kind: 'cancel_turn'; readonly turnId: string };

export interface GatewayCommandEnvelope {
  readonly protocolVersion: typeof GATEWAY_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly connectionId: string;
  readonly conversation: ConversationSelection;
  readonly command: GatewayCommand;
  readonly resumeFromSequence?: number;
  readonly clientCapabilities: string[];
}

/** 服务端认证后注入 Principal 与 Account 身份的完整命令。 */
export interface AuthenticatedGatewayCommand extends GatewayCommandEnvelope {
  readonly principal: Principal;
  readonly accountId: AccountId;
}

export function parseGatewayCommandEnvelope(input: unknown): GatewayCommandEnvelope | null {
  if (typeof input !== 'object' || input === null) return null;
  const candidate = input as Record<string, unknown>;

  // 客户端绝不能携带受信身份字段。
  if ('accountId' in candidate || 'principal' in candidate) return null;

  if (candidate.protocolVersion !== GATEWAY_PROTOCOL_VERSION) return null;
  if (!isNonEmptyString(candidate.requestId)) return null;
  if (!isNonEmptyString(candidate.idempotencyKey)) return null;
  if (!isNonEmptyString(candidate.connectionId)) return null;

  const conversation = parseConversationSelection(candidate.conversation);
  if (!conversation) return null;

  const command = parseGatewayCommand(candidate.command);
  if (!command) return null;

  if (!Array.isArray(candidate.clientCapabilities)
    || !candidate.clientCapabilities.every(isNonEmptyString)) {
    return null;
  }

  if (candidate.resumeFromSequence !== undefined) {
    const sequence = candidate.resumeFromSequence;
    if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 0) {
      return null;
    }
  }

  return {
    protocolVersion: GATEWAY_PROTOCOL_VERSION,
    requestId: candidate.requestId,
    idempotencyKey: candidate.idempotencyKey,
    connectionId: candidate.connectionId,
    conversation,
    command,
    ...(candidate.resumeFromSequence !== undefined
      ? { resumeFromSequence: candidate.resumeFromSequence as number }
      : {}),
    clientCapabilities: candidate.clientCapabilities as string[],
  };
}

function parseConversationSelection(input: unknown): ConversationSelection | null {
  if (typeof input !== 'object' || input === null) return null;
  const candidate = input as Record<string, unknown>;

  if (candidate.mode === 'new') {
    return { mode: 'new' };
  }
  if (candidate.mode === 'attach') {
    if (!isNonEmptyString(candidate.conversationId)) return null;
    return { mode: 'attach', conversationId: candidate.conversationId };
  }
  if (candidate.mode === 'bound') {
    if (typeof candidate.binding !== 'object' || candidate.binding === null) return null;
    const binding = candidate.binding as Record<string, unknown>;
    if (!isNonEmptyString(binding.platform) || !isNonEmptyString(binding.channelId)) return null;
    if (binding.threadId !== undefined && !isNonEmptyString(binding.threadId)) return null;
    return {
      mode: 'bound',
      binding: {
        platform: binding.platform,
        channelId: binding.channelId,
        ...(binding.threadId !== undefined ? { threadId: binding.threadId as string } : {}),
      },
    };
  }
  return null;
}

function parseGatewayCommand(input: unknown): GatewayCommand | null {
  if (typeof input !== 'object' || input === null) return null;
  const candidate = input as Record<string, unknown>;

  if (candidate.kind === 'user_message') {
    if (!isNonEmptyString(candidate.text)) return null;
    if (!Array.isArray(candidate.attachments)
      || !candidate.attachments.every(isValidAttachmentRef)) {
      return null;
    }
    return {
      kind: 'user_message',
      text: candidate.text,
      attachments: candidate.attachments as GatewayAttachmentRef[],
    };
  }
  if (candidate.kind === 'slash_command') {
    if (!isNonEmptyString(candidate.text)) return null;
    return { kind: 'slash_command', text: candidate.text };
  }
  if (candidate.kind === 'permission_resolution') {
    if (!isNonEmptyString(candidate.requestId)) return null;
    if (candidate.resolution !== 'approve' && candidate.resolution !== 'deny') return null;
    return {
      kind: 'permission_resolution',
      requestId: candidate.requestId,
      resolution: candidate.resolution,
    };
  }
  if (candidate.kind === 'cancel_turn') {
    if (!isNonEmptyString(candidate.turnId)) return null;
    return { kind: 'cancel_turn', turnId: candidate.turnId };
  }
  return null;
}

function isValidAttachmentRef(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const candidate = input as Record<string, unknown>;
  return isNonEmptyString(candidate.attachmentId) && isNonEmptyString(candidate.kind);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
