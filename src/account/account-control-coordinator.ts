/**
 * 账户级 Kernel 单写者协调器（ADR-0031 第 3 节）。
 *
 * 一个账户只有一个协调器实例，它是唯一允许 claim/decide/apply 账户 durable
 * Kernel inbox 与决策应用的 Application 层所有者。协调器内部持有一个**持久**
 * TaskControlWorkflow：`drainSerially` 的实例级锁因此升级为账户级锁，
 * 消除了多个 per-conversation `TaskControlWorkflow` 竞争同一 inbox
 * 导致的跨会话抢占；ADR-0055 D6 之后循环本身是内存串行的。
 *
 * 每个提交事件的 snapshot/runtime context 按事件 ID 保存，应用时再按 decision
 * 的 eventId 解析。后台 drain 不得使用“最后一次绑定”的 Conversation context，
 * 否则 A/B 两个 Conversation 交错时会把 A 的决策应用到 B。
 */

import type {
  ControlDecider,
  ControlRecoveryReport,
  ControlRuntime,
  ControlWorkflowClock,
  ControlWorkflowResult,
} from '../control/control-workflow.js';
import { TaskControlWorkflow } from '../execution/task-control-workflow.js';
import type { ControlDecisionAction, ControlEvent, ControlSnapshot } from '../control/control-contracts.js';

export interface AccountControlCoordinatorDeps {
  productionAuthorization?: () => { allowed: boolean; reason?: string };
  kernel: ControlDecider;
  clock: ControlWorkflowClock;
  acceptedEventTypes?: ControlEvent['type'][];
  acceptedActions?: ControlDecisionAction['type'][];
  taskId?: string;
}

export interface AccountControlCoordinatorSubmitContext {
  buildSnapshot(event: ControlEvent): ControlSnapshot;
  runtime: ControlRuntime;
}

export interface AccountControlCoordinator {
  submit(event: ControlEvent, context: AccountControlCoordinatorSubmitContext): Promise<ControlWorkflowResult>;
  recover(context: AccountControlCoordinatorSubmitContext): Promise<ControlRecoveryReport>;
}

export class AccountControlCoordinator implements AccountControlCoordinator {
  private readonly deps: AccountControlCoordinatorDeps;
  private workflow: TaskControlWorkflow | null = null;
  private readonly contexts = new Map<string, AccountControlCoordinatorSubmitContext>();
  private tail: Promise<void> = Promise.resolve();

  constructor(deps: AccountControlCoordinatorDeps) {
    this.deps = deps;
  }

  submit(
    event: ControlEvent,
    context: AccountControlCoordinatorSubmitContext,
  ): Promise<ControlWorkflowResult> {
    return this.enqueue(async () => {
      this.contexts.set(event.id, context);
      try {
        return await this.ensureWorkflow().submit(event);
      } finally {
        // The workflow also releases follow-up observation contexts through
        // onEventSettled; this covers a rejected event that never enters its
        // drain (for example an event-type allowlist failure).
        this.contexts.delete(event.id);
      }
    });
  }

  recover(context: AccountControlCoordinatorSubmitContext): Promise<ControlRecoveryReport> {
    return this.enqueue(async () => {
      this.recoveryContext = context;
      return this.ensureWorkflow().recover();
    });
  }

  private recoveryContext: AccountControlCoordinatorSubmitContext | null = null;

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private ensureWorkflow(): TaskControlWorkflow {
    if (!this.workflow) {
      this.workflow = new TaskControlWorkflow({
        productionAuthorization: this.deps.productionAuthorization,
        kernel: this.deps.kernel,
        buildSnapshot: event => {
          const context = this.contexts.get(event.id) ?? this.recoveryContext;
          if (!context) throw new Error(`kernel coordinator has no context for event ${event.id}`);
          return context.buildSnapshot(event);
        },
        runtime: {
          apply: async decision => {
            const context = this.contexts.get(decision.eventId) ?? this.recoveryContext;
            if (!context) throw new Error(`kernel coordinator has no context for decision ${decision.id}`);
            const observation = await context.runtime.apply(decision);
            // Follow-up Kernel events are emitted by Runtime after applying the
            // decision. They must inherit the immutable owner/application route
            // of the decision that caused them.
            if (observation) this.contexts.set(observation.id, context);
            return observation;
          },
        },
        clock: this.deps.clock,
        acceptedEventTypes: this.deps.acceptedEventTypes,
        acceptedActions: this.deps.acceptedActions,
        taskId: this.deps.taskId,
        onEventSettled: event => {
          this.contexts.delete(event.id);
        },
      });
    }
    return this.workflow;
  }
}
