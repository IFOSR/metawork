/**
 * ClientGateway（ADR-0031 第 5、6、7、8 节）。
 *
 * 统一客户端网关核心：认证 -> 账户解析 -> 账户激活 -> 会话解析 -> 命令准入。
 * 只依赖窄端口（Authenticator / AccountResolver / ConversationResolver /
 * RuntimeRegistry 门面 / 邮箱提交端口），绝不向适配器暴露具体 Runtime 或
 * Session 对象。
 */

import { gatewayError, type GatewayError } from './client-errors.js';
import type { AccountResolver } from './account-resolver.js';
import type { Authenticator, AuthenticatorTransport } from './authenticator.js';
import type { CommandReceipt } from './command-admission.js';
import { IdempotentCommandAdmission } from './command-admission.js';
import type { GatewayCommandEnvelope } from './client-protocol.js';
import type { ConversationResolver } from './conversation-resolver.js';

export interface ClientGatewayDeps {
  authenticator: Authenticator;
  accountResolver: AccountResolver;
  conversationResolver: ConversationResolver;
  activateAccount(accountId: string): Promise<void>;
  submitToConversation(
    conversationId: string,
    requestId: string,
    idempotencyKey: string,
  ): Promise<{ status: 'accepted' | 'duplicate' | 'rejected'; reason?: string }>;
}

export type ClientGatewayResult = CommandReceipt | GatewayError;

export class ClientGateway {
  private readonly admission: IdempotentCommandAdmission;

  constructor(private readonly deps: ClientGatewayDeps) {
    this.admission = new IdempotentCommandAdmission({
      submit: async (conversationId, requestId, idempotencyKey) => {
        const result = await this.deps.submitToConversation(conversationId, requestId, idempotencyKey);
        return { requestId, idempotencyKey, status: result.status, reason: result.reason };
      },
    });
  }

  async handle(
    envelope: GatewayCommandEnvelope,
    transport: AuthenticatorTransport,
  ): Promise<ClientGatewayResult> {
    const principal = await this.deps.authenticator.authenticate({ transport });
    if (!principal) {
      return gatewayError(
        'authentication',
        'unauthenticated',
        'transport authentication failed',
        envelope.requestId,
      );
    }

    const account = await this.deps.accountResolver.resolve(principal);
    if (account.status !== 'authorized') {
      return gatewayError('authorization', 'unauthorized', account.reason, envelope.requestId);
    }

    await this.deps.activateAccount(account.accountId);

    const conversation = await this.deps.conversationResolver.resolve(
      account.accountId,
      envelope.conversation,
    );
    if (conversation.status === 'denied') {
      return gatewayError(
        'authorization',
        'conversation_denied',
        conversation.reason,
        envelope.requestId,
      );
    }

    return this.admission.admit(
      envelope.requestId,
      envelope.idempotencyKey,
      conversation.conversationId,
    );
  }
}
