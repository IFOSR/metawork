/**
 * ClientGateway（ADR-0031 第 5、6、7、8 节）。
 *
 * 统一客户端网关核心：认证 -> 账户解析 -> 持久命令准入 -> 账户激活 ->
 * 会话解析 -> Conversation mailbox。持久准入先于 mailbox handoff，因此进程
 * 崩溃后可以根据 durable Gateway events 安全恢复或 fail closed。
 */

import { createHash } from 'node:crypto';
import { gatewayError, type GatewayError } from './client-errors.js';
import type { AccountResolver } from './account-resolver.js';
import type { Authenticator, AuthenticatorTransport } from './authenticator.js';
import type { CommandReceipt } from './command-admission.js';
import {
  isGatewayIdentifier,
  parseGatewayCommandEnvelope,
  type GatewayCommandEnvelope,
  type GatewayCommand,
} from './client-protocol.js';
import type { ConversationResolver } from './conversation-resolver.js';
import {
  MemoryCommandAdmissionStore,
  type CommandAdmissionStore,
  type StoredCommandAdmission,
} from './command-admission-store.js';

export interface ConversationSubmissionResult {
  readonly status: 'accepted' | 'duplicate' | 'rejected';
  readonly reason?: string;
  readonly completion?: Promise<{
    readonly status: 'completed' | 'failed';
    readonly reason?: string;
  }>;
}

export interface ClientGatewayDeps {
  authenticator: Authenticator;
  accountResolver: AccountResolver;
  conversationResolver: ConversationResolver;
  activateAccount(accountId: string): Promise<void>;
  submitToConversation(
    conversationId: string,
    requestId: string,
    idempotencyKey: string,
    command: GatewayCommand,
  ): Promise<ConversationSubmissionResult>;
  commandAdmissionStore?: CommandAdmissionStore;
  now?: () => string;
}

export type ClientGatewayResult = CommandReceipt | GatewayError;

export class ClientGateway {
  private readonly admissionStore: CommandAdmissionStore;
  private readonly inFlight = new Map<string, Promise<CommandReceipt>>();
  private readonly activeHandles = new Set<Promise<ClientGatewayResult>>();
  private readonly recovery: Promise<void>;
  private admissionClosed = false;

  constructor(private readonly deps: ClientGatewayDeps) {
    this.admissionStore = deps.commandAdmissionStore ?? new MemoryCommandAdmissionStore();
    this.recovery = Promise.resolve().then(() => this.recoverPersisted());
  }

  recover(): Promise<void> {
    return this.recovery;
  }

  handle(
    envelope: GatewayCommandEnvelope,
    transport: AuthenticatorTransport,
    credential?: unknown,
  ): Promise<ClientGatewayResult> {
    if (this.admissionClosed) {
      return Promise.resolve(gatewayError(
        'unavailable',
        'gateway_closing',
        'Gateway command admission is closed',
        requestIdFromUntrustedEnvelope(envelope),
      ));
    }
    const operation = this.handleOpen(envelope, transport, credential);
    this.activeHandles.add(operation);
    void operation.finally(() => this.activeHandles.delete(operation)).catch(() => undefined);
    return operation;
  }

  closeAdmission(): void {
    this.admissionClosed = true;
  }

  async drain(): Promise<void> {
    await this.recovery;
    while (this.activeHandles.size > 0) {
      await Promise.allSettled([...this.activeHandles]);
    }
  }

  private async handleOpen(
    envelope: GatewayCommandEnvelope,
    transport: AuthenticatorTransport,
    credential?: unknown,
  ): Promise<ClientGatewayResult> {
    const validatedEnvelope = parseGatewayCommandEnvelope(envelope);
    if (!validatedEnvelope) {
      return gatewayError(
        'invalid_command',
        'invalid_gateway_command',
        'Gateway command envelope violates the protocol contract',
        requestIdFromUntrustedEnvelope(envelope),
      );
    }
    envelope = validatedEnvelope;

    const principal = await this.deps.authenticator.authenticate({ transport, credential });
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

    await this.recovery;
    const fingerprint = commandFingerprint(envelope);
    const reservation = await this.admissionStore.reserve({
      accountId: account.accountId,
      idempotencyKey: envelope.idempotencyKey,
      fingerprint,
      requestId: envelope.requestId,
      conversation: envelope.conversation,
      command: envelope.command,
      conversationId: null,
      now: this.now(),
    });
    if (reservation.fingerprint !== fingerprint) {
      return gatewayError(
        'conflict',
        'idempotency_conflict',
        'idempotency key was already used for a different command',
        envelope.requestId,
      );
    }
    if (reservation.state === 'terminal') {
      return replayReceipt(requireTerminalReceipt(reservation), envelope.requestId);
    }
    if (reservation.state === 'uncertain') {
      return uncertainReceipt(reservation, envelope.requestId);
    }

    const key = admissionKey(account.accountId, envelope.idempotencyKey);
    const active = this.inFlight.get(key);
    if (active) return replayReceipt(await active, envelope.requestId);

    const execution = this.executeAdmission(reservation);
    this.inFlight.set(key, execution);
    try {
      const receipt = await execution;
      return reservation.requestId === envelope.requestId
        ? receipt
        : replayReceipt(receipt, envelope.requestId);
    } finally {
      if (this.inFlight.get(key) === execution) this.inFlight.delete(key);
    }
  }

