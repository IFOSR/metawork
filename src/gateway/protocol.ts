import { isDesktopNonce, type DesktopSessionGrant } from './desktop-session-contract.js';
import type { GatewayEventEnvelope } from './client-events.js';
import {
  isGatewayCommandText,
  isGatewayIdentifier,
  parseGatewayCommandEnvelope,
  type GatewayCommandEnvelope,
} from './client-protocol.js';
import type { CommandReceipt } from './command-admission.js';
import type { ConversationObservationFrame } from './conversation-observation.js';
import type { ConversationViewCursor } from '../session/conversation-read-model.js';

export type GatewayClientMessage =
  | { type: 'request_server_stop'; nonce: string; pid: number; startedAt: string }
  | { type: 'register_desktop_session'; nonce: string }
  | { type: 'observe'; connectionId: string; observationId: string; conversationId: string; cursor?: ConversationViewCursor }
  | { type: 'unobserve'; observationId: string }
  | {
      type: 'input';
      text: string;
      conversationId?: string;
      requestId?: string;
      idempotencyKey?: string;
    }
  | {
      type: 'attach';
      connectionId: string;
      conversationId: string;
      resumeFromSequence?: number;
      acceptCursorReset?: boolean;
    }
  | {
      type: 'command';
      envelope: GatewayCommandEnvelope;
    }
  | {
      type: 'register_web_launch';
      workspaceHint: string;
      conversationId?: string;
    }
  | {
      type: 'close';
    };

export type GatewayServerMessage =
  | { type: 'server_stop_accepted'; nonce: string }
  | { type: 'desktop_session_registered'; grant: DesktopSessionGrant }
  | { type: 'observation'; frame: ConversationObservationFrame }
  | {
      type: 'hello';
      identity?: { serverId: string; accountId: string };
      sessionId: string;
      attached: boolean;
      /** Gateway v2 显式能力清单（ADR-0031 / 统一 TUI 设计 §9.4）。 */
      capabilities: string[];
      lastSequence?: number;
    }
  | {
      type: 'replay_reset';
      conversationId: string;
      lastSequence: number;
      reason: 'cursor_ahead' | 'cursor_expired' | 'replay_budget_exceeded';
      snapshotVersion: 1;
    }
  | {
      type: 'output';
      lines: string[];
      event: GatewayEventEnvelope;
    }
  | {
      type: 'event';
      event: GatewayEventEnvelope;
    }
  | {
      type: 'receipt';
      receipt: CommandReceipt;
    }
  | {
      type: 'web_launch_registered';
      token: string;
      expiresAt: string;
    }
  | {
      type: 'exit';
    }
  | {
      type: 'error';
      message: string;
      requestId?: string;
      code?: string;
      agentId?: string;
      event?: GatewayEventEnvelope;
    };

