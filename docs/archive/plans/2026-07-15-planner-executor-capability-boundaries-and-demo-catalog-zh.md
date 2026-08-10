# Planner 执行器能力边界与双执行器目录改造计划

## 计划状态

- **计划日期**：2026-07-15
- **修订日期**：2026-07-16
- **当前状态**：已归档；未完成范围由 `2026-07-16-planner-kernel-concurrency-convergence-roadmap.md` 接管
- **本轮 Executor 范围**：`codex-cli` 与 `pi-agent`
- **第三 Executor**：明确暂缓，不是本轮交付、验收或阻塞条件
- **完成日期**：未完成
- **实现提交**：未产生
- **归档日期**：2026-07-16
- **归档原因**：原计划混合能力事实源、工作图、执行范围与并发议题；能力事实源已完成，其余范围已按依赖关系拆入新的总路线图

本轮的目标是先打通 Planner 决策能力与 Executor 能力声明，而不是凑齐三个 demo Executor。第三 Executor 只在双执行器能力模型、目录、Planner、Kernel 和执行范围防线稳定后，作为独立目录扩展示例另行立项。

> 2026-07-16 范围调整：本文件保留为前期整体设计记录。当前只实施 [`2026-07-16-unified-executor-routing-capability-source.md`](2026-07-16-unified-executor-routing-capability-source.md) 中的统一能力定义源；PlanningAgentPlan v3、工作图拆分/合并规则、并行语义和 Executor 执行范围防线全部暂缓，不得混入本轮实现。

计划完成时必须回填：实际 Planner 行为、两个内置 Executor 的能力 profile、Schema 版本、迁移、验证命令及结果、实现与收尾提交。第三 Executor 不在本计划的完成定义内。

## 一、问题与目标

当前 Planner 容易把“实现、文档、PDF、验证”等步骤误当成 Subtask 边界。即使同一个 Executor 能在一次调用内完成，Runtime 仍会进行多次调用，并重复注入顶层目标，造成重复执行、重复产物和重复最终结果。

本轮目标：

1. 让 Subtask 以 Executor 能力交接为边界，而不是以步骤清单为边界。
2. 建立 `codex-cli` 与 `pi-agent` 的同源、受控、可验证 Routing Capability 模型。
3. 将静态 ExecutorClasses 直接注入 Planner 启动上下文；Planner 不再通过 MCP 查询能力目录。
4. 让 Planner validator 与 PolicyKernel 共享工作图结构规则，并由 Kernel 做能力覆盖防线。
5. 让 Executor 明确只执行当前 Subtask，避免重复完成顶层目标。

## 二、能力模型先行

本计划的前置工作是实现 [planner-routing-capability-model-debt.md](../tech-debt/planner-routing-capability-model-debt.md)。它定义唯一的 Routing Capability 注册表、两个 Executor 的 profile、Planner-safe 投影和 Kernel 覆盖判定。

本轮只需证明两个明确边界：

| Executor | Routing Capability | 主要任务 | 不应路由到它的任务 |
| --- | --- | --- | --- |
| `codex-cli` | `workspace-engineering` | 代码库理解、实现、测试、重构、工程文档、普通本地产物与同次验证 | 当前公开网络研究与带来源交付 |
| `pi-agent` | `current-web-research` | 当前公开网页信息、来源核验、引用研究与可消费的研究交接物 | 修改本地代码库、测试、工程产物生成 |

能力词条、最小交付契约和 profile 必须在同一目录模块中定义。Planner 只消费安全投影；Kernel 使用同源注册表和 profile 判断候选是否覆盖 Subtask 需求。能力声明不能是自由文本，也不能只因为某个 CLI 理论上能执行命令就视为可路由能力。

### 必须验证的路由结果

- “Python + docs + 普通 PDF + verify”只需要 `workspace-engineering`，因此是一个 `codex-cli` Subtask 和一次调用。
- “查询当前公开资料并形成带来源研究”只需要 `current-web-research`，因此是一个 `pi-agent` Subtask。
- “查询当前公开资料，再据此修改代码库”需要两个不可替代能力；若没有单一 Executor 覆盖并集，才形成 `pi-agent → codex-cli` 交接。
- 如果未来一个 AgentClass 覆盖这两个能力，Planner 必须重新收敛为单 Executor，而不能保留历史步骤拆分。

## 三、PlanningAgentPlan v3 最小契约

```ts
interface SubtaskProposal {
  // 其他现有字段保持不变
  requiredCapabilities: string[];
  agentClassHint: string;
  candidateAgentClasses: string[];
}
```

- `schemaVersion` 升为 `3`，新 Planner 输出不兼容 v2。
- `requiredCapabilities` 必填；在能力模型实现前唯一合法值是 `[]`，实现后必须使用注册表中的词条。
- 非注册能力词条、未满足的候选能力和空的 hint/candidate 都必须触发 validator repair 或 Kernel 拒绝。
- `candidateAgentClasses` 非空，首项必须等于 `agentClassHint`。
- 不增加 `decomposition`、`basis`、`executionLayer`、workspace partition 或同义字段。
- 历史 v2 决策只读，不迁移、不重新授权；读取新字段时使用安全空值。
- 用户按数量要求多个 Executor 时，Planner 返回 clarification：当前 Kernel 不保证实例数量，询问是否按能力边界使用最少 Executor。

## 四、版本化 AgentClass 目录与启动注入

