/**
 * AccountRuntime 端口契约（ADR-0031 第 2 节）。
 *
 * Conversation 通过窄端口访问账户运行时服务，绝不能构造或恢复 Kernel /
 * Execution 服务。
 */

import type { AccountKernelCoordinator } from './account-kernel-coordinator.js';

/** AccountRuntime 暴露给 Application Shell 的窄句柄。 */
export interface AccountRuntimeHandle {
  readonly accountId: string;
  readonly kernelCoordinator: AccountKernelCoordinator;
  initialize(): Promise<void>;
}

/** Conversation 通过该端口访问账户事实；方法在后续任务逐步补齐。 */
export interface ConversationRuntimePort {
  readonly accountId: string;
}
