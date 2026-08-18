/**
 * ConversationSession（ADR-0031 第 2、7 节）。
 *
 * 一个 Conversation 的实时应用外壳对象。它拥有稳定的 Planner 会话身份、
 * 串行输入邮箱、输出/轨迹投影与客户端附着；通过 ConversationRuntimePort
 * 访问账户事实，不拥有 Kernel、调度、恢复或 Executor 服务。
 */

import {
  ConversationInputMailbox,
  type MailboxCommand,
  type MailboxReceipt,
} from './conversation-input-mailbox.js';
import type { ConversationRuntimePort } from './conversation-runtime-port.js';

export interface ConversationSessionDeps {
  readonly conversationId: string;
  readonly plannerSessionId: string;
  readonly runtimePort: ConversationRuntimePort;
  readonly mailbox: ConversationInputMailbox;
  readonly dispose?: () => Promise<void>;
}

export class ConversationSession {
  private output: string[] = [];
  private attachedClients = 0;

  constructor(private readonly deps: ConversationSessionDeps) {}

  get conversationId(): string {
    return this.deps.conversationId;
  }

  get plannerSessionId(): string {
    return this.deps.plannerSessionId;
  }

  get accountId(): string {
    return this.deps.runtimePort.accountId;
  }

  attachClient(): void {
    this.attachedClients += 1;
  }

  detachClient(): void {
    this.attachedClients = Math.max(0, this.attachedClients - 1);
  }

  get attachedClientCount(): number {
    return this.attachedClients;
  }

  appendOutput(...lines: string[]): void {
    this.output.push(...lines);
  }

  getOutput(): readonly string[] {
    return [...this.output];
  }

  submit(command: MailboxCommand): MailboxReceipt {
    return this.deps.mailbox.submit(command);
  }

  cancelTurn(requestId: string): boolean {
    return this.deps.mailbox.cancel(requestId);
  }

  isIdle(): boolean {
    return !this.deps.mailbox.isActive;
  }

  async dispose(): Promise<void> {
    await (this.deps.dispose ?? (async () => undefined))();
  }
}
