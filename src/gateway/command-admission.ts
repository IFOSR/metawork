/**
 * 命令准入（ADR-0031 第 8 节）。
 *
 * 幂等准入：重复 idempotencyKey 返回原 receipt，不产生第二次 turn。准入把
 * 命令交给 Conversation 邮箱，邮箱的串行语义保证单次活跃 turn。
 */

import type { MailboxReceipt } from '../session/conversation-input-mailbox.js';
import type { GatewayCommand } from './client-protocol.js';

export interface CommandReceipt {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly status: 'accepted' | 'duplicate' | 'rejected';
  readonly conversationId: string | null;
  readonly workspaceId?: string | null;
  readonly reason?: string;
}

export interface CommandAdmissionDeps {
  submit(
    conversationId: string,
    requestId: string,
    idempotencyKey: string,
    command: GatewayCommand,
  ): Promise<MailboxReceipt>;
}

export class IdempotentCommandAdmission {
  private readonly seen = new Map<string, {
    fingerprint: string;
    receipt: Promise<CommandReceipt>;
  }>();

  constructor(private readonly deps: CommandAdmissionDeps) {}

  async admit(
    requestId: string,
    idempotencyKey: string,
    conversationId: string,
    command: GatewayCommand,
  ): Promise<CommandReceipt> {
    const fingerprint = JSON.stringify({ conversationId, command });
    const existing = this.seen.get(idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return {
          requestId,
          idempotencyKey,
          status: 'rejected',
          conversationId,
          reason: 'idempotency_conflict',
        };
      }
      const receipt = await existing.receipt;
      return receipt.status === 'accepted'
        ? { ...receipt, requestId, status: 'duplicate' }
        : { ...receipt, requestId };
    }

    const receipt = this.deps.submit(conversationId, requestId, idempotencyKey, command)
      .then(mailboxReceipt => ({
        requestId,
        idempotencyKey,
        status: mailboxReceipt.status === 'rejected' ? 'rejected' as const : 'accepted' as const,
        conversationId,
        reason: mailboxReceipt.reason,
      }));
    this.seen.set(idempotencyKey, { fingerprint, receipt });
    try {
      return await receipt;
    } catch (error) {
      this.seen.delete(idempotencyKey);
      throw error;
    }
  }
}
