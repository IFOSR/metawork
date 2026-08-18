/**
 * AccountRuntime 工厂（ADR-0031 第 2 节）。
 *
 * 唯一允许绑定具体账户存储 / Planner / Kernel / Runtime 适配器的组合点之一。
 * 每次账户激活构建一个 AccountRuntime 及其单例 Kernel 协调器，按账户构建。
 */

import type { AccountKernelCoordinator } from './account-kernel-coordinator.js';
import { AccountRuntime } from './account-runtime.js';

export interface AccountRuntimeFactoryDeps {
  buildKernelCoordinator(accountId: string): AccountKernelCoordinator;
  recoverDurableStartup(accountId: string): Promise<void>;
  dispose?(accountId: string): Promise<void>;
}

export class AccountRuntimeFactory {
  constructor(private readonly deps: AccountRuntimeFactoryDeps) {}

  create(accountId: string): AccountRuntime {
    return new AccountRuntime({
      accountId,
      kernelCoordinator: this.deps.buildKernelCoordinator(accountId),
      recoverDurableStartup: () => this.deps.recoverDurableStartup(accountId),
      dispose: this.deps.dispose
        ? () => this.deps.dispose!(accountId)
        : undefined,
    });
  }
}
