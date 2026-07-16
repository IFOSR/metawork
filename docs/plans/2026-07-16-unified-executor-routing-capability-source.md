# 统一 Executor Routing Capability 定义源实施计划

## 计划状态

- **计划日期**：2026-07-16
- **当前状态**：第一批已完成；第二、三批待实施
- **范围**：只统一 `codex-cli` 与 `pi-agent` 的静态能力定义、Planner 投影、Seeder 数据和 Adapter binding
- **不在本轮**：PlanningAgentPlan v3、Subtask 拆分规则、并行调度、自动 fallback 策略、第三 Executor
- **完成日期**：整体未完成；第一批完成于 2026-07-16
- **实现提交**：`feat: establish canonical executor capability definitions`

本计划落实 [`planner-routing-capability-model-debt.md`](../tech-debt/planner-routing-capability-model-debt.md)。当前静态 `executorCatalog` 已经注入 Planner 启动上下文，动态类健康与近期执行结果也已通过 `list_executor_status` 独立提供；本轮不重做这两条通路，只消除静态能力事实仍散落在目录、Seeder、数据库 profile 和 AdapterRegistry 中的问题。

### 第一批完成记录

- 已建立由 registry key 派生的受控 `RoutingCapabilityId`、稳定 `ExecutorAffordanceId`，以及带 `deliveryContract`、`requiredAffordances` 的两个能力定义。
- 已将 Codex/Pi Routing Profile、两层 affordance、完整 AgentClass defaults 与声明式 Adapter binding 合入 canonical definitions；Pi 的 workspace 能力只保留在 native 层。
- `historicalSuccess` 不进入 canonical Executor defaults 或 Planner catalog；Planner 继续通过 `list_executor_status` 获取动态健康与近期执行结果。
- 已增加模块加载时 fail-fast 校验和可独立测试的纯 validator，并将 Planner catalog 升为 v2、加入顶层 capability contracts、保证稳定排序与深复制。
- 已将 `PlanningContext.executorCatalog` 改为必填，并更新 Planner、runner、schema 与 context builder fixture；未修改 Seeder、AdapterRegistry、PolicyKernel、数据库、Plan schema 或调度行为。
- 验证通过：目标 4 个测试文件共 25 项、额外 PlanningAgent plan schema 2 项、`npm run lint`、`npm run build`。
- 第一批由 `feat: establish canonical executor capability definitions` 提交落地。

## 一、目标与约束

本轮完成后，内置 Executor 只有一个 canonical definition source。该定义源同时拥有：

- 受控 `RoutingCapabilityId` 注册表及其最小交付契约；
- `codex-cli`、`pi-agent` 的 Routing Profile；
- Planner-safe 投影所需的差异性 affordance 与适用/避免语义；
- Adapter binding、命令别名和能力证据声明；
- Seeder 构造内置 AgentClass 默认值所需的数据。

`routingCapabilities` 表示 MetaClaw 对某 Executor 提供的**受支持路由契约**，不是其底层工具、权限或理论能力全集。`pi-agent` 保留 `bash/read/write/edit` 等原生工具，但本地工程任务仍应优先路由给 `codex-cli`。这种差异用于任务最优化，不构成对底层能力的物理禁用。

Planner 继续使用启动上下文中的静态 `executorCatalog` 理解能力差异，需要当前事实时调用 `list_executor_status`。Planner 为每个 Subtask 给出有序首选清单：首项是 preferred AgentClass，其余项是 fallback chain。现有 wire/storage 字段可继续使用 `candidateAgentClasses`；本计划不为术语重命名升级 Plan schema。

PolicyKernel 和 Runtime 继续对已规划清单做现有的注册、健康和执行时检查。本轮不新增“某类失败后自动降级到具有相近底层工具的次优类”的政策，只保证统一目录不会把这种未来能力堵死。

## 二、当前重复源

当前已有 [`src/executor/builtin-executor-catalog.ts`](../../src/executor/builtin-executor-catalog.ts)，但它只保存 Planner-safe 描述，并明确把 Runtime 配置留给 Adapter；因此还不是完整定义源。

重复事实主要位于：

- `builtin-executor-catalog.ts`：Planner Routing Profile 与 affordance；
- `agent-class-seeder.ts`：按 Executor 名称分支生成 capabilities、用途和弱项；
- `execution-runtime.ts`：单独硬编码 Adapter 名称、factory 和命令别名；
- `agent_classes` 行及自定义注册向导：保留自由字符串 `capabilities`，不能直接视为受控 Routing Capability；
- 测试 fixture：分别复制不同版本的 Executor profile。

动态 `Kernel Executor Status Projection` 不是重复源。它表达健康和近期执行结果，继续由 ADR-0017 和 `list_executor_status` 管理。

## 三、目标模块接口

在 `src/executor/` 中把现有 Planner-only 目录深化为内置 Executor 定义模块。具体文件可在实现时按循环依赖调整，但对调用者只保留小接口：

