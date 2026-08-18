/**
 * AccountRuntime（ADR-0031 第 2 节）。
 *
 * 一个账户的单一运行时协调者。它拥有账户级 durable recovery 与 Kernel 单写
 * 协调器。startup recovery 在账户激活时只运行一次，而非每次连接或每个
 * Conversation 各跑一次。
 */

import type { AccountKernelCoordinator } from './account-kernel-coordinator.js';
import type { AccountRuntimeHandle, ConversationRuntimePort } from './account-runtime-ports.js';

export interface AccountRuntimeDeps {
  readonly accountId: string;
  readonly kernelCoordinator: AccountKernelCoordinator;
  readonly recoverDurableStartup: () => Promise<void>;
}

export class AccountRuntime implements AccountRuntimeHandle {
  private initialized = false;
  private initialization: Promise<void> | null = null;

  constructor(private readonly deps: AccountRuntimeDeps) {}

  get accountId(): string {
    return this.deps.accountId;
  }

  get kernelCoordinator(): AccountKernelCoordinator {
    return this.deps.kernelCoordinator;
  }

  /** 单飞行、幂等的账户激活恢复。 */
  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initialization) return this.initialization;
    this.initialization = Promise.resolve()
      .then(() => this.deps.recoverDurableStartup())
      .then(() => {
        this.initialized = true;
      });
    return this.initialization;
  }

  getConversationPort(): ConversationRuntimePort {
    return { accountId: this.accountId };
  }
}
