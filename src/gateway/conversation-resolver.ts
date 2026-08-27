/**
 * Conversation 解析器（ADR-0031 第 7 节）。
 *
 * 在账户授权之后解析稳定的 conversationId：attach 恢复已知会话，bound 按
 * 平台绑定解析或新建并绑定，new 创建新会话。跨账户 attach 被拒绝。
 */

import { ConversationBindingRepository } from '../session/conversation-binding-repository.js';
import type { ConversationSelection } from '../session/conversation-types.js';

export type ConversationResolution =
  | { readonly status: 'resolved'; readonly conversationId: string }
  | { readonly status: 'created'; readonly conversationId: string }
  | { readonly status: 'denied'; readonly reason: string };

export interface ConversationResolver {
  resolve(
    accountId: string,
    selection: ConversationSelection,
    principalId?: string,
  ): Promise<ConversationResolution>;
}

export interface BindingConversationResolverDeps {
  bindings: ConversationBindingRepository;
  createId: () => string;
  verifyOwnership?: (accountId: string, conversationId: string) => Promise<boolean>;
  createInWorkspace?: (
    accountId: string,
    workspaceId: string,
    principalId: string,
  ) => Promise<string>;
}

export class BindingConversationResolver implements ConversationResolver {
  constructor(private readonly deps: BindingConversationResolverDeps) {}

  async resolve(
    accountId: string,
    selection: ConversationSelection,
    principalId = 'unknown',
  ): Promise<ConversationResolution> {
    if (selection.mode === 'attach') {
      if (this.deps.verifyOwnership) {
        const owned = await this.deps.verifyOwnership(accountId, selection.conversationId);
        if (!owned) {
          return { status: 'denied', reason: 'conversation is not owned by the account' };
        }
      }
      return { status: 'resolved', conversationId: selection.conversationId };
    }

    if (selection.mode === 'bound') {
      const binding = selection.binding;
      const existing = await this.deps.bindings.resolve(
        accountId,
        binding.platform,
        binding.channelId,
        binding.threadId,
      );
      if (existing) return { status: 'resolved', conversationId: existing };

      const created = this.deps.createId();
      await this.deps.bindings.bind({
        accountId,
        platform: binding.platform,
        channelId: binding.channelId,
        ...(binding.threadId !== undefined ? { threadId: binding.threadId } : {}),
        conversationId: created,
      });
      return { status: 'created', conversationId: created };
    }

    if (!this.deps.createInWorkspace) {
      return { status: 'denied', reason: 'workspace directory is unavailable' };
    }
    return {
      status: 'created',
      conversationId: await this.deps.createInWorkspace(
        accountId,
        selection.workspaceId,
        principalId,
      ),
    };
  }
}
