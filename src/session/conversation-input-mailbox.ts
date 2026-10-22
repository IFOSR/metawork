/**
 * Conversation 输入邮箱（ADR-0031 第 7 节）。
 *
 * 每个 Conversation 拥有一个串行输入邮箱：FIFO、一次一个活跃 turn、幂等
 * （重复 idempotencyKey 返回首张 receipt）、取消命中单个排队/活跃 turn、
 * 失败释放下一个 turn、队列有界（满则返回结构化 busy 错误）。
 *
 * 邮箱只拥有 turn 准入；账户 Kernel 策略仍归 AccountKernelCoordinator。
 */

import { createDefaultCommandCatalog } from '../commands/command-tree.js';
import type { GatewayCommand } from '../gateway/client-protocol.js';
import type { GatewayTurnOrigin } from '../gateway/gateway-delivery-context.js';

export interface MailboxCommand {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly principalId?: string;
  readonly command?: GatewayCommand;
  /** 内部请求/通知归因（ADR-0043），不决定观察权限；绝不进入公开事件载荷。 */
  readonly origin?: GatewayTurnOrigin;
}

export interface MailboxReceipt {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly status: 'accepted' | 'duplicate' | 'rejected';
  readonly reason?: string;
}

export interface ConversationInputMailboxDeps {
  execute(command: MailboxCommand): Promise<void>;
  maxQueueSize?: number;
}

const DEFAULT_MAX_QUEUE_SIZE = 16;
const controlCommandCatalog = createDefaultCommandCatalog();

/**
 * Explicit system commands are never semantic turns, so they execute without
 * waiting behind a Planner turn. Natural-language input remains FIFO. Gateway
 * cancellation and permission decisions use the same immediate control lane.
 */
export function isControlCommand(command: MailboxCommand): boolean {
  if (command.command?.kind === 'cancel_turn' || command.command?.kind === 'cancel_task'
    || command.command?.kind === 'permission_resolution' || command.command?.kind === 'permission_resolution_v2') return true;
  return isControlSlashCommand(command);
}

export function isControlSlashCommand(command: MailboxCommand): boolean {
  return command.command?.kind === 'slash_command'
    && controlCommandCatalog.owns(command.command.text);
}

export class ConversationInputMailbox {
  private readonly queue: MailboxCommand[] = [];
  private activeCommand: MailboxCommand | null = null;
  private readonly receipts = new Map<string, MailboxReceipt>();
  private readonly idleWaiters = new Set<() => void>();
  private draining = false;
  private closed = false;
  private readonly maxQueueSize: number;
  private execute: ConversationInputMailboxDeps['execute'];

  constructor(private readonly deps: ConversationInputMailboxDeps) {
    this.maxQueueSize = deps.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    this.execute = deps.execute;
  }

  bindExecutor(execute: ConversationInputMailboxDeps['execute']): void {
    if (this.activeCommand || this.queue.length > 0) {
      throw new Error('cannot rebind an active conversation mailbox');
    }
    this.execute = execute;
  }

  submit(command: MailboxCommand): MailboxReceipt {
    const existing = this.receipts.get(command.idempotencyKey);
    if (existing) {
      return { ...existing, status: 'duplicate', reason: undefined };
    }

    if (this.closed) {
      return {
        requestId: command.requestId,
        idempotencyKey: command.idempotencyKey,
        status: 'rejected',
        reason: 'closed',
      };
    }

    if (isControlCommand(command)) {
      const receipt: MailboxReceipt = {
        requestId: command.requestId,
        idempotencyKey: command.idempotencyKey,
        status: 'accepted',
      };
      this.receipts.set(command.idempotencyKey, receipt);
      void this.execute(command).catch(() => undefined);
      return receipt;
    }

    const occupied = this.queue.length + (this.activeCommand ? 1 : 0);
    if (occupied >= this.maxQueueSize) {
      const receipt: MailboxReceipt = {
        requestId: command.requestId,
        idempotencyKey: command.idempotencyKey,
        status: 'rejected',
        reason: 'busy',
      };
      this.receipts.set(command.idempotencyKey, receipt);
      return receipt;
    }

    const receipt: MailboxReceipt = {
      requestId: command.requestId,
      idempotencyKey: command.idempotencyKey,
      status: 'accepted',
    };
    this.receipts.set(command.idempotencyKey, receipt);
    this.queue.push(command);
    void this.drain();
    return receipt;
  }

  cancel(requestId: string): boolean {
    const index = this.queue.findIndex(command => command.requestId === requestId);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    return true;
  }

  get isActive(): boolean {
    return this.activeCommand !== null;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get isIdle(): boolean {
    return !this.draining && this.activeCommand === null && this.queue.length === 0;
  }

  closeAdmission(): void {
    this.closed = true;
  }

  waitForIdle(): Promise<void> {
    if (this.isIdle) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.add(resolve));
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.activeCommand) {
        const command = this.queue.shift()!;
        this.activeCommand = command;
        try {
          await this.execute(command);
        } catch {
          // 失败释放下一个 turn，不终止 drain 循环。
        } finally {
          this.activeCommand = null;
        }
      }
    } finally {
      this.draining = false;
      if (this.isIdle) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    }
  }
}
