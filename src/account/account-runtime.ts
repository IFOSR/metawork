/**
 * AccountRuntime（ADR-0031 第 2 节）。
 *
 * 一个账户的单一运行时协调者。它拥有账户级 durable recovery 与 Kernel 单写
 * 协调器。startup recovery 在账户激活时只运行一次，而非每次连接或每个
 * Conversation 各跑一次。
 *
 * 生命周期：attachClient/detachClient 跟踪已连接客户端，setActiveWork 跟踪
 * 活动工作；closeWhenIdle 仅在无客户端且无活动工作时 dispose 一次。
 */

import type { AccountKernelCoordinator } from './account-kernel-coordinator.js';
import type { AccountKernelServices } from './account-kernel-services.js';
import type { AccountRuntimeHandle, ConversationRuntimePort } from './account-runtime-ports.js';

export interface AccountRuntimeDeps {
  readonly accountId: string;
  readonly kernelCoordinator: AccountKernelCoordinator;
  readonly kernelServices: AccountKernelServices;
  readonly recoverDurableStartup: () => Promise<void>;
  readonly dispose?: () => Promise<void>;
}

export class AccountRuntime implements AccountRuntimeHandle {
  private initialized = false;
  private initialization: Promise<void> | null = null;
  private disposed = false;
  private attachedClients = 0;
  private activeWork = false;

  constructor(private readonly deps: AccountRuntimeDeps) {}

  get accountId(): string {
    return this.deps.accountId;
  }

  get kernelCoordinator(): AccountKernelCoordinator {
    return this.deps.kernelCoordinator;
  }

  get kernelServices(): AccountKernelServices {
    return this.deps.kernelServices;
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

  attachClient(): void {
    this.attachedClients += 1;
  }

  detachClient(): void {
    this.attachedClients = Math.max(0, this.attachedClients - 1);
  }

  setActiveWork(active: boolean): void {
    this.activeWork = active;
  }

  isBusy(): boolean {
    return this.attachedClients > 0 || this.activeWork;
  }

  async closeWhenIdle(): Promise<'closed' | 'busy'> {
    if (this.isBusy()) return 'busy';
    if (this.disposed) return 'closed';
    this.disposed = true;
    await (this.deps.dispose ?? (async () => undefined))();
    return 'closed';
  }

  getConversationPort(): ConversationRuntimePort {
    return { accountId: this.accountId };
  }
}
