import type { GatewayInboundEvent } from './types.js';

export function formatFeishuWorkspaceConfirmation(path: string): string {
  return `当前 Workspace：${path}`;
}

export function formatFeishuWorkspaceRequired(): string {
  return '当前 Conversation 尚未设置 Workspace。请输入 /workspace /absolute/path 后再执行任务。';
}

export interface FeishuRawMessageEvent {
  sender?: {
    sender_id?: {
      open_id?: unknown;
      user_id?: unknown;
      union_id?: unknown;
    };
    sender_type?: unknown;
  };
  message?: {
    message_id?: unknown;
    chat_id?: unknown;
    chat_type?: unknown;
    message_type?: unknown;
    content?: unknown;
    root_id?: unknown;
    parent_id?: unknown;
    thread_id?: unknown;
    mentions?: Array<{
      id?: {
        open_id?: unknown;
        user_id?: unknown;
      };
      name?: unknown;
    }>;
  };
}

export function normalizeFeishuInboundEvent(
  event: FeishuRawMessageEvent,
  input: { transport: 'websocket' | 'webhook'; receivedAt?: string },
): GatewayInboundEvent | null {
  const messageId = stringValue(event.message?.message_id);
  const chatId = stringValue(event.message?.chat_id);
  if (!messageId || !chatId) {
    return null;
  }

  const messageType = normalizeMessageType(event.message?.message_type);
  // §5.5: a rich-text (post) message carries text and images in ONE message;
  // the normalizer extracts both so the Gateway command never splits them.
  const postContent = messageType === 'unknown' && isPostContent(event.message?.content)
    ? parseFeishuPost(event.message?.content)
    : null;
  return {
    id: `feishu:${messageId}`,
    platform: 'feishu',
    transport: input.transport,
    messageId,
    chatId,
    chatType: normalizeChatType(event.message?.chat_type),
    text: messageType === 'text'
      ? parseFeishuText(event.message?.content) ?? ''
      : postContent?.text ?? '',
    messageType,
    attachments: (postContent?.imageKeys ?? []).map((imageKey, index) => ({
      id: imageKey,
      type: 'image' as const,
      name: `image-${index + 1}.png`,
    })),
    mentions: (event.message?.mentions ?? [])
      .map(mention => ({
        id: stringValue(mention.id?.open_id) ?? stringValue(mention.id?.user_id) ?? '',
        ...(typeof mention.name === 'string' ? { name: mention.name } : {}),
      }))
      .filter(mention => mention.id.length > 0),
    raw: event,
    receivedAt: input.receivedAt ?? new Date().toISOString(),
    ...(stringValue(event.message?.thread_id)
      ?? stringValue(event.message?.root_id)
      ?? stringValue(event.message?.parent_id)
      ? {
          threadId: stringValue(event.message?.thread_id)
            ?? stringValue(event.message?.root_id)
            ?? stringValue(event.message?.parent_id)
            ?? undefined,
        }
      : {}),
    ...(stringValue(event.sender?.sender_id?.open_id)
      ?? stringValue(event.sender?.sender_id?.user_id)
      ?? stringValue(event.sender?.sender_id?.union_id)
      ? {
          userId: stringValue(event.sender?.sender_id?.open_id)
            ?? stringValue(event.sender?.sender_id?.user_id)
            ?? stringValue(event.sender?.sender_id?.union_id)
            ?? undefined,
        }
      : {}),
  };
}

export function parseFeishuText(content: unknown): string | null {
  if (typeof content !== 'string') {
    return null;
  }

  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text.trim() : null;
  } catch {
    return content.trim();
  }
}

/** Detects Feishu rich-text (post) message content. */
export function isPostContent(content: unknown): boolean {
  if (typeof content !== 'string') return false;
  try {
    const parsed = JSON.parse(content) as { content?: unknown };
    return Array.isArray(parsed?.content);
  } catch {
    return false;
  }
}

/** Extracts plain text and image keys from Feishu rich-text (post) content. */
export function parseFeishuPost(content: unknown): { text: string; imageKeys: string[] } | null {
  if (typeof content !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { content?: unknown }).content)) {
    return null;
  }
  const textParts: string[] = [];
  const imageKeys: string[] = [];
  const walk = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (Array.isArray(node)) {
        walk(node);
        continue;
      }
      if (!node || typeof node !== 'object') continue;
      const record = node as Record<string, unknown>;
      if (typeof record.text === 'string') {
        textParts.push(record.text);
      }
      if (record.tag === 'img' && typeof record.image_key === 'string' && record.image_key) {
        imageKeys.push(record.image_key);
      }
      if (Array.isArray(record.content)) {
        walk(record.content);
      }
      if (Array.isArray(record.elements)) {
        walk(record.elements);
      }
    }
  };
  walk((parsed as { content: unknown[] }).content);
  if (textParts.length === 0 && imageKeys.length === 0) return null;
  return { text: textParts.join('').trim(), imageKeys };
}

function normalizeChatType(value: unknown): GatewayInboundEvent['chatType'] {
  if (value === 'group' || value === 'chat') {
    return 'group';
  }
  if (value === 'p2p' || value === 'dm') {
    return 'dm';
  }
  return 'unknown';
}

function normalizeMessageType(value: unknown): GatewayInboundEvent['messageType'] {
  if (value === 'text' || value === 'file' || value === 'image' || value === 'audio') {
    return value;
  }
  return 'unknown';
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
