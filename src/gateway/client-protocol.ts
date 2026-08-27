import type { AccountId, Principal } from '../account/types.js';
import type { ConversationSelection } from '../session/conversation-types.js';

export const GATEWAY_PROTOCOL_VERSION = 2;
export const MAX_GATEWAY_ID_BYTES = 256;
export const MAX_GATEWAY_COMMAND_TEXT_BYTES = 128 * 1024;
export const MAX_GATEWAY_ATTACHMENTS = 32;
export const MAX_GATEWAY_CAPABILITIES = 32;
export const MAX_GATEWAY_CAPABILITY_BYTES = 128;

export interface GatewayAttachmentRef {
  readonly attachmentId: string;
  readonly kind: string;
}

export type GatewayScope =
  | { readonly kind: 'workspace' }
  | { readonly kind: 'conversation'; readonly selection: ConversationSelection };

export type GatewayCommand =
  | { readonly kind: 'select_workspace'; readonly path: string }
  | { readonly kind: 'list_workspace_conversations'; readonly workspaceId: string; readonly cursor?: string; readonly query?: string }
  | { readonly kind: 'create_conversation'; readonly workspaceId: string }
  | { readonly kind: 'archive_conversation'; readonly conversationId: string }
  | { readonly kind: 'attach_conversation'; readonly conversationId: string }
  | { readonly kind: 'get_conversation_history'; readonly conversationId: string; readonly cursor?: string; readonly limit?: number }
  | { readonly kind: 'user_message'; readonly text: string; readonly attachments: GatewayAttachmentRef[] }
  | { readonly kind: 'slash_command'; readonly text: string }
  | { readonly kind: 'permission_resolution'; readonly requestId: string; readonly resolution: 'approve' | 'deny' }
  | { readonly kind: 'cancel_turn'; readonly turnId: string };

export interface GatewayCommandEnvelope {
  readonly protocolVersion: typeof GATEWAY_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly connectionId: string;
  readonly scope: GatewayScope;
  readonly command: GatewayCommand;
  readonly resumeFromSequence?: number;
  readonly clientCapabilities: string[];
}

export interface AuthenticatedGatewayCommand extends GatewayCommandEnvelope {
  readonly principal: Principal;
  readonly accountId: AccountId;
}

export function parseGatewayCommandEnvelope(input: unknown): GatewayCommandEnvelope | null {
  if (!isRecord(input) || !hasOnlyKeys(input, [
    'protocolVersion', 'requestId', 'idempotencyKey', 'connectionId', 'scope',
    'command', 'resumeFromSequence', 'clientCapabilities',
  ])) return null;
  if (input.protocolVersion !== GATEWAY_PROTOCOL_VERSION
    || !isGatewayIdentifier(input.requestId)
    || !isGatewayIdentifier(input.idempotencyKey)
    || !isGatewayIdentifier(input.connectionId)) return null;
  const scope = parseScope(input.scope);
  const command = parseCommand(input.command);
  if (!scope || !command || !matchesScope(scope, command)) return null;
  if (!Array.isArray(input.clientCapabilities)
    || input.clientCapabilities.length > MAX_GATEWAY_CAPABILITIES
    || !input.clientCapabilities.every(value => isBoundedString(value, MAX_GATEWAY_CAPABILITY_BYTES))) {
    return null;
  }
  if (input.resumeFromSequence !== undefined
    && (typeof input.resumeFromSequence !== 'number'
      || !Number.isSafeInteger(input.resumeFromSequence)
      || input.resumeFromSequence < 0)) return null;
  return {
    protocolVersion: GATEWAY_PROTOCOL_VERSION,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    connectionId: input.connectionId,
    scope,
    command,
    ...(input.resumeFromSequence !== undefined ? { resumeFromSequence: input.resumeFromSequence as number } : {}),
    clientCapabilities: input.clientCapabilities as string[],
  };
}

function parseScope(value: unknown): GatewayScope | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'workspace' && hasOnlyKeys(value, ['kind'])) return { kind: 'workspace' };
  if (value.kind !== 'conversation' || !hasOnlyKeys(value, ['kind', 'selection'])) return null;
  const selection = parseSelection(value.selection);
  return selection ? { kind: 'conversation', selection } : null;
}

function parseSelection(value: unknown): ConversationSelection | null {
  if (!isRecord(value)) return null;
  if (value.mode === 'new') {
    return hasOnlyKeys(value, ['mode', 'workspaceId']) && isGatewayIdentifier(value.workspaceId)
      ? { mode: 'new', workspaceId: value.workspaceId }
      : null;
  }
  if (value.mode === 'attach') {
    return hasOnlyKeys(value, ['mode', 'conversationId']) && isGatewayIdentifier(value.conversationId)
      ? { mode: 'attach', conversationId: value.conversationId }
      : null;
  }
  if (value.mode !== 'bound' || !hasOnlyKeys(value, ['mode', 'binding']) || !isRecord(value.binding)) {
    return null;
  }
  const binding = value.binding;
  if (!hasOnlyKeys(binding, ['platform', 'channelId', 'threadId'])
    || !isGatewayIdentifier(binding.platform)
    || !isGatewayIdentifier(binding.channelId)
    || (binding.threadId !== undefined && !isGatewayIdentifier(binding.threadId))) return null;
  return {
    mode: 'bound',
    binding: {
      platform: binding.platform,
      channelId: binding.channelId,
      ...(binding.threadId !== undefined ? { threadId: binding.threadId as string } : {}),
    },
  };
}