在 `src/executor/` 建立内置 AgentClass 目录模块，统一维护：

- 受控 Routing Capability 注册表及最小交付契约；
- `codex-cli`、`pi-agent` 的 canonical profile；
- Planner-safe profile projection；
- Adapter binding、一致性验证和实际工具/probe 证据；
- 内置定义版本、已知旧默认值升级与用户自定义保护。

`agent-class-seeder.ts` 只同步目录，不再根据 `defaultExecutorName` 创建通用 coding profile。AgentClass 名称必须和 `ExecutorAdapterRegistry` binding 一致。

每个 PlanningAgent 调用直接接收稳定排序、只读的 ExecutorClasses 快照。Planner 与 PolicyKernel 对同一决策使用同一快照。快照不包含凭据、runtime command、WorkUnit claim、heartbeat、健康度或实时 capacity。

`list_executor_classes` 从 Planner MCP 移除；Runtime 保持 availability probe 和候选回退职责。

## 五、工作图结构防线

新增纯规则模块：输入 Plan，输出稳定排序的结构违规列表。Planner validator 用它触发 repair；PolicyKernel 用同一模块防止绕过。

- `single_executor` 必须恰好一个 Subtask。
- `multi_executor` 必须至少两个 Subtask。
- 保留唯一 ID、依赖引用和无环校验。
- 根据 `dependsOn` 推导最早执行层，不存储显式层级。
- 同一推导层内，两个 Subtask 的首选 AgentClass 不得相同。
- 若 B 只依赖 A、A 也只被 B 依赖、且二者首选 AgentClass 相同，则是可合并无分叉单链，要求 Planner 合并。
- 有分叉或汇合的同 AgentClass 节点不被单链规则误判。

该模块不读取数据库、目录、WorkUnit 或运行状态。能力覆盖是单独的目录感知 Kernel 规则。

## 六、Executor 执行范围防线

新增集中式 Subtask execution context builder：

- 顶层目标仅标记为背景与最终整体目标。
- 当前 Subtask 是本次唯一执行范围。
- 注入 acceptance、expected output、必要 dependency handoff 和 sibling out-of-scope。
- 禁止 Executor 主动完成尚未调度的 sibling。
- dependency 只传必要交接物，不重复注入全部历史最终结果。

预计涉及 `src/session/session-execution-coordinator.ts`、`src/execution/execution-runtime.ts`、`src/executor/prompt-builder.ts`，必要时扩展 `src/core/types.ts` 的结构化当前 Subtask 上下文。

## 七、实施顺序

### Phase 1：Routing Capability 基础

- 实现受控 capability 注册表和最小交付契约。
- 为 `codex-cli` 与 `pi-agent` 定义 canonical Routing Profile。
- 明确 Planner 安全投影、Kernel 覆盖算法和实际工具/probe 证据。
- 补齐双执行器的正例、反例和交接示例。

### Phase 2：版本化目录与 Planner 注入

- 建立内置 AgentClass 目录、definition version/provenance 和安全升级策略。
- 同步 Seeder，校验 profile 与 Adapter binding 一致。
- 注入同一份静态快照给 Planner 和 Kernel。
- 移除 Planner MCP 的 `list_executor_classes` 及关联测试、SQL 和 smoke 预期。

### Phase 3：Plan v3、能力覆盖与工作图结构

- 更新类型、JSON Schema、解析、fixture 和 repair。
- 用注册 capability 验证 `requiredCapabilities`，由 Kernel 验证候选覆盖。
- 实现共享纯结构模块。
- 覆盖单 Executor 收敛、跨能力交接、同层重复、可合并单链、分叉保留、汇合保留和多 Executor clarification。

### Phase 4：执行范围防线

- 建立 Subtask execution context builder。
- 将当前范围、out-of-scope、acceptance、expected output 与 dependency handoff 注入调用。
- 回归验证“Python + docs + PDF + verify”只 claim/execute/release 一次，并产生唯一产物集合。

### Phase 5：文档与收尾

- 更新 `CONTEXT.md`、技术概览、README、Docker 说明和 ADR 关联。
- 回填实际交付、验证结果和提交。

## 八、验收

- 两个内置 Executor 的 Routing Capability 声明来自同一个受控目录，且有对应 Adapter/工具证据。
- Planner 与 Kernel 消费同一次 Planner-safe snapshot；Planner MCP 不再提供静态能力目录。
- v3 `requiredCapabilities` 只能使用注册词条；历史 v2 仍只读。
- 单 Executor 覆盖任务只产生一个 Subtask；只有两个 Executor 的能力并集无法被单一候选覆盖时才交接。
- 同层重复 AgentClass 与可合并无分叉单链被拒绝；分叉与汇合保留。
- 当前 Subtask 范围优先于顶层目标；不会重复执行 sibling 或重复产物。
- Windows 主机运行 `npm run lint` 与 `npm run build`；存储和集成测试在 Docker 中运行。

## 九、明确暂缓

- 第三 Executor、其 AgentClass 名称、profile、Adapter、运行镜像与 Spike；
- capability 蕴含关系、模糊匹配和自动 ontology 学习；
- 真正并行 Subtask、workspace partition 和多 worktree；
- 用户指定 Executor 数量或独立实例保证；
- 基于价格、延迟或历史成功率的动态路由；
- Planner 在全部 probe 失败后自动重规划。
