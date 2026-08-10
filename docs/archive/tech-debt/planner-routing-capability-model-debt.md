# Planner 路由能力模型统一源技术债

> 状态：已完成（第一至第三批）
>
> 创建日期：2026-07-15
>
> 修订日期：2026-07-16
>
> 实施计划：[`docs/plans/2026-07-16-unified-executor-routing-capability-source.md`](../plans/2026-07-16-unified-executor-routing-capability-source.md)
>
> 架构决策：[`ADR-0018`](../adr/0018-supported-routing-contracts-and-unified-executor-definitions.md)
>
> 本轮范围：仅统一 `codex-cli` 与 `pi-agent` 的静态能力定义源。

## 结论

Planner 的静态 Executor 目录、AgentClass Seeder、Adapter binding 和 required-affordance 支持边界必须来自同一个 canonical built-in Executor definition source。不能让 Planner catalog、Seeder、AdapterRegistry、数据库默认值和 fixture 分别维护不同能力表。

采用：

```text
受控 Routing Capability 注册表
        │
        └── canonical BuiltinExecutorDefinition
              ├── Routing Profile
              ├── Planner-safe affordance projection
              ├── AgentClass seed defaults
              ├── Adapter binding / command aliases
              └── required affordance support boundary
                        │
                        ├── Planner 启动上下文 executorCatalog
                        ├── Seeder
                        ├── PolicyKernel 静态校验输入
                        └── ExecutionRuntime Adapter 注册/校验

动态 Kernel Executor Status Projection
        └── list_executor_status
```

静态能力与动态状态是两个来源不同、语义不同的输入：前者来自 canonical definitions，后者以现有 `list_executor_status` 为准。本轮不合并它们，也不重做动态健康投影。

## Routing Capability 的语义

`Routing Capability` 是 MetaClaw 对某 Executor 提供的**受支持路由契约**，用于优化任务选择；它不是底层工具、权限或理论能力全集。

因此：

- 不同 Executor 的通用底层能力不需要全部暴露给 Planner；
- 未暴露某项 Routing Capability，不等于物理禁用对应工具；
- `primaryUseCases` 与 `avoidUseCases` 表达路由偏好，不是安全沙箱；
- 完整 CLI、Skill、MCP、命令、权限和 probe 是实现与验证证据，不是 Planner 的逐工具编排输入；
- 可以向 Planner 暴露稳定的差异性 affordance，例如 `workspace-read-write`、`public-web-search`，但不暴露易漂移的完整工具清单。

本轮保留 `pi-agent` 原生的 `bash/read/write/edit` 等工具。本地工程任务应避免优先路由给 Pi，但未来 Kernel 可以在首选类不可用时考虑具有重叠底层功能的次优类；该 fallback 政策不是本轮实现目标。

## 本轮最小能力注册表

只登记会显著影响 Executor 首选顺序的能力。通用文本交付、命令执行细节、模型偏好、成本、成功率和主观强项不属于 Routing Capability。

| ID | 受支持交付契约 | Required affordances | 本轮主要声明者 |
| --- | --- | --- | --- |
| `workspace-engineering` | 在受控工作区理解、修改和验证代码/文本文件；交付变更、测试或必要本地产物 | `workspace-read-write`、`workspace-command-validation` | `codex-cli` |
| `current-web-research` | 获取当前公开网页信息、记录可追溯来源，并交付可被下游消费的研究结论 | `public-web-search`、`public-web-fetch`、`source-citation` | `pi-agent` |

“主要声明者”表示正常路由首选，不表示其他 Executor 必须删除相近工具。新能力只能在出现新的、无法由现有契约表达的路由差异时增加，并同时定义 ID、交付契约、required affordances 和 profile 声明。

## canonical definition 与 Planner-safe projection

`src/executor/` 中的内置目录模块是唯一静态定义源。它拥有完整的内置定义，但向 Planner 只投影稳定、最小的信息：

```ts
type RoutingCapabilityId =
  | 'workspace-engineering'
  | 'current-web-research';

interface PlannerExecutorProfile {
  name: string;
  routingCapabilities: RoutingCapabilityId[];
  primaryUseCases: string[];
  avoidUseCases: string[];
  affordances: string[];
}
```

本轮 profile：

