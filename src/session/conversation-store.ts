/**
 * 持久化 Conversation 存储契约（ADR-0031 第 2、7 节）。
 *
 * Conversation 是账户内一个持久的用户交互线程，拥有稳定的 Planner 会话身份。
 * 记录是版本化、账户作用域的，只保留有界、脱敏的终态 turn 投影。权威的
 * Planner 历史仍在 Planner 会话文件里，权威的 Task/Kernel 事实仍在 SQLite。
 */

import type { WorkspaceId } from '../workspace/workspace-types.js';

export const CONVERSATION_FORMAT_VERSION = 3;

/** 每个 Conversation 最多保留的终态 turn 投影数量。 */
export const MAX_CONVERSATION_TURNS = 50;

export interface ConversationMetadata {
  readonly id: string;
  readonly plannerSessionId: string;
  readonly accountId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archived: boolean;
  readonly workspaceBinding: ConversationWorkspaceBinding | null;
}

export interface ConversationWorkspaceBinding {
  readonly workspaceId: WorkspaceId;
  readonly boundAt: string;
  readonly boundByPrincipal: string;
}

export interface ConversationTurn {
  readonly id: string;
  readonly conversationId: string;
  readonly userInput: string;
  readonly finalAnswer: string | null;
  readonly status: 'completed' | 'failed' | 'blocked';
}

export interface ConversationRecord {
  readonly version: typeof CONVERSATION_FORMAT_VERSION;
  readonly conversation: ConversationMetadata;
  readonly turns: ConversationTurn[];
}

export interface ConversationCatalogFile {
  readonly version: typeof CONVERSATION_FORMAT_VERSION;
  readonly conversations: ConversationMetadata[];
}

export interface ConversationStore {
  initialize(): Promise<void>;
  readCatalog(): Promise<ConversationCatalogFile>;
  writeCatalog(catalog: ConversationCatalogFile): Promise<void>;
  readConversation(conversationId: string): Promise<ConversationRecord | null>;
  writeConversation(record: ConversationRecord): Promise<void>;
}