```ts
type RoutingCapabilityId =
  | 'workspace-engineering'
  | 'current-web-research';

interface RoutingCapabilityDefinition {
  id: RoutingCapabilityId;
  deliveryContract: string;
  evidenceRequirements: string[];
}

interface BuiltinExecutorDefinition {
  name: 'codex-cli' | 'pi-agent';
  routingProfile: {
    routingCapabilities: RoutingCapabilityId[];
    primaryUseCases: string[];
    avoidUseCases: string[];
    affordances: string[];
  };
  adapterBinding: {
    adapterName: string;
    commandAliases: string[];
  };
  agentClassDefaults: AgentClassDefaults;
  evidence: ExecutorCapabilityEvidence;
}
```

预期公开用途只有三类：

1. 读取稳定排序的内置定义；
2. 从定义派生 Planner-safe catalog；
3. 校验 capability、profile、Adapter binding 与证据声明的一致性。

不新增只做字段转发的 Catalog service，也不把实际凭据、命令参数、完整 Skill 内容或动态健康写进 Planner 投影。

## 四、分批实施

### 第一批：受控注册表与 canonical definitions

目标：先建立单一静态定义源，不改变 Planner/Runtime 行为。

- 定义封闭的 `RoutingCapabilityId` 和 capability registry。
- 记录每个 capability 的最小交付契约和证据要求。
- 将 `codex-cli` 与 `pi-agent` 的 Routing Profile、affordance、Adapter binding 和 AgentClass defaults 合并到 canonical definitions。
- 保留 Pi 的原生写入与 shell 工具；profile 只表达路由优先级和支持契约。
- 让 `getPlannerExecutorCatalog()` 从 canonical definitions 做稳定、只读投影。
- 增加纯目录测试：唯一 ID、稳定排序、无重复 Executor、能力均已注册、Planner 投影不泄漏 Runtime 配置。

第一批验收：Planner 得到的目录内容与当前行为一致，但所有静态 Routing Capability 字符串只在 capability registry/canonical definitions 中定义一次。

### 第二批：替换静态重复消费者

目标：让执行器侧和 Planner 侧真正消费同一来源。

- `agent-class-seeder.ts` 从 canonical definition 构造两个内置 AgentClass 默认值，不再按 `defaultExecutorName` 分支复制 profile。
- `ExecutorAdapterRegistry` 的内置名称和命令别名从 canonical definition 派生，或在注册时与 canonical binding 做强一致性校验；不得继续独立维护第二张名称表。
- PolicyKernel 接收的静态 catalog 类型继续来自同一模块；动态健康仍来自 `Kernel Executor Status Projection`。
- 现有 `candidateAgentClasses` 保持有序语义：首项 preferred，其余为 fallback chain；不在本批升级 schema 或修改调度算法。
- 旧自定义 Executor 数据继续保留并可按现有 Runtime 路径使用，但自由字符串 `capabilities` 不自动升级为受控 Routing Capability，也不进入内置 Planner catalog。
- 内置名称与自定义名称冲突时 fail closed；不得静默把自定义 profile 解释成 canonical built-in definition。

第二批验收：修改一个内置 Executor 的 Routing Profile 或 binding 时，Planner 投影、Seeder 和 Adapter 校验会同步变化，测试中不再需要分别修改多份能力表。

### 第三批：一致性门禁、迁移保护与收尾

目标：证明统一源不会被旧数据或 fixture 绕开。

- 在启动或组合根执行目录一致性校验；未注册 capability、重复 binding、缺失 Adapter、证据声明缺失时 fail closed。
- 对已有数据库执行兼容验证：不覆盖用户自定义 Executor，不把旧 `capabilities_json` 当作新的受控注册表。
- 更新 Planner、Seeder、ExecutionRuntime 和 Kernel 相关 fixture，使其从目录 builder/fixture factory 生成。
- 删除已失去用途的静态 profile 分支和重复常量。
- 更新 `CONTEXT.md`、技术概览及本计划状态，记录实际验证与提交。
- Windows 运行 `npm run lint` 和 `npm run build`；涉及 SQLite、Seeder 或集成路径的测试按仓库规则在 Docker 中运行。

第三批验收：全仓搜索不再出现另一套内置 Routing Capability/Profile/Adapter 名称映射；自定义数据未被覆盖；动态 `list_executor_status` 行为不回归。

## 五、明确暂缓

- `PlanningAgentPlan` v3 与 `requiredCapabilities` 字段；
- 根据能力覆盖自动生成或改写候选清单；
- “单线依赖必须合并”、同层同 Executor 禁止、并行 Subtask 等工作图规则；
- 真正的并行执行、workspace partition、worktree 和异步调度；
- Kernel 自动 fallback、重试次数、熔断、恢复和重新规划；
- 限制 Pi 的原生写入、shell 或文件工具；
- 第三 Executor 与自定义 Executor capability certification。

这些事项不得作为本计划任何一批的顺手扩展。

## 六、完成定义

- 受控 capability registry 与两个内置 Executor definition 成为唯一静态事实源。
- Planner-safe `executorCatalog`、Seeder 和 Adapter binding 均由该源派生或由它强校验。
- `list_executor_status` 继续只提供动态健康与近期结果，不承载静态能力定义。
- Routing Capability 被验证为支持契约，而非工具全集或硬权限限制。
- 自定义 Executor 数据得到保留，但未经认证的自由能力字符串不污染内置目录。
- 三批各自具有聚焦测试，计划文档回填完成日期、实际行为、验证和提交。
