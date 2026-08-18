/**
 * AccountRuntime 工厂（ADR-0031 第 2 节）。
 *
 * 唯一允许绑定具体账户存储 / Planner / Kernel / Runtime 适配器的组合点之一。
 * 每次账户激活构建一个 AccountRuntime 及其单例 Kernel 协调器，按账户构建。
 *
 * 默认路径（测试 / 未注入账户数据库）下，kernelServices 与 repositories
 * 共享同一个内存数据库。
 */

import type { AccountKernelCoordinator } from './account-kernel-coordinator.js';
import { AccountRuntime } from './account-runtime.js';
import Database from 'better-sqlite3';
import type { AccountKernelServices } from './account-kernel-services.js';
import { buildAccountKernelServices } from './account-kernel-services.js';
import type { AccountRepositories } from './account-repositories.js';
import { buildAccountRepositories } from './account-repositories.js';

export interface AccountRuntimeFactoryDeps {
  buildKernelCoordinator(accountId: string): AccountKernelCoordinator;
  buildKernelServices?(accountId: string): AccountKernelServices;
  buildRepositories?(accountId: string): AccountRepositories;
  recoverDurableStartup(accountId: string): Promise<void>;
  dispose?(accountId: string): Promise<void>;
}

export class AccountRuntimeFactory {
  private readonly defaultDb: Database.Database;

  constructor(private readonly deps: AccountRuntimeFactoryDeps) {
    this.defaultDb = new Database(':memory:');
  }

  create(accountId: string): AccountRuntime {
    return new AccountRuntime({
      accountId,
      kernelCoordinator: this.deps.buildKernelCoordinator(accountId),
      kernelServices: this.deps.buildKernelServices
        ? this.deps.buildKernelServices(accountId)
        : buildAccountKernelServices(this.defaultDb),
      repositories: this.deps.buildRepositories
        ? this.deps.buildRepositories(accountId)
        : buildAccountRepositories(this.defaultDb),
      recoverDurableStartup: () => this.deps.recoverDurableStartup(accountId),
      dispose: this.deps.dispose
        ? () => this.deps.dispose!(accountId)
        : undefined,
    });
  }
}
