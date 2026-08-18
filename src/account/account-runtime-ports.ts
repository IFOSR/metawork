/**
 * AccountRuntime 端口契约（ADR-0031 第 2 节）。
 *
 * Conversation 通过窄端口访问账户运行时服务，绝不能构造或恢复 Kernel /
 * Execution 服务。
 */

import type { AccountKernelCoordinator } from './account-kernel-coordinator.js';
import type { AccountKernelServices } from './account-kernel-services.js';
import type { AccountRepositories } from './account-repositories.js';
import type { AccountWorkspaceServices } from './account-workspace-services.js';
import type { AccountExecutionServices } from './account-execution-services.js';
import type { AccountTaskServices } from './account-task-services.js';
import type { AccountCoordinatorServices } from './account-coordinator-services.js';
import type { AccountRuntimeExecutionServices } from './account-runtime-execution-services.js';

/** AccountRuntime 暴露给 Application Shell 的窄句柄。 */
export interface AccountRuntimeHandle {
  readonly accountId: string;
  readonly kernelCoordinator: AccountKernelCoordinator;
  initialize(): Promise<void>;
  closeWhenIdle(): Promise<'closed' | 'busy'>;
}

/** Conversation 通过该端口访问账户 runtime-wide 服务。 */
export interface ConversationRuntimePort {
  readonly accountId: string;
  readonly kernelCoordinator: AccountKernelCoordinator;
  readonly kernelServices: AccountKernelServices;
  readonly repositories: AccountRepositories;
  readonly workspaceServices: AccountWorkspaceServices;
  readonly executionServices?: AccountExecutionServices;
  readonly taskServices?: AccountTaskServices;
  readonly coordinatorServices?: AccountCoordinatorServices;
  readonly runtimeExecutionServices?: AccountRuntimeExecutionServices;
}
