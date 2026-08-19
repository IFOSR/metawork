import type { GatewayEventEnvelope } from './client-events.js';
import {
  isGatewayCommandText,
  isGatewayIdentifier,
  parseGatewayCommandEnvelope,
  type GatewayCommandEnvelope,
} from './client-protocol.js';
import type { CommandReceipt } from './command-admission.js';

export type GatewayClientMessage =
  | {
      type: 'input';
      text: string;
      conversationId?: string;
      requestId?: string;
      idempotencyKey?: string;
    }
  | {
      type: 'attach';
      conversationId: string;
      resumeFromSequence?: number;
    }
  | {
      type: 'command';
      envelope: GatewayCommandEnvelope;
    }
  | {
      type: 'close';
    };

export type GatewayServerMessage =
  | {
      type: 'hello';
      sessionId: string;
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
      type: 'exit';
    }
  | {
      type: 'error';
      message: string;
      requestId?: string;
      event?: GatewayEventEnvelope;
    };

export function parseGatewayClientMessage(input: unknown): GatewayClientMessage | null {
  if (typeof input !== 'object' || input === null) return null;
  const candidate = input as Record<string, unknown>;

  if (candidate.type === 'close') return { type: 'close' };
  if (candidate.type === 'attach') {
    if (!isGatewayIdentifier(candidate.conversationId)) return null;
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
      conversationId: candidate.conversationId,
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
