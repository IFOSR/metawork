# 多顶层 Task 调度未来路线图

## 状态

- 状态：延期，未激活
- 记录日期：2026-07-28
- 前置能力：Phase 6 单 Task 并发可靠性已完成
- 当前约束：ADR-0011 保持有效

## 边界

本文件只保存未来可能启动的独立产品路线，不是
`2026-07-16-planner-kernel-concurrency-convergence-roadmap.md` 的未完成阶段。
当前生产契约只接纳一个活跃顶层 Task；取消后的 sandbox、WorkUnit 和 lease
清理完成前，该 Task 仍占用单活位置。

未来若明确启动，应在实施前重新确认：

- 多 Task admission 与候选快照；
- 协作式、非强制抢占的优先级策略；
- 每 Task 并发上限、公平性、等待 aging 与饥饿保护；
- 跨 Task partition 等待、取消、崩溃恢复与完成隔离；
- TUI、Gateway 和 Feishu 的结构化多 Task 运行投影；
- ADR-0011 的修订或归档条件。

## 必须复用的既有 seam

未来实现必须复用 Kernel v4 的纯 `decide(event, snapshot)`、durable
Kernel workflow、dispatch item、attempt supervisor、resource lease、持久
Subtask worktree、publication gate、取消协调器和严格完成门。不得恢复旧
Scheduler、TaskAdmissionGate、强制抢占或第二套 Runtime 策略链。

## 非承诺

本文不承诺排期、默认权重、每 Task slot 数量或 ADR-0011 的最终处理。只有用户
重新激活本路线图并完成新的架构决策与详细计划后，多顶层 Task 才进入实现范围。
