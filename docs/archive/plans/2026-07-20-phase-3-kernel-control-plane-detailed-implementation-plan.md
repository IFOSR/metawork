# Phase 3：统一 Kernel 控制面详细实施计划

## 计划状态

- **计划日期**：2026-07-20
- **当前状态**：已完成并归档
- **所属路线图**：[Planner、Kernel 与并发调度收敛路线图](../../plans/2026-07-16-planner-kernel-concurrency-convergence-roadmap.md)
- **总体行动计划**：[Phase 3 Kernel 控制面收敛总体行动计划](2026-07-20-phase-3-kernel-control-plane-convergence.md)
- **架构设计门**：[ADR-0020](../../adr/0020-core-module-ownership-and-dependency-direction.md)、[ADR-0022](../../adr/0022-unified-kernel-control-plane-and-decision-ledger.md)
- **完成日期**：2026-07-20
- **实现提交**：`bfca74a`

## 目标与控制链

Phase 3 建立唯一串行控制链：

```text
event → bounded snapshot → ControlKernel.decide
      → durable decision ledger → Runtime apply
      → normalized event → quiescence
```

Planner 只提案，Control Kernel 只做纯决策，Runtime 只应用一个已持久化的高层 action 并报告事实，Application Shell 只触发控制循环和投影视图。

## 固定契约

- `ControlKernel` 唯一公开 Interface 是 `decide(event: KernelEvent, snapshot: KernelSnapshot): KernelDecision`。
- event、snapshot、decision 都使用 `schemaVersion: 1` 的判别联合；Decision ID 由 event ID 确定性派生。
- event 包含 `plan_proposed`、`dispatch_requested`、`capacity_signal`、`execution_outcome`、`handoff_contract_failed`、`timer_tick`。
- 每个 Decision 只含一个高层 action：`reject_request`、`request_clarification`、`deliver_direct_reply`、`no_op`、`authorize_task_plan`、`authorize_task_control`、`dispatch_attempt`、`probe_capacity`、`wait_for_capacity`、`block_work`、`park_for_replan` 或 `complete_task`。
- `authorize_task_plan` 只携带 Task Domain 值与授权 Work Graph；Runtime 不依赖 `PlanningAgentPlan`。
- `KernelControlLoop` 负责 snapshot、decide、ledger-first、apply、observe，直到静止。重复 event 不重复 apply；ledger 后 apply 前崩溃在本阶段 fail closed。
- SQLite v23 新建 `kernel_decisions`，并把 `planning_decisions` 改为只读 `planning_decisions_legacy_audit`；所有新决策只写新账本。
- Subtask 使用独立 `SubtaskStatus`，含 `ready | running | awaiting_decision | blocked | done | cancelled`；顶层 `TaskStatus` 不增加 `awaiting_decision`。
- 非成功 attempt 原子写 terminal receipt 与 `awaiting_decision`，释放 WorkUnit 后才上报 Kernel event；只有 Kernel Decision 可继续或阻塞它。
- capacity failure 不写 attempt receipt；Kernel 可按授权顺序尝试尚未探测的 AgentClass，耗尽后 `wait_for_capacity`。
- timer 只恢复由 ledger 标识的容量阻塞；executor failure、network、timeout、heartbeat lost 不自动恢复。
- contract correction 是同 AgentClass 的一次 response-only attempt，不重跑 Subtask，不提供 evidence、tools、普通执行上下文或可写 workspace；第二次失败直接阻塞。

## 实施顺序

