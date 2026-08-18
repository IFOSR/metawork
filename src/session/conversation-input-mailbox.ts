/**
 * Conversation 输入邮箱（ADR-0031 第 7 节）。
 *
 * 每个 Conversation 拥有一个串行输入邮箱：FIFO、一次一个活跃 turn、幂等
 * （重复 idempotencyKey 返回首张 receipt）、取消命中单个排队/活跃 turn、
 * 失败释放下一个 turn、队列有界（满则返回结构化 busy 错误）。
 *
 * 邮箱只拥有 turn 准入；账户 Kernel 策略仍归 AccountKernelCoordinator。
 */

export interface MailboxCommand {
  readonly requestId: string;
  readonly idempotencyKey: string;
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

export class ConversationInputMailbox {
  private readonly queue: MailboxCommand[] = [];
  private activeCommand: MailboxCommand | null = null;
  private readonly receipts = new Map<string, MailboxReceipt>();
  private draining = false;
  private readonly maxQueueSize: number;

  constructor(private readonly deps: ConversationInputMailboxDeps) {
    this.maxQueueSize = deps.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
  }

  submit(command: MailboxCommand): MailboxReceipt {
    const existing = this.receipts.get(command.idempotencyKey);
    if (existing) {
      return { ...existing, status: 'duplicate', reason: undefined };
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

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.activeCommand) {
        const command = this.queue.shift()!;
        this.activeCommand = command;
        try {
          await this.deps.execute(command);
        } catch {
          // 失败释放下一个 turn，不终止 drain 循环。
        } finally {
          this.activeCommand = null;
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
