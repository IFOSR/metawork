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
  type GatewayScope,
} from './client-protocol.js';
import type { ConversationResolver } from './conversation-resolver.js';
import {
  MemoryCommandAdmissionStore,
  type CommandAdmissionStore,
  type StoredCommandAdmission,
} from './command-admission-store.js';
import type { GatewayTurnOrigin } from './gateway-delivery-context.js';

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
    principalId?: string,
    origin?: GatewayTurnOrigin,
  ): Promise<ConversationSubmissionResult>;
  handleWorkspaceCommand?(
    command: Extract<GatewayCommand, {
      kind: 'select_workspace'
        | 'list_workspace_conversations'
        | 'create_conversation'
        | 'archive_conversation';
    }>,
    context: {
      accountId: string;
      principalId: string;
      connectionId: string;
      requestId: string;
    },
  ): Promise<{
    status: 'accepted' | 'rejected';
    workspaceId?: string;
    directory?: CommandReceipt['directory'];
    conversationId?: string;
    reason?: string;
  }>;
  commandAdmissionStore?: CommandAdmissionStore;
  newWorkAdmission?: NewWorkAdmission;
  /**
   * 受限只读查询分支（统一 TUI 设计 §9.3）：complete_command / get_task_view。
   * 不进入语义 mailbox，不启动 Planner，不创建 Turn，不占业务 work reservation。
   */
  handleReadOnlyQuery?(
    command: GatewayReadOnlyQuery,
    context: GatewayReadOnlyQueryContext,
  ): Promise<GatewayReadOnlyQueryResult>;
  now?: () => string;
}

export type GatewayReadOnlyQuery = Extract<GatewayCommand, {
  kind:
    | 'complete_command'
    | 'get_task_view'
    | 'get_query_bill'
    | 'get_query_bill_for_turn'
    | 'get_task_usage_summary'
    | 'list_query_bills'
    | 'get_usage_summary';
}>;

export interface GatewayReadOnlyQueryContext {
  readonly accountId: string;
  readonly principalId: string;
  readonly connectionId: string;
  readonly requestId: string;
  readonly scope: GatewayScope;
}

export interface GatewayReadOnlyQueryResult {
  readonly status: 'accepted' | 'rejected';
  readonly conversationId?: string | null;
  readonly reason?: string;
}

/** 只读分支的临时回执缓存上限（FIFO 淘汰）；不复用持久业务 admission。 */
const MAX_READ_ONLY_RECEIPTS = 256;
/** 每连接的只读查询频率限制：窗口内最多 MAX_READ_ONLY_QUERIES_PER_WINDOW 次。 */
const READ_ONLY_RATE_WINDOW_MS = 1_000;
const MAX_READ_ONLY_QUERIES_PER_WINDOW = 10;

export type NewWorkAdmissionResult =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: 'required_agent_unavailable' | 'no_enabled_executor';
      readonly agentId?: 'pi-agent' | 'codex-cli';
    };

export interface NewWorkAdmission {
  check(command: Extract<GatewayCommand, {
    kind: 'user_message' | 'create_conversation';
  }>): NewWorkAdmissionResult;
}

export type ClientGatewayResult = CommandReceipt | GatewayError;

export class ClientGateway {
  private readonly admissionStore: CommandAdmissionStore;
  private readonly inFlight = new Map<string, Promise<CommandReceipt>>();
  private readonly activeHandles = new Set<Promise<ClientGatewayResult>>();
  private readonly readOnlyReceipts = new Map<string, CommandReceipt>();
  private readonly readOnlyInFlight = new Map<string, Promise<CommandReceipt>>();
  private readonly readOnlyFingerprints = new Map<string, string>();
  private readonly readOnlyRateWindows = new Map<string, number[]>();
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

    if (isReadOnlyQuery(envelope.command)) {
      return this.handleReadOnly(envelope, account.accountId, `${principal.kind}:${principal.id}`);
    }

