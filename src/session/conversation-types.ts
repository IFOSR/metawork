/**
 * Conversation 身份与选择契约（ADR-0031）。
 *
 * Conversation 是账户内一个持久的用户交互线程，拥有稳定的 Planner 会话
 * 身份。它不拥有 Task/Executor 状态；通过持久 ID 引用账户任务。
 *
 * 纯类型/校验模块：不 import repository / socket / http / planner / kernel /
 * executor。
 */

export type ConversationId = string;

const CONVERSATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const CONVERSATION_ID_MAX_LENGTH = 128;

export function isValidConversationId(value: string): boolean {
  return value.length > 0
    && value.length <= CONVERSATION_ID_MAX_LENGTH
    && CONVERSATION_ID_PATTERN.test(value);
}

/** 把某个平台聊天/线程映射到账户内稳定 Conversation 的绑定键。 */
export interface ConversationBinding {
  readonly platform: string;
  readonly channelId: string;
  readonly threadId?: string;
}

/**
 * 会话选择：attach 恢复已知会话，bound 按平台绑定解析，new 创建新会话。
 * 仅凭同一个 accountId 不足以合并两个 Conversation。
 */
export type ConversationSelection =
  | { readonly mode: 'attach'; readonly conversationId: ConversationId }
  | { readonly mode: 'bound'; readonly binding: ConversationBinding }
  | { readonly mode: 'new' };
