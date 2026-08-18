/**
 * 账户级 Kernel 单写者协调器（ADR-0031 第 3 节）。
 *
 * 一个账户只有一个协调器实例，它是唯一允许 claim/decide/apply 账户 durable
 * Kernel inbox 与决策应用的 Application 层所有者。这消除了多个 per-conversation
 * `DurableKernelWorkflow` 竞争同一 `kernel_events` 表导致的跨会话抢占。
 *
 * 协调器保留内部 `DurableKernelWorkflow` 作为排序机制，但强制
 * `buildSnapshot` 始终针对被 claim 的确切事件构建，而非静态闭包。
 */

import type {
  KernelDecider,
  KernelRecoveryReport,
  KernelRuntime,
  KernelWorkflowClock,
  KernelWorkflowResult,
  KernelWorkflowStore,
} from '../kernel/kernel-workflow.js';
import { DurableKernelWorkflow } from '../kernel/kernel-workflow.js';
import type { KernelDecisionAction, KernelEvent, KernelSnapshot } from '../kernel/control-kernel.js';

export interface AccountKernelCoordinatorDeps {
  kernel: KernelDecider;
  buildSnapshot(event: KernelEvent): KernelSnapshot;
  store: KernelWorkflowStore;
  runtime: KernelRuntime;
  clock: KernelWorkflowClock;
  acceptedEventTypes?: KernelEvent['type'][];
  acceptedActions?: KernelDecisionAction['type'][];
  taskId?: string;
}

export interface AccountKernelCoordinator {
  submit(event: KernelEvent): Promise<KernelWorkflowResult>;
  recover(): Promise<KernelRecoveryReport>;
}

export class AccountKernelCoordinator implements AccountKernelCoordinator {
  private readonly workflow: DurableKernelWorkflow;

  constructor(deps: AccountKernelCoordinatorDeps) {
    this.workflow = new DurableKernelWorkflow({
      kernel: deps.kernel,
      buildSnapshot: event => deps.buildSnapshot(event),
      store: deps.store,
      runtime: deps.runtime,
      clock: deps.clock,
      acceptedEventTypes: deps.acceptedEventTypes,
      acceptedActions: deps.acceptedActions,
      taskId: deps.taskId,
    });
  }

  submit(event: KernelEvent): Promise<KernelWorkflowResult> {
    return this.workflow.submit(event);
  }

  recover(): Promise<KernelRecoveryReport> {
    return this.workflow.recover();
  }
}
