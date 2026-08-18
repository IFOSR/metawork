/**
 * Conversation 运行时端口（ADR-0031 第 2 节）。
 *
 * ConversationSession 通过该窄端口访问账户运行时事实与 Kernel 协调器，但
 * 绝不构造 Kernel / Execution / 恢复服务。
 */

import type { AccountKernelCoordinator } from '../account/account-kernel-coordinator.js';

export interface ConversationRuntimePort {
  readonly accountId: string;
  readonly kernelCoordinator: AccountKernelCoordinator;
}
