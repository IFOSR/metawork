# Planner 工作区分区与并发调度技术债

- 状态：已归档；全部未完成事项由 Planner、Kernel 与并发调度收敛路线图 Phase 5～6 接管
- 记录日期：2026-07-15
- 归档日期：2026-07-16
- 接管计划：`docs/plans/2026-07-16-planner-kernel-concurrency-convergence-roadmap.md`

## 为什么独立记录

PlanningAgentPlan v3 本轮只收紧 Executor 级拆分，不增加 workspace partition 或 execution layer。当前 Runtime 继续串行执行。把分区身份和并发租约提前塞进 v3，会让尚未设计完成的 Kernel 资源语义变成不稳定契约。

## 最终目标

- Planner 为每个 Subtask 规划明确工作分区。
- 同一 Task 内使用相同分区的两个 Subtask 必须存在可达依赖关系；没有依赖就代表规划可能产生并行写冲突，应在授权前拒绝或 repair。
- 没有分区冲突且处于同一派生执行层的 Subtask，未来可以并行。
- 不同 Task 的 Subtask 请求同一分区时，Kernel/调度层挂起后来者；前一个租约释放后再唤醒。
- 相同分区所形成的依赖自然决定串行顺序，不需要 Planner 额外输出显式 execution layer。

## 待设计问题

1. **分区身份**：仓库、工作树、目录、逻辑资源或外部系统对象如何形成稳定且不可伪造的 partition key。
2. **覆盖与冲突**：父目录/子目录、通配资源、只读与写入、外部对象之间如何判断重叠。
3. **租约持久化**：owner、Task/Subtask、租期、heartbeat、等待队列、公平性和幂等 claim 的存储模型。
4. **崩溃恢复**：进程退出、WorkUnit 丢失、租约过期、部分产物和重复唤醒的恢复规则。
5. **工作树隔离**：何时创建独立 worktree/临时目录，如何限制写入范围和清理残留。
6. **并行结果合并**：无冲突文件、同文件变更、生成产物、依赖 handoff 和最终聚合的确定性策略。
7. **跨 Task 调度**：等待者优先级、饥饿保护、取消传播和任务关闭时的租约释放。
8. **授权边界**：Planner 提案、PolicyKernel 授权、Scheduler claim 和 Runtime 文件防线分别负责什么。

## 当前临时行为

- Runtime 串行执行所有 ready Subtask。
- 同一层存在多个 ready Subtask 时按稳定 Subtask ID 排序。
- 结构校验可以推导层级，但不得据此宣称已经支持并行。
- Phase 0 Spike 使用彼此独立的 Docker 工作目录，不作为生产分区实现。

## 退出条件

只有在分区 key、持久租约、崩溃恢复、隔离机制和并行合并均形成 ADR、数据迁移与容器级竞争测试后，才能关闭本技术债并允许 Runtime 并行。
