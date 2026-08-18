/**
 * RuntimeRegistry（ADR-0031 第 11 节）。
 *
 * 按 accountId 管理账户运行时：单飞行激活、未授权拒绝、失败隔离、以及有序
 * 关闭。它不解释用户文本，也不执行 Kernel 决策。Gateway 与适配器不得直接
 * 构造 AccountRuntime，而必须通过该注册表激活。
 */

import type { AccountRuntimeHandle } from './account-runtime-ports.js';
import type { AccountRuntimeFactory } from './account-runtime-factory.js';

export interface ResolvedAccount {
  readonly accountId: string;
  readonly authorized: boolean;
}

export interface RuntimeRegistryDeps {
  readonly factory: AccountRuntimeFactory;
}

export class RuntimeRegistry {
  private readonly loaded = new Map<string, AccountRuntimeHandle>();
  private readonly activating = new Map<string, Promise<AccountRuntimeHandle>>();
  private closed = false;

  constructor(private readonly deps: RuntimeRegistryDeps) {}

  async getOrActivate(account: ResolvedAccount): Promise<AccountRuntimeHandle> {
    if (!account.authorized) {
      throw new Error(`account not authorized: ${account.accountId}`);
    }
    const loaded = this.loaded.get(account.accountId);
    if (loaded) return loaded;
    const activating = this.activating.get(account.accountId);
    if (activating) return activating;

    const activation = this.activate(account.accountId);
    this.activating.set(account.accountId, activation);
    try {
      const runtime = await activation;
      this.loaded.set(account.accountId, runtime);
      return runtime;
    } finally {
      this.activating.delete(account.accountId);
    }
  }

  getIfLoaded(accountId: string): AccountRuntimeHandle | null {
    return this.loaded.get(accountId) ?? null;
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const runtimes = [...this.loaded.values()];
    this.loaded.clear();
    for (const runtime of runtimes) {
      await runtime.closeWhenIdle();
    }
  }

  private async activate(accountId: string): Promise<AccountRuntimeHandle> {
    const runtime = this.deps.factory.create(accountId);
    await runtime.initialize();
    return runtime;
  }
}