  private async recoverPersisted(): Promise<void> {
    const recoverable = await this.admissionStore.listRecoverable();
    for (const admission of recoverable) {
      const key = admissionKey(admission.accountId, admission.idempotencyKey);
      const active = this.inFlight.get(key);
      if (active) {
        await active;
        continue;
      }
      const execution = this.executeAdmission(admission, true);
      this.inFlight.set(key, execution);
      try {
        await execution;
      } finally {
        if (this.inFlight.get(key) === execution) this.inFlight.delete(key);
      }
    }
  }

  private async executeAdmission(
    initial: StoredCommandAdmission,
    recovering = false,
  ): Promise<CommandReceipt> {
    let admission = initial;
    try {
      await this.deps.activateAccount(admission.accountId);
      if (!admission.conversationId) {
        const conversation = await this.deps.conversationResolver.resolve(
          admission.accountId,
          admission.conversation,
        );
        if (conversation.status === 'denied') {
          return this.persistTerminal(admission, {
            requestId: admission.requestId,
            idempotencyKey: admission.idempotencyKey,
            status: 'rejected',
            conversationId: null,
            reason: `conversation_denied:${conversation.reason}`,
          });
        }
        admission = await this.admissionStore.assignConversation(
          admission.accountId,
          admission.idempotencyKey,
          admission.fingerprint,
          conversation.conversationId,
          this.now(),
        );
        if (admission.state === 'terminal') {
          return requireTerminalReceipt(admission);
        }
      }

      admission = await this.admissionStore.markSubmitted(
        admission.accountId,
        admission.idempotencyKey,
        admission.fingerprint,
        this.now(),
      );
      if (admission.state === 'terminal') {
        return requireTerminalReceipt(admission);
      }
      const submission = await this.deps.submitToConversation(
        admission.conversationId!,
        admission.requestId,
        admission.idempotencyKey,
        admission.command,
      );
      const receipt = commandReceipt(admission, submission);
      if (submission.status === 'rejected') {
        return this.persistTerminal(admission, receipt);
      }
      if (!submission.completion) {
        return this.persistTerminal(admission, receipt);
      }

      void submission.completion.then(
        result => {
          const terminal = result.status === 'completed'
            ? receipt
            : {
                ...receipt,
                status: 'rejected' as const,
                reason: result.reason ?? 'command_execution_failed',
              };
          return this.persistTerminal(admission, terminal);
        },
        error => this.persistUncertain(
          admission,
          `command completion failed: ${(error as Error).message}`,
        ),
      ).catch(() => undefined);
      return receipt;
    } catch (error) {
      const reason = recovering
        ? `command recovery failed: ${(error as Error).message}`
        : `command submission is uncertain: ${(error as Error).message}`;
      const stored = await this.persistUncertain(admission, reason);
      return stored.state === 'terminal'
        ? requireTerminalReceipt(stored)
        : uncertainReceipt(stored, admission.requestId);
    }
  }

  private persistTerminal(
    admission: StoredCommandAdmission,
    receipt: CommandReceipt,
  ): Promise<CommandReceipt> {
    return this.admissionStore.markTerminal(
      admission.accountId,
      admission.idempotencyKey,
      admission.fingerprint,
      receipt,
      this.now(),
    ).then(stored => requireTerminalReceipt(stored));
  }

  private persistUncertain(
    admission: StoredCommandAdmission,
    reason: string,
  ): Promise<StoredCommandAdmission> {
    return this.admissionStore.markUncertain(
      admission.accountId,
      admission.idempotencyKey,
      admission.fingerprint,
      reason,
      this.now(),
    );
  }

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }
}

function requestIdFromUntrustedEnvelope(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const requestId = (input as Record<string, unknown>).requestId;
  return isGatewayIdentifier(requestId) ? requestId : null;
}

function commandReceipt(
  admission: StoredCommandAdmission,
  submission: ConversationSubmissionResult,
): CommandReceipt {
  return {
    requestId: admission.requestId,
    idempotencyKey: admission.idempotencyKey,
    status: submission.status === 'duplicate' ? 'accepted' : submission.status,
    conversationId: admission.conversationId,
    ...(submission.reason ? { reason: submission.reason } : {}),
  };
}

function replayReceipt(receipt: CommandReceipt, requestId: string): CommandReceipt {
  return receipt.status === 'accepted'
    ? { ...receipt, requestId, status: 'duplicate' }
    : { ...receipt, requestId };
}

function uncertainReceipt(
  admission: Pick<
    StoredCommandAdmission,
    'idempotencyKey' | 'conversationId' | 'uncertaintyReason'
  >,
  requestId: string,
): CommandReceipt {
  return {
    requestId,
    idempotencyKey: admission.idempotencyKey,
    status: 'rejected',
    conversationId: admission.conversationId,
    reason: admission.uncertaintyReason ?? 'command_execution_uncertain',
  };
}

function requireTerminalReceipt(admission: StoredCommandAdmission): CommandReceipt {
  if (!admission.receipt) throw new Error('terminal command admission has no receipt');
  return admission.receipt;
}

function admissionKey(accountId: string, idempotencyKey: string): string {
  return `${accountId}\0${idempotencyKey}`;
}

function commandFingerprint(envelope: GatewayCommandEnvelope): string {
  return createHash('sha256')
    .update(stableJson({
      conversation: envelope.conversation,
      command: envelope.command,
    }))
    .digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => (
      `${JSON.stringify(key)}:${stableJson(record[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
