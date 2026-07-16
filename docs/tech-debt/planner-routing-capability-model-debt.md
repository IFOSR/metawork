# Planner 路由能力模型技术债

> 状态：已定方案，待实施  
> 创建日期：2026-07-15  
> 修订日期：2026-07-16  
> 关联计划：[`docs/plans/2026-07-15-planner-executor-capability-boundaries-and-demo-catalog-zh.md`](../plans/2026-07-15-planner-executor-capability-boundaries-and-demo-catalog-zh.md)  
> 本轮范围：仅 `codex-cli` 与 `pi-agent`；第三 Executor 明确暂缓。

## 结论

Planner 的能力需求、AgentClass 的能力声明和 Kernel 的覆盖判断必须来自同一个受控注册表。不能让 Planner 生成自由字符串，也不能让 Seeder、prompt、MCP SQL、fixture 分别维护不同能力表。

采用 **Routing Capability 注册表 + canonical AgentClass Routing Profile + Planner-safe projection**：

```text
能力注册表
  ├── 稳定 ID
  ├── 最小交付契约
  ├── 验证证据要求
  └── 适用/避免语义
        │
        ├── 内置 AgentClass canonical profile
        │     ├── codex-cli
        │     └── pi-agent
        │
        ├── Planner-safe snapshot → Planner 决策
        └── 同一 snapshot + 注册表 → PolicyKernel 覆盖校验
```

完整工具、CLI、Skill、MCP、运行命令、权限和 probe 是能力声明的实现证据；它们不应作为 Planner 的逐工具编排输入。

## 为什么现在必须先做

`PlanningAgentPlan v3.requiredCapabilities` 在没有注册表时只能安全地为 `[]`。此时结构规则可以阻止明显的同 Executor 步骤拆分，却不能判断一个 Executor 是否覆盖整个任务，也不能证明两个 Executor 的交接确有必要。

因此本技术债是 v3 真实能力语义、最少 Executor 拆分和 Kernel 防线的前置条件，而不是第三 Executor demo 的附属工作。

## 本轮最小能力注册表

只登记会改变“选择哪个 Executor”或“是否需要 Executor 交接”的能力。通用文本交付、命令执行细节、模型偏好、成本、成功率和主观强项不属于 Routing Capability。

| ID | 最小交付契约 | 证据要求 | 本轮声明者 |
| --- | --- | --- | --- |
| `workspace-engineering` | 在受控工作区理解、修改和验证代码/文本文件；交付变更、测试或必要本地产物 | 对应 Adapter、工作区读写与命令执行 probe、工程任务测试 | `codex-cli` |
| `current-web-research` | 获取当前公开网页信息、记录可追溯来源，并交付可被下游消费的研究结论 | 对应 Adapter、web search/web fetch 工具、来源与失败降级测试 | `pi-agent` |

`workspace-engineering` 包含工程文档、普通本地 PDF 和同次验证，只要这些工作不会改变 Executor 选择。`current-web-research` 不隐含本地代码库修改能力。

新能力只能在出现新的、不可由现有能力表达的 Executor 路由边界时增加；必须同时定义 ID、最小交付契约、验证证据和 profile 声明。第三 Executor 若未来加入，必须走该流程，不能先注册再补能力语义。

## canonical profile 与安全投影

目录模块应是唯一内置定义来源。它可以包含完整运行事实，但必须导出稳定、最小的 Planner-safe projection：

```ts
type RoutingCapabilityId =
  | 'workspace-engineering'
  | 'current-web-research';

interface PlannerExecutorProfile {
  name: string;
  routingCapabilities: RoutingCapabilityId[];
  primaryUseCases: string[];
  avoidUseCases: string[];
}
```

本轮 profile：