function parseCommand(value: unknown): GatewayCommand | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'select_workspace') {
    return hasOnlyKeys(value, ['kind', 'path']) && isGatewayCommandText(value.path)
      ? { kind: value.kind, path: value.path } : null;
  }
  if (value.kind === 'list_workspace_conversations') {
    if (!hasOnlyKeys(value, ['kind', 'workspaceId', 'cursor', 'query'])
      || !isGatewayIdentifier(value.workspaceId)
      || (value.cursor !== undefined && !isGatewayIdentifier(value.cursor))
      || (value.query !== undefined && !isGatewayCommandText(value.query))) return null;
    return {
      kind: value.kind,
      workspaceId: value.workspaceId,
      ...(value.cursor !== undefined ? { cursor: value.cursor as string } : {}),
      ...(value.query !== undefined ? { query: value.query as string } : {}),
    };
  }
  if (value.kind === 'create_conversation') {
    return hasOnlyKeys(value, ['kind', 'workspaceId']) && isGatewayIdentifier(value.workspaceId)
      ? { kind: value.kind, workspaceId: value.workspaceId } : null;
  }
  if (value.kind === 'archive_conversation' || value.kind === 'attach_conversation') {
    return hasOnlyKeys(value, ['kind', 'conversationId']) && isGatewayIdentifier(value.conversationId)
      ? { kind: value.kind, conversationId: value.conversationId } : null;
  }
  if (value.kind === 'get_conversation_history') {
    if (!hasOnlyKeys(value, ['kind', 'conversationId', 'cursor', 'limit'])
      || !isGatewayIdentifier(value.conversationId)
      || (value.cursor !== undefined && !isGatewayIdentifier(value.cursor))
      || (value.limit !== undefined && (
        typeof value.limit !== 'number' || !Number.isSafeInteger(value.limit)
      ))) return null;
    return {
      kind: value.kind,
      conversationId: value.conversationId,
      ...(value.cursor !== undefined ? { cursor: value.cursor as string } : {}),
      ...(value.limit !== undefined ? { limit: value.limit as number } : {}),
    };
  }
  if (value.kind === 'user_message') {
    if (!hasOnlyKeys(value, ['kind', 'text', 'attachments'])
      || !isGatewayCommandText(value.text)
      || !Array.isArray(value.attachments)
      || value.attachments.length > MAX_GATEWAY_ATTACHMENTS
      || !value.attachments.every(isAttachment)) return null;
    return { kind: value.kind, text: value.text, attachments: value.attachments as GatewayAttachmentRef[] };
  }
  if (value.kind === 'slash_command') {
    return hasOnlyKeys(value, ['kind', 'text']) && isGatewayCommandText(value.text)
      ? { kind: value.kind, text: value.text } : null;
  }
  if (value.kind === 'permission_resolution') {
    return hasOnlyKeys(value, ['kind', 'requestId', 'resolution'])
      && isGatewayIdentifier(value.requestId)
      && (value.resolution === 'approve' || value.resolution === 'deny')
      ? { kind: value.kind, requestId: value.requestId, resolution: value.resolution }
      : null;
  }
  if (value.kind === 'cancel_turn') {
    return hasOnlyKeys(value, ['kind', 'turnId']) && isGatewayIdentifier(value.turnId)
      ? { kind: value.kind, turnId: value.turnId } : null;
  }
  return null;
}

function matchesScope(scope: GatewayScope, command: GatewayCommand): boolean {
  const workspace = ['select_workspace', 'list_workspace_conversations', 'create_conversation', 'archive_conversation']
    .includes(command.kind);
  if (workspace) return scope.kind === 'workspace';
  if (scope.kind !== 'conversation') return false;
  if (command.kind === 'attach_conversation' || command.kind === 'get_conversation_history') {
    return scope.selection.mode === 'attach'
      && scope.selection.conversationId === command.conversationId;
  }
  return true;
}

function isAttachment(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ['attachmentId', 'kind'])
    && isGatewayIdentifier(value.attachmentId)
    && isBoundedString(value.kind, MAX_GATEWAY_CAPABILITY_BYTES);
}

export function isGatewayIdentifier(value: unknown): value is string {
  return isBoundedString(value, MAX_GATEWAY_ID_BYTES);
}

export function isGatewayCommandText(value: unknown): value is string {
  return isBoundedString(value, MAX_GATEWAY_COMMAND_TEXT_BYTES);
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every(key => allowed.has(key));
}
