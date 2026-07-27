# Kernel 决策权散落 Runtime 技术债

> 状态：已关闭并归档——决策权已完全收敛到 `ControlKernel`
> 创建日期：2026-07-16
> 关闭日期：2026-07-27
> 接管计划：[Planner、Kernel 与并发调度收敛路线图](../../plans/2026-07-16-planner-kernel-concurrency-convergence-roadmap.md) Phase 3～5
> 关闭时现行 ADR：[ADR-0022（统一 Kernel 控制面与 decision ledger）](../../adr/0022-unified-kernel-control-plane-and-decision-ledger.md)、[ADR-0023（durable workflow、恢复与派生可用性）](../../adr/0023-durable-kernel-workflow-recovery-and-availability.md)、[ADR-0024（资源分区、沙箱与运行时提权）](../../adr/0024-resource-partition-sandbox-and-runtime-elevation.md)、[ADR-0020（核心模块归属与依赖方向）](../../adr/0020-core-module-ownership-and-dependency-direction.md)
> 历史参考：ADR-0006、ADR-0013 已归档，不再作为实现权威
> 用途：记录本债的原始问题、目标边界与最终交付形态。本文是历史记录，不再作为待办清单。

## 关闭结论

本债登记的问题是“策略决策散落在 session/execution runtime，PolicyKernel 只审 plan”。截至 2026-07-27，路线图 Phase 3～5 已把全部战略决策收敛到单一纯控制面：

```text
Plan / ExecutionOutcome / TimerTick / CapacitySignal / Permission / Partition / Sandbox
  → ControlKernel.decide(event, snapshot)
  → KernelDecision（持久 ledger）
  → Runtime apply（只做副作用）
```

`PolicyKernel` 已被 `src/kernel/control-kernel.ts` 的 `ControlKernel` 取代，`TaskAdmissionGate`、`KernelDecisionApplier`、`TaskResumePlanner` 与 Session 内的失败/定时策略表已删除，不保留兼容路径。

## 第 7 节退出条件逐条核验（2026-07-27）

### 1. 单一决策入口 ✅

`ControlKernel` 只暴露 `decide(event, snapshot): KernelDecision`。事件判别联合覆盖 `plan_proposed`、`dispatch_requested`、`capacity_signal`、`execution_outcome`、`handoff_contract_failed`、`timer_tick`、`recovery_resolution_requested`、`permission_requested`、`permission_resolution_received`、`partition_conflict_observed`、`sandbox_lost`。决策联合覆盖 `dispatch_attempt`、`probe_capacity`、`wait_for_capacity`、`wait_for_retry`、`request_replan`、`block_work`、`park_for_replan`、`complete_task`、`grant_capability` / `deny_capability` / `escalate_capability`、`wait_for_partition`、`recover_workspace_attempt` 等。集中单测在 `tests/kernel/control-kernel.test.ts`。

### 2. Runtime 无战略分支 ✅

- `src/session/kernel-decision-applier.ts`、`src/session/task-admission-gate.ts`、`src/task/task-resume-planner.ts` 已删除。
- `src/session/session-execution-coordinator.ts` 只剩向 `src/execution/kernel-execution-runtime.ts` 的 re-export。
- `isTimerRecheckableBlockedTask` 已删除；`MetaclawSession.maybeReconcileBlockedTasksOnTimer` 只读取 ledger 中的 `wait_for_capacity` 决策并提交 `timer_tick` 事件，是否唤醒由 Kernel 依据 `recheckAfterMs` 与 `wakeAuthorized` 判定。
- 原始事实规范化与策略结论已拆开：Adapter 侧 `normalizeExecutorFailure` 产出结构化 `KernelFailure`（14 种 kind + `attempt`/`task`/`agent_class` scope），Kernel 只消费该事实。
- `tests/kernel/control-kernel-architecture.test.ts` 以断言锁定 Kernel 不 import session/task/execution/storage、不读 `Date.now`。

