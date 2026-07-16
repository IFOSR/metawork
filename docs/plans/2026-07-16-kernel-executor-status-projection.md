# Kernel 执行器状态投影与 Planner 动态状态查询计划

## 计划状态

- **计划日期**：2026-07-16
- **当前状态**：已完成
- **关联 ADR**：[ADR-0017](../adr/0017-kernel-executor-status-projection.md)
- **关联技术债**：[Kernel 决策权散落 Runtime](../tech-debt/kernel-decision-authority-scattered-in-runtime-debt.md)、[Planner 路由能力模型](../tech-debt/planner-routing-capability-model-debt.md)
- **完成日期**：2026-07-16
- **实际交付**：内置 `codex-cli`/`pi-agent` 静态 Planner catalog、持久化 Kernel Executor Status Projection、只读 `list_executor_status` Planner MCP、PolicyKernel 健康状态校验，以及 Runtime 执行结果的同步投影更新。
- **兼容性决策**：沿用已持久化的 `candidateAgentClasses` 作为每个 Subtask 唯一的有序候选列表；首项是首选，后续项是 Runtime 回退顺序，不额外写入重复字段。
- **验证**：`npm run lint`、`npm run build`、`docker build -f Dockerfile.test -t metaclaw-test .`、`docker run --rm metaclaw-test`（173 files / 769 tests passed，4 skipped）。
- **实现提交**：`feat: add kernel executor status projection`（本次提交）。

本计划只处理两类 Planner 输入的分离，以及为后续 Kernel 控制面改造建立动态状态投影。它不实现完整的 Kernel 调度、重试、熔断、自动恢复或并行执行。

## 一、目标与边界

Planner 的执行器信息分成两个独立来源：

```text
启动上下文：静态 Executor Catalog
  → 每个 AgentClass 的差异化路由能力与关键 affordance

Planner MCP：动态 Kernel Executor Status Projection
  → 每个 AgentClass 的 classHealth 与最近三次安全执行摘要
```

Planner 基于这两份信息为每个 Subtask 生成唯一的有序 `executorCandidates` 列表。首项是首选，后续项即 Runtime 的回退顺序；不再存储重复的 `preferredAgentClass`、`eligibleCandidates` 或 `fallbackChain`。

本轮不改变“每次选择 AgentClass 时可启动独立实例”的执行模型。因此同类已有 WorkUnit 在运行、等待或失败不构成 `busy`，也不阻止新计划选择该类。

## 二、领域模型与契约

### 静态 Executor Catalog

- 在 Planner 启动上下文中直接注入稳定、只读、固定排序的 Planner-safe catalog。
- 只包含 AgentClass 名称、Routing Capability、用途描述、避免场景和必要的抽象 affordance。
- 不包含 runtime command、模型配置、凭据、WorkUnit、容量、健康状态或原始执行日志。
- Planner 使用该 catalog 形成候选顺序；Kernel 继续以已注册 AgentClass 身份校验候选，以保护已有自定义 Executor。

### Kernel Executor Status Projection

每个 AgentClass 一条持久化记录，最小字段为：

```ts
interface KernelExecutorStatusProjection {
  agentClassName: string;
  classHealth: 'unverified' | 'healthy' | 'error' | 'disabled';
  recentAttempts: Array<{
    completedAt: string;
    outcome: 'succeeded' | 'failed';
    failureKind: 'network' | 'timeout' | 'config' | 'adapter' | 'unknown' | null;
    reason: string | null;
  }>;
  updatedAt: string;
}
```

- `recentAttempts` 最多保留三条；不能包含 prompt、stdout、工具调用、凭据或 runtime command。
- 单次 `network` 或 `timeout` 实例失败只写最近结果，不改变 `classHealth`。
- `error` 表示已确认的类别级故障；`disabled` 表示显式禁用。二者的后续恢复/自动转移策略暂缓给 Kernel 调度改造。
- Runtime 已确认事实和投影更新在同一处理链同步完成。