    const admissionCheck = newWorkAdmissionFor(envelope.command, this.deps.newWorkAdmission);
    if (admissionCheck && !admissionCheck.allowed) {
      return {
        requestId: envelope.requestId,
        idempotencyKey: envelope.idempotencyKey,
        status: 'rejected',
        conversationId: null,
        reason: admissionCheck.reason,
        code: admissionCheck.reason,
        agentId: admissionCheck.agentId,
      };
    }

    await this.recovery;
    const fingerprint = commandFingerprint(envelope);
    const reservation = await this.admissionStore.reserve({
      accountId: account.accountId,
      idempotencyKey: envelope.idempotencyKey,
      fingerprint,
      requestId: envelope.requestId,
      connectionId: envelope.connectionId,
      principalId: `${principal.kind}:${principal.id}`,
      scope: envelope.scope,
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

    const execution = this.executeAdmission(reservation, false, transport);
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

  /**
   * 只读查询：临时、有限的回执缓存与连接内限频；不触碰持久 CommandAdmissionStore，
   * 因此补全草稿与查询正文不会写入业务 admission / audit 存储。
   */
  private async handleReadOnly(
    envelope: GatewayCommandEnvelope,
    accountId: string,
    principalId: string,
  ): Promise<ClientGatewayResult> {
    if (!this.deps.handleReadOnlyQuery) {
      return {
        requestId: envelope.requestId,
        idempotencyKey: envelope.idempotencyKey,
        status: 'rejected',
        conversationId: null,
        reason: 'readonly_query_unavailable',
      };
    }
    const key = admissionKey(accountId, envelope.idempotencyKey);
    const fingerprint = commandFingerprint(envelope);
    const rememberedFingerprint = this.readOnlyFingerprints.get(key);
    if (rememberedFingerprint !== undefined && rememberedFingerprint !== fingerprint) {
      return gatewayError(
        'conflict',
        'idempotency_conflict',
        'idempotency key was already used for a different command',
        envelope.requestId,
      );
    }
    const remembered = this.readOnlyReceipts.get(key);
    if (remembered) {
      return remembered.status === 'accepted'
        ? { ...remembered, requestId: envelope.requestId, status: 'duplicate' as const }
        : { ...remembered, requestId: envelope.requestId };
    }
    const active = this.readOnlyInFlight.get(key);
    if (active) return replayReceipt(await active, envelope.requestId);

    const execution = this.executeReadOnly(envelope, accountId, principalId, key, fingerprint);
    this.readOnlyInFlight.set(key, execution);
    try {
      return await execution;
    } finally {
      if (this.readOnlyInFlight.get(key) === execution) this.readOnlyInFlight.delete(key);
    }
  }

  private async executeReadOnly(
    envelope: GatewayCommandEnvelope,
    accountId: string,
    principalId: string,
    key: string,
    fingerprint: string,
  ): Promise<CommandReceipt> {
    if (!this.consumeReadOnlyRate(envelope.connectionId)) {
      return {
        requestId: envelope.requestId,
        idempotencyKey: envelope.idempotencyKey,
        status: 'rejected',
        conversationId: null,
        reason: 'rate_limited',
      };
    }
    const command = envelope.command;
    if (!isReadOnlyQuery(command)) {
      throw new Error('executeReadOnly received a non read-only command');
    }
    let result: GatewayReadOnlyQueryResult;
    try {
      result = await this.deps.handleReadOnlyQuery!(command, {
        accountId,
        principalId,
        connectionId: envelope.connectionId,
        requestId: envelope.requestId,
        scope: envelope.scope,
      });
    } catch (error) {
      result = { status: 'rejected', reason: (error as Error).message };
    }
    const receipt: CommandReceipt = {
      requestId: envelope.requestId,
      idempotencyKey: envelope.idempotencyKey,
      status: result.status,
      conversationId: result.conversationId ?? null,
      ...(result.reason ? { reason: result.reason } : {}),
    };
    this.rememberReadOnlyReceipt(key, fingerprint, receipt);
    return receipt;
  }

  private rememberReadOnlyReceipt(key: string, fingerprint: string, receipt: CommandReceipt): void {
    while (this.readOnlyReceipts.size >= MAX_READ_ONLY_RECEIPTS) {
      const oldest = this.readOnlyReceipts.keys().next().value;
      if (oldest === undefined) break;
      this.readOnlyReceipts.delete(oldest);
      this.readOnlyFingerprints.delete(oldest);
    }
    this.readOnlyReceipts.set(key, receipt);
    this.readOnlyFingerprints.set(key, fingerprint);
  }

  private consumeReadOnlyRate(connectionId: string): boolean {
    const now = Date.now();
    const window = (this.readOnlyRateWindows.get(connectionId) ?? [])
      .filter(timestamp => now - timestamp < READ_ONLY_RATE_WINDOW_MS);
    if (window.length >= MAX_READ_ONLY_QUERIES_PER_WINDOW) {
      this.readOnlyRateWindows.set(connectionId, window);
      return false;
    }
    window.push(now);
    this.readOnlyRateWindows.set(connectionId, window);
    return true;
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
    transport?: AuthenticatorTransport,
  ): Promise<CommandReceipt> {
    let admission = initial;
    try {
      await this.deps.activateAccount(admission.accountId);
      if (admission.scope.kind === 'workspace') {
        admission = await this.admissionStore.markSubmitted(
          admission.accountId,
          admission.idempotencyKey,
          admission.fingerprint,
          this.now(),
        );
        const handler = this.deps.handleWorkspaceCommand;
        const result = handler && isWorkspaceCommand(admission.command)
          ? await handler(admission.command, {
              accountId: admission.accountId,
              principalId: admission.principalId ?? 'unknown',
              connectionId: admission.connectionId,
              requestId: admission.requestId,
            })
          : { status: 'rejected' as const, reason: 'workspace_command_unavailable' };
        return this.persistTerminal(admission, {
          requestId: admission.requestId,
          idempotencyKey: admission.idempotencyKey,
          status: result.status,
          conversationId: result.conversationId ?? null,
          workspaceId: result.workspaceId ?? null,
          ...(result.directory ? { directory: result.directory } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
        });
      }
      if (!admission.conversationId) {
        const conversation = await this.deps.conversationResolver.resolve(
          admission.accountId,
          admission.scope.selection,
          admission.principalId,
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
        admission.principalId,
        transport
          ? { connectionId: admission.connectionId, surface: gatewaySurfaceForTransport(transport) }
          : undefined,
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

function isWorkspaceCommand(command: GatewayCommand): command is Extract<GatewayCommand, {
  kind: 'select_workspace'
    | 'list_workspace_conversations'
    | 'create_conversation'
    | 'archive_conversation';
}> {
  return [
    'select_workspace',
    'list_workspace_conversations',
    'create_conversation',
    'archive_conversation',
  ].includes(command.kind);
}

function newWorkAdmissionFor(
  command: GatewayCommand,
  admission: NewWorkAdmission | undefined,
): NewWorkAdmissionResult | null {
  if (!admission || (command.kind !== 'user_message' && command.kind !== 'create_conversation')) {
    return null;
  }
  return admission.check(command);
}

function isReadOnlyQuery(command: GatewayCommand): command is GatewayReadOnlyQuery {
  return command.kind === 'complete_command'
    || command.kind === 'get_task_view'
    || command.kind === 'get_query_bill'
    || command.kind === 'get_query_bill_for_turn'
    || command.kind === 'get_task_usage_summary'
    || command.kind === 'list_query_bills'
    || command.kind === 'get_usage_summary';
}

function requestIdFromUntrustedEnvelope(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const requestId = (input as Record<string, unknown>).requestId;
  return isGatewayIdentifier(requestId) ? requestId : null;
}

function gatewaySurfaceForTransport(transport: AuthenticatorTransport): GatewayTurnOrigin['surface'] {
  if (transport === 'feishu') return 'feishu';
  if (transport === 'web') return 'web';
  if (transport === 'app') return 'unknown';
  return 'local';
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
      scope: envelope.scope,
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