export function parseGatewayClientMessage(input: unknown): GatewayClientMessage | null {
  if (typeof input !== 'object' || input === null) return null;
  const candidate = input as Record<string, unknown>;

  if (candidate.type === 'request_server_stop') {
    return Object.keys(candidate).every(key => ['type', 'nonce', 'pid', 'startedAt'].includes(key))
      && isDesktopNonce(candidate.nonce) && Number.isSafeInteger(candidate.pid) && (candidate.pid as number) > 0
      && typeof candidate.startedAt === 'string' && candidate.startedAt.length > 0 && candidate.startedAt.length <= 64
      ? { type: 'request_server_stop', nonce: candidate.nonce, pid: candidate.pid as number, startedAt: candidate.startedAt } : null;
  }

  if (candidate.type === 'unobserve') {
    return Object.keys(candidate).every(key => ['type', 'observationId'].includes(key))
      && isGatewayIdentifier(candidate.observationId)
      ? { type: 'unobserve', observationId: candidate.observationId } : null;
  }
  if (candidate.type === 'observe') {
    if (!Object.keys(candidate).every(key => ['type', 'connectionId', 'observationId', 'conversationId', 'cursor'].includes(key))
      || !isGatewayIdentifier(candidate.connectionId) || !isGatewayIdentifier(candidate.observationId)
      || !isGatewayIdentifier(candidate.conversationId)) return null;
    let cursor: ConversationViewCursor | undefined;
    if (candidate.cursor !== undefined) {
      if (!candidate.cursor || typeof candidate.cursor !== 'object' || Array.isArray(candidate.cursor)) return null;
      const value = candidate.cursor as Record<string, unknown>;
      if (!Object.keys(value).every(key => ['epoch', 'revision'].includes(key))
        || !isGatewayIdentifier(value.epoch) || typeof value.revision !== 'number'
        || !Number.isSafeInteger(value.revision) || value.revision < 0) return null;
      cursor = { epoch: value.epoch, revision: value.revision };
    }
    return { type: 'observe', connectionId: candidate.connectionId,
      observationId: candidate.observationId, conversationId: candidate.conversationId, ...(cursor ? { cursor } : {}) };
  }

  if (candidate.type === 'register_desktop_session') {
    return Object.keys(candidate).every(key => ['type', 'nonce'].includes(key))
      && isDesktopNonce(candidate.nonce)
      ? { type: 'register_desktop_session', nonce: candidate.nonce } : null;
  }
  if (candidate.type === 'close') return { type: 'close' };
  if (candidate.type === 'register_web_launch') {
    const allowedKeys = new Set(['type', 'workspaceHint', 'conversationId']);
    if (Object.keys(candidate).some(key => !allowedKeys.has(key))) return null;
    if (
      typeof candidate.workspaceHint !== 'string'
      || candidate.workspaceHint.length === 0
      || candidate.workspaceHint.length > 16_384
    ) return null;
    if (
      candidate.conversationId !== undefined
      && !isGatewayIdentifier(candidate.conversationId)
    ) return null;
    return {
      type: 'register_web_launch',
      workspaceHint: candidate.workspaceHint,
      ...(candidate.conversationId !== undefined
        ? { conversationId: candidate.conversationId as string }
        : {}),
    };
  }
  if (candidate.type === 'attach') {
    if (
      !isGatewayIdentifier(candidate.connectionId)
      || !isGatewayIdentifier(candidate.conversationId)
    ) return null;
    if (candidate.acceptCursorReset !== undefined && typeof candidate.acceptCursorReset !== 'boolean') return null;
    if (
      candidate.resumeFromSequence !== undefined
      && (
        typeof candidate.resumeFromSequence !== 'number'
        || !Number.isSafeInteger(candidate.resumeFromSequence)
        || candidate.resumeFromSequence < 0
      )
    ) {
      return null;
    }
    return {
      type: 'attach',
      connectionId: candidate.connectionId,
      conversationId: candidate.conversationId,
      ...(candidate.acceptCursorReset !== undefined ? { acceptCursorReset: candidate.acceptCursorReset as boolean } : {}),
      ...(candidate.resumeFromSequence !== undefined
        ? { resumeFromSequence: candidate.resumeFromSequence as number }
        : {}),
    };
  }
  if (candidate.type === 'command') {
    const envelope = parseGatewayCommandEnvelope(candidate.envelope);
    return envelope ? { type: 'command', envelope } : null;
  }
  if (candidate.type === 'input') {
    if (!isGatewayCommandText(candidate.text)) return null;
    if (
      candidate.conversationId !== undefined
      && !isGatewayIdentifier(candidate.conversationId)
    ) return null;
    if (candidate.requestId !== undefined && !isGatewayIdentifier(candidate.requestId)) return null;
    if (
      candidate.idempotencyKey !== undefined
      && !isGatewayIdentifier(candidate.idempotencyKey)
    ) return null;
    return {
      type: 'input',
      text: candidate.text,
      ...(candidate.conversationId !== undefined
        ? { conversationId: candidate.conversationId as string }
        : {}),
      ...(candidate.requestId !== undefined ? { requestId: candidate.requestId as string } : {}),
      ...(candidate.idempotencyKey !== undefined
        ? { idempotencyKey: candidate.idempotencyKey as string }
        : {}),
    };
  }
  return null;
}