### Kernel 内部职责

- `PolicyKernel` 保持纯决策：读取静态 catalog 与动态 Projection。
- 新的 `KernelExecutorStatusProjector` 归 `src/kernel/`，拥有投影归约语义。
- Runtime 仍执行 adapter、维护 WorkUnit 生命周期、记录原始事实并应用持久化副作用。

## 三、实施阶段

### Phase 1：类型、存储与投影归约

- 在 `src/kernel/` 定义 projection 类型、健康状态与 `KernelExecutorStatusProjector` 的纯归约接口。
- 新增持久化 projection 表与 repository；按 AgentClass 一行保存健康状态、最近三条摘要、更新时间和 catalog/version 关联信息。
- 从现有 WorkUnit 事件、probe 结果和执行结果建立同步更新入口。
- 明确并测试：实例 `running`/`waiting`/`failed` 不产生 AgentClass `busy`；网络/超时只更新 recent attempt；类别级 config/adapter 失败可投影为 `error`。

### Phase 2：Planner 静态/动态输入分离

- 由内置 Executor Catalog 生成 Planner-safe 静态 snapshot，并在每个 PlanningAgent 调用开始时注入。
- 将 Planner MCP 的 `list_executor_classes` 替换为只读 `list_executor_status`，只返回 projection 的安全字段。
- 修改 Planner prompt：静态能力来自启动上下文；需要近期运行事实时才调用动态状态工具。
- 让 Planner 输出每个 Subtask 唯一的有序 `executorCandidates`，首项即首选与回退起点。

### Phase 3：Kernel 校验与 Runtime 衔接

- Kernel 校验候选名称属于已注册 AgentClass，候选列表非空、稳定排序且无重复；静态 catalog 不会使既有自定义 Executor 失效。
- `disabled` 不得进入候选；`error` 默认拒绝进入候选；`unverified` 与 `healthy` 可进入候选。
- Runtime 按已批准顺序启动/claim 独立实例；实例结果同步更新 projection，后续 Planner 查询可见。
- 不在本阶段引入自动重试、自动恢复、熔断、候选耗尽 replan 或容量策略。

### Phase 4：回归与文档

- 更新 Planner MCP、Kernel、WorkUnit claim、session execution 和存储测试。
- 覆盖静态 catalog 不经 MCP 获取、动态状态 MCP 只返回安全摘要、三条历史截断、重启后投影保留、网络失败不贬低健康、config/adapter 故障变为 `error`、`disabled` 不可选。
- Windows 运行 `npm run lint` 与 `npm run build`；Docker 运行涉及 SQLite 的测试。
- 回填本计划状态、实际行为、验证命令与实现提交。

## 四、验收标准

- Planner 在启动时已获得静态 Executor Catalog，不需要通过 MCP 查询能力目录。
- Planner 可按需读取每类 Executor 的持久化动态状态投影；该接口不泄露运行配置或原始日志。
- 每类 AgentClass 只有一行状态，且 WorkUnit `busy` 不影响新实例选择。
- 同步落地的新执行结果会在下一次 Planner 查询中出现；只保留最近三条安全摘要。
- 网络/超时失败不会让 `classHealth` 变为 `error`；已确认 config/adapter 故障会反映为 `error`；`disabled` 永不进入候选。
- `PolicyKernel` 不直接执行 adapter 或持久化 Runtime 事实；`KernelExecutorStatusProjector` 为后续 Kernel 控制面提供可扩展状态边界。

## 五、明确暂缓

- `classHealth` 的自动恢复、连续失败阈值、熔断、冷却与定时 recheck；
- 失败后的自动换 peer、replan、retry cap 与候选耗尽策略；
- 有限容量、共享 worker pool、busy 状态、并行调度与 worktree 隔离；
- 第三 Executor 与自定义 Executor 的认证流程；
- 把 Runtime 副作用搬进 `PolicyKernel`。
