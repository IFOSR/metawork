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
  private readonly seen = new Map<string, CommandReceipt>();

  constructor(private readonly deps: CommandAdmissionDeps) {}

  async admit(
    requestId: string,
    idempotencyKey: string,
    conversationId: string,
    command: GatewayCommand,
  ): Promise<CommandReceipt> {
    const existing = this.seen.get(idempotencyKey);
    if (existing) {
      return { ...existing, status: 'duplicate', reason: undefined };
    }

    const mailboxReceipt = await this.deps.submit(conversationId, requestId, idempotencyKey, command);
    const receipt: CommandReceipt = {
      requestId,
      idempotencyKey,
      status: mailboxReceipt.status === 'rejected' ? 'rejected' : 'accepted',
      conversationId,
      reason: mailboxReceipt.reason,
    };
    this.seen.set(idempotencyKey, receipt);
    return receipt;
  }
}