```ts
const codexCli: PlannerExecutorProfile = {
  name: 'codex-cli',
  routingCapabilities: ['workspace-engineering'],
  primaryUseCases: ['代码库实现、测试、工程文档与本地产物'],
  avoidUseCases: ['需要当前公开网页证据的研究'],
};

const piAgent: PlannerExecutorProfile = {
  name: 'pi-agent',
  routingCapabilities: ['current-web-research'],
  primaryUseCases: ['当前公开网络研究、来源核验与引用交接'],
  avoidUseCases: ['本地代码库修改、测试与工程产物生成'],
};
```

Planner 的启动上下文只读取该静态投影；不得看到凭据、具体命令、环境变量、完整 Skill 内容、实时 WorkUnit 状态或 capacity。近期执行结果与 AgentClass 健康状态不属于静态能力事实，按 ADR-0017 通过独立的 Kernel Executor Status Projection 查询提供受限摘要。PolicyKernel 使用同次静态快照和同一注册表，不重新从数据库或 MCP 获得另一份能力事实。

## 覆盖与拆分规则

Planner 为每个任务或候选 Subtask 输出受控的 `requiredCapabilities`。Kernel 判定：

```text
subtask.requiredCapabilities ⊆ candidate.routingCapabilities
  => 该 candidate 有资格执行 subtask

存在一个 candidate 覆盖顶层任务全部 requiredCapabilities
  => 默认单 Executor、单 Subtask
```

没有单一 candidate 覆盖并集时，Planner 才按不可替代能力安排交接。Planner 不能因为“实现、文档、PDF、验证”是不同步骤而拆分；这些步骤若都落在 `workspace-engineering` 内，就是一个 `codex-cli` Subtask。

用户指定多个 Executor 或独立实例不构成能力词条。本轮 Kernel 尚不能保证数量/实例语义，Planner 必须 clarification，而不是增加例外路由规则。

## 本轮路由示例

| 用户目标 | 需求能力 | 正确计划 |
| --- | --- | --- |
| 修改代码、补测试、更新文档、生成普通本地 PDF 并验证 | `workspace-engineering` | 1 个 `codex-cli` Subtask |
| 调研最新公开信息并输出带引用报告 | `current-web-research` | 1 个 `pi-agent` Subtask |
| 调研最新公开信息，再修改代码库 | 两项能力 | `pi-agent` 交接给 `codex-cli`，前提是没有单一候选覆盖并集 |
| 将实现、文档、PDF、验证拆成四个 `codex-cli` Subtask | 仍只有 `workspace-engineering` | 拒绝并 repair 为 1 个 Subtask |

## 实施债务与验收

- [ ] 在 `src/executor/` 定义受控 `RoutingCapabilityId` 注册表、契约和证据要求。
- [ ] 用版本化内置目录替换按默认 Executor 名称生成通用 profile 的 Seeder 行为。
- [ ] 为 `codex-cli` 与 `pi-agent` 声明 canonical profile，并校验 profile、Adapter binding 和工具/probe 证据一致。
- [ ] 导出稳定排序的 Planner-safe snapshot；Planner 和 Kernel 消费同一次快照。
- [ ] 删除 Planner MCP 的静态能力查询入口。
- [ ] 按 ADR-0017 提供独立的 Planner-safe Kernel Executor Status Projection 查询，不将其混入静态能力目录。
- [ ] 将 v3 `requiredCapabilities`、Planner repair 与 PolicyKernel 覆盖校验接入注册表。
- [ ] 证明单 Executor 连续工程任务只调用一次；只有能力并集无单一覆盖者时才出现 `pi-agent → codex-cli` 交接。
- [ ] 证明未注册 capability、候选不覆盖 capability、或 profile/Adapter 不一致时 fail closed。

## 非目标

- 不构建覆盖所有 CLI、MCP、文件格式和模型技巧的百科式能力库。
- 不要求 Planner 预测 Executor 的逐工具调用序列。
- 不把 `strengths`、模型偏好、成功率或成本伪装为硬能力。
- 不在本轮设计或注册第三 Executor。
- 不实现 capability 蕴含、模糊匹配、自动 ontology 学习或动态成本路由。
