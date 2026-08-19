/**
 * ConversationRegistry（ADR-0031 第 2、11 节）。
 *
 * 管理每个 Conversation 至多一个实时 ConversationSession，单飞行打开、有序
 * 空闲关闭。它不解释用户文本，也不执行 Kernel 决策。
 */

import type { ConversationSession } from './conversation-session.js';

export class ConversationRegistry {
  private readonly sessions = new Map<string, ConversationSession>();
  private readonly opening = new Map<string, Promise<ConversationSession>>();
  private closing = false;
  private reviewInFlight: Promise<boolean> | null = null;

  async getOrOpen(
    conversationId: string,
    open: () => Promise<ConversationSession>,
  ): Promise<ConversationSession> {
    if (this.closing) throw new Error('Conversation registry is closing');
    const existing = this.sessions.get(conversationId);
    if (existing) return existing;
    const inFlight = this.opening.get(conversationId);
    if (inFlight) return inFlight;

    const activation = open().then(session => {
      this.sessions.set(conversationId, session);
      return session;
    });
    this.opening.set(conversationId, activation);
    try {
      return await activation;
    } finally {
      this.opening.delete(conversationId);
    }
  }

  getIfOpen(conversationId: string): ConversationSession | null {
    return this.sessions.get(conversationId) ?? null;
  }

  async closeIdle(conversationId: string): Promise<'closed' | 'busy' | 'missing'> {
    const session = this.sessions.get(conversationId);
    if (!session) return 'missing';
    if (session.attachedClientCount > 0 || !session.isIdle()) return 'busy';
    this.sessions.delete(conversationId);
    await session.dispose();
    return 'closed';
  }

  async closeAll(): Promise<void> {
    if (this.closing && this.sessions.size === 0 && this.opening.size === 0) return;
    this.closing = true;
    await Promise.allSettled([...this.opening.values()]);
    if (this.reviewInFlight) {
      await Promise.allSettled([this.reviewInFlight]);
    }
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map(session => session.dispose()));
  }

  reviewTaskPoolOnTimer(nowMs = Date.now()): Promise<boolean> {
    if (this.closing) return Promise.resolve(false);
    if (this.reviewInFlight) return this.reviewInFlight;
    const review = (async () => {
      let handled = false;
      for (const session of this.sessions.values()) {
        handled = await session.maybeReviewTaskPoolOnTimer(nowMs) || handled;
      }
      return handled;
    })();
    this.reviewInFlight = review;
    return review.finally(() => {
      if (this.reviewInFlight === review) this.reviewInFlight = null;
    });
  }
}