```ts
const codexCli = {
  name: 'codex-cli',
  routingCapabilities: ['workspace-engineering'],
  primaryUseCases: ['代码库实现、测试、工程文档与本地产物'],
  avoidUseCases: ['需要当前公开网页证据的研究'],
  affordances: ['workspace-read-write', 'workspace-command-validation'],
};

const piAgent = {
  name: 'pi-agent',
  routingCapabilities: ['current-web-research'],
  primaryUseCases: ['当前公开网络研究、来源核验与引用交接'],
  avoidUseCases: ['本地代码库修改、测试与工程产物生成'],
  affordances: ['public-web-search', 'public-web-fetch', 'source-citation'],
};
```

Planner 不得从该投影看到凭据、具体命令、环境变量、完整 Skill 内容或工具全集。`list_executor_status` 继续按 ADR-0017 提供动态类健康和近期执行结果。

## Planner 与 Kernel 的本轮使用方式

Planner 综合启动上下文中的静态 `executorCatalog` 与按需查询的 `list_executor_status`，为每个 Subtask 生成有序 Preferred AgentClass List：

```text
[首选 AgentClass, fallback 1, fallback 2, ...]
```

首项是 preferred AgentClass，其余项是 fallback chain。现有 `candidateAgentClasses` 可继续作为该概念的 wire/storage 字段，本轮不升级 PlanningAgentPlan schema。

PolicyKernel 在实际应用计划前继续检查清单中的 AgentClass 是否已注册以及当前状态是否允许；前项不可用时按已批准顺序回退的现有行为保持不变。本轮不新增自动重试、熔断、跨类替代推理或失败后重新规划。

## 已消除的重复事实

- Planner catalog、Codex/Pi AgentClass、Adapter 名称与 aliases 均由 canonical definitions 派生。
- 默认 Adapter 组合根验证全部 canonical definitions 均有 factory。
- Codex/Pi 数据库行在启动时强制收敛；业务写入口拒绝 canonical 名称。
- 非 canonical `agent_classes.capabilities_json` 仍是自由字符串，但不会进入受控 Planner catalog。
- 遗留 `executor_profiles` 已由 migration v20 删除，canonical fixture 不再复制另一套 profile 或 binding。

以上内置静态事实现在均从 canonical definitions 派生或由其强校验。非 canonical 自定义 Executor 数据保留，但自由字符串 capability 不自动进入受控内置目录。

## 实施债务与验收

- [x] 定义受控 `RoutingCapabilityId` 注册表、交付契约和基于 required affordances 的支持边界。
- [x] 将两个内置 Executor 的 Routing Profile、AgentClass defaults、声明式 Adapter binding 和 affordance 声明合入 canonical definitions。
- [x] 让现有 `getPlannerExecutorCatalog()` 只从 canonical definitions 做稳定、深复制的 v2 投影。
- [x] 让 Seeder 从 canonical definitions 构造内置默认值，不再按名称复制 profile。
- [x] 让 AdapterRegistry 从 canonical binding 派生或对其做强一致性校验。
- [x] 对未注册 capability、重复 Executor/binding/alias、缺失 required native/planner affordance 和越界 Planner affordance 在模块加载时 fail closed。
- [x] 在接入 AdapterRegistry 后，对缺失实际 Adapter/factory 和 canonical binding 不一致继续 fail closed。
- [x] 保留旧自定义 Executor 数据，但不把其自由 capability 字符串自动认证为受控 Routing Capability。
- [x] 证明 `list_executor_status` 仍只承载动态状态，静态能力不重新进入 MCP 查询。
- [x] 删除静态 `historicalSuccess`，并通过 migration v19 物理移除新旧两张 Executor 表中的历史列。
- [x] 启动时将 Codex/Pi 全量静态 AgentClass 字段强制收敛到 canonical definitions，并封闭业务写入口。
- [x] 通过 migration v20 删除停用的 `executor_profiles`，不再保留数据库中的第二套能力字段。
- [x] 将第一批 PlanningContext、PlanningAgent 和 runner fixture 改为显式使用 canonical catalog。
- [x] 在第二、三批接入 Seeder/Runtime 后，移除重复 canonical fixture，并从 definitions 派生名称类型与 AgentClass 投影。

## 非目标

- 不实现 PlanningAgentPlan v3 或 `requiredCapabilities`。
- 不实现 Subtask 合并、同层 Executor 唯一、并行或单线依赖规则。
- 不设计异步任务系统、workspace partition 或多 worktree。
- 不新增 Kernel fallback、重试、熔断或恢复政策。
- 不移除 Pi 的写入、shell 或其他原生工具。
- 不设计第三 Executor 或自定义 Executor capability certification。
- 不实现 capability 蕴含、模糊匹配、自动 ontology 学习或动态成本路由。