### 3. 失败策略可场景验证 ✅

| 原退出条件 | 实现 |
| --- | --- |
| 网络/超时 → block_wait 或等价 decision | `wait_for_retry` + 持久 backoff（network 5s、其余 30s），到期由 `timer_tick` 唤醒 |
| 权限 → 不自动解阻 / 需用户 | `permission`、`unknown`、`stale`、`cancelled` 一律 `block_work`；提权走 `permission_requested` → grant/deny/escalate |
| capability 失败 → switch_candidate 或 park/replan | `capability_mismatch` 进入 `fallbackOrReplan`，按 `preferredAgentClassList` 顺序换 AgentClass |
| 候选耗尽 → 终端 decision | `request_replan`（每 generation 至多一次）→ `park_for_replan` |
| 超过 retry cap → 熔断或升级 | 同 AgentClass attempt 上限；`deriveAgentAvailability` 由 bounded recent-attempt projection 纯派生熔断（10min 窗口 / 3 次连续瞬时失败 / 5min 冷却 → `probe_eligible`） |

场景级验证另见 `tests/session/kernel-retry-control-loop.test.ts`、`tests/session/kernel-capacity-control-loop.test.ts`、`tests/session/blocked-task-user-journey.test.ts`。

### 4. ADR 对齐 ✅

ADR-0022、ADR-0023、ADR-0024 已 Accepted 并进入 `docs/adr/README.md` 权威矩阵；ADR-0006、ADR-0013 位于 `docs/archive/adr/`，不再被引用为现行接口依据。

### 5. 文档与命名不再误导 ✅

`AGENTS.md`、`docs/README.md`、`CONTEXT.md` 与 `docs/current/technical-overview.md` 已统一描述为：Planning 只提案，`ControlKernel` 是唯一战略解释者，Session 是 Application Shell，Execution/Storage 只承担副作用与持久化。

## 附录：原始问题记录

### A. 当时的错误切分

| 职责 | 应归属 | 当时现状 |
| --- | --- | --- |
| 把退出码、超时、原始异常规范化为稳定 outcome | Executor Adapter / Runtime | 与策略判断混杂在 `isRecoverableExecutorFailure` 一个布尔函数里 |
| 按规范化事实选择 recovery、是否换 peer、是否 replan、熔断与次数上限 | Kernel | 缺失或散落在 coordinator / session timer |
| 定时器、事件到达后触发一次裁决并 apply | Runtime 触发 + Kernel 决策 | timer 自己拍板 |

### B. 当时散落在 Runtime 的决策点

1. **执行失败分类与落态**：`session-execution-coordinator` 用正则判定 recoverable 后直接 `markDispatchBlocked` 或 park，没有 `RecoveryDecision`。
2. **自动恢复触发**：`maybeReconcileBlockedTasksOnTimer` 与 `isTimerRecheckableBlockedTask` 构成第二套策略表，不经 Kernel。
3. **备选执行器与 fallback chain**：`ExecutionRuntime` 的 `fallbackExecutors` 字段存在但成功路径填空数组，失败后不换 peer。
4. **回传 Planner / replan**：没有“何时强制回 Planner”的决策与触发。
5. **熔断与次数上限**：无 attempt cap、无 circuit、无冷却。
6. **命名债叠加**：`kernel-decision-applier`、`task-admission-gate` 在 session 目录，放大“kernel 职责不清”的观感。

### C. 当时的临时行为（已全部废止）

- 执行失败：recoverable → task blocked；其他 → task parked。
- blocked 可恢复任务：默认约 60s 定时检查，executor 可用则 `resume-blocked`。
- 无同一次 run 内自动重试；无 post-failure peer fallback 主路径；无执行熔断。
- Work unit 有 lease/heartbeat 状态机，但不驱动统一 kernel recovery decision。

以上行为均已由 Phase 3～5 的统一控制面替换。并发调度本身不属于本债范围，仍由路线图 Phase 6 追踪。