1. 新增 ADR-0022，更新 ADR/docs/路线图索引，冻结所有权、依赖和延期边界。
2. 以纯行为测试建立 Kernel event/snapshot/decision 契约及确定性决策矩阵。
3. 迁移到 SQLite v23，增加 Kernel ledger Repository、唯一 event 约束和 legacy audit 只读触发器。
4. 建立独立 Subtask 状态与 attempt terminal 原子落盘；把 claim capacity 与执行 outcome 分开。
5. 建立 `KernelControlLoop` 与 Runtime apply Interface，纵向打通 plan admission、dispatch、capacity、outcome、timer。
6. 落地 response-only correction profile，并验证输入上限、隔离和单次发布。
7. 删除旧 `PolicyKernel` 捷径、`TaskAdmissionGate`、多 Task Scheduler 策略、Runtime AgentClass selection、Session timer 正则和对应旧测试。
8. 更新技术文档，完成 lint、build、Docker/Linux 聚焦与全量测试以及真实 smoke。

## 验收标准

- 相同 event/snapshot 产生字节等价 Decision；Kernel 不导入 Session、Execution Runtime、Storage、Adapter、时间或随机 ID。
- plan、dispatch、capacity、execution outcome、contract failure 与 timer 的下一动作均能从 ledger 审计。
- 新决策无 `planning_decisions` 双写；legacy rows 完整且写入被拒绝。
- duplicate event 只有一条 Decision 且最多 apply 一次。
- WorkUnit 在 outcome 再次 decide 前已释放；非成功 Subtask 可观察为 `awaiting_decision`。
- 容量耗尽可被 timer probe 恢复；普通执行失败不可被 timer 重试。
- correction 相同 AgentClass、不同确定性 attempt ID、无 tools/evidence/write，且只发布纠正后的最终结果。
- 生产代码中不再存在旧 direct-reply shortcut、`TaskAdmissionGate`、多 Task queue/preemption/auto-resume policy、Runtime 候选遍历和 Session 错误文本恢复策略的调用方。
- `npm run lint`、`npm run build`、Docker/Linux 全量测试和核心 smoke 全部通过。

## 延期边界

- Phase 4：durable inbox/outbox、未应用 Decision 恢复、通用 apply 幂等、failure taxonomy、retry/fallback/backoff/circuit breaker。
- Phase 5：partition、lease、强制 workspace 隔离和崩溃清理。
- Phase 6：多顶层 Task queue、preemption、auto-resume、公平性、取消传播和真正并发。

## 完成记录

Phase 3 已交付统一 `ControlKernel.decide(event, snapshot)`、ledger-first `KernelControlLoop`、SQLite v23 `kernel_decisions`、只读 legacy Planning audit、独立 `SubtaskStatus.awaiting_decision`、确定性 dispatch/capacity loop、Kernel 授权的 outcome landing 与一次 response-only contract correction。Planner、确定性恢复入口、capacity、timer、attempt outcome 与 startup orphan reconciliation 均已接入同一持久决策链。

旧 `PolicyKernel`、`TaskAdmissionGate`、`SchedulerEngine`、`TaskResumePlanner`、`KernelDecisionApplier` 及其生产策略调用方已删除；多 Task queue、preemption、auto-resume 的历史验收测试保留为 skip，等待 Phase 6 在 partition/lease 基础上重建。Repo-backed executor status projector 已迁至 Execution；Runtime 不再依赖 `PlanningAgentPlan`，Session 不再以错误文本决定恢复。

验证结果：

- `npm run lint`：通过。
- `npm run build`：通过。
- Docker/Linux 全量 Vitest：176 个文件、715 个测试通过；4 个文件、15 个历史/延期测试跳过。
- Kernel 纯函数、ledger 去重、v22→v23 migration、capacity→timer recovery、attempt terminal 原子落盘与 response-only correction 均有聚焦回归覆盖。
- 仓库 smoke 测试在全量套件中通过。真实 Linux smoke 也已通过：在 `metaclaw-test` 镜像中只读挂载 Codex 凭证、显式配置 Planner/Executor Codex home 后，Codex Planner 经 ControlKernel/ledger 驱动 Codex Executor，并在授权 Task workspace 生成、发布且验证 `smoke-result.md`。Windows host 直接运行仍受仓库已知的 `better-sqlite3` native binding 缺失限制。
