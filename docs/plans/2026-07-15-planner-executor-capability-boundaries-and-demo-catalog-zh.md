# Planner 执行器能力边界与三执行器示例目录改造计划

## 计划状态

- **当前状态**：规划完成，尚未开始实施
- **计划日期**：2026-07-15
- **目标完成日期**：待实施排期确定
- **完成日期**：未完成
- **实现提交**：未产生
- **验证状态**：仅完成代码与架构现状审查，尚未运行实现后验证

### 完成后必须回填

计划完成时必须在本节补充：实际交付的 Planner 行为、最终三个 Executor AgentClass、能力包与运行依赖、Schema 版本、数据库迁移、验证命令及结果、实现与收尾提交。计划文档未更新前，不得将本计划标记为“已完成”。

## 背景与问题定义

当前 Planner 已拥有工作图和 AgentClass 选择权，但缺少可执行的任务拆分原则。它容易把“计算、写代码、写文档、生成 PDF、验证”等执行步骤直接映射成串行 Subtask，即使这些步骤可以由同一个 Executor 在一次调用中端到端完成。

现有 Runtime 又会逐个执行 Subtask。每次调用虽然把 `readySubtask.goal` 作为 `userPrompt`，却复用包含顶层 Task 目标的 `ExecutionContextBundle`。Executor 因而同时看到“完整顶层目标”和“当前 Subtask 指令”，没有明确的范围优先级，容易在每个 Subtask 中重复完成整个任务。

Executor 目录也尚不足以支撑能力驱动拆分：

- `src/executor/agent-class-seeder.ts` 只 seed `planner` 和当前默认 Executor。
- 默认 Executor 无论实际名称是什么，都会获得同一份通用 coding profile；若默认值是 `pi-agent`，也会被错误描述成代码执行器。
- 内置 Adapter 已支持 `codex-cli`、`claude-code`、`hermes-agent`、`pi-agent`、`deepseek-tui`、`openclaw`，但 Adapter 存在不等于 AgentClass 已注册，也不等于已经具备真实、有区分度且经过验证的能力。
- `pi-agent` 已有 web search/web fetch 扩展和研究型 system prompt，可形成真实的研究能力边界；其余多数 Adapter 目前主要是不同 CLI 的启动参数封装。
- AgentClass 启动 seed 只插入缺失记录，不覆盖已有记录。仅修改 seed 里的 `codex-cli` 能力描述，不会自动升级已有数据库中的旧 profile。

本计划同时处理两个大方向：

1. 让 Planner 以 Executor 能力边界而不是执行步骤作为 Subtask 粒度，并增加结构校验和执行范围防线。
2. 建立可维护、可升级的 Executor 能力目录，形成三个真正有区分度的示例 Executor，而不是只注册三个不同名称。

## 核心结论

### 1. Subtask 是 Executor 边界，不是步骤清单

默认规则为“最少调用、最少 Subtask”：

- 一个 AgentClass 能端到端完成整个目标时，必须生成一个完整 Subtask，并使用 `single_executor`。
- 编码、测试、文档、格式转换、产物验证等若属于同一个 Executor 的连续工作，不得仅因步骤不同而拆分。
- 只有任务所需能力无法被一个 AgentClass 完整覆盖时，才按能力交接边界拆成多个 Subtask。
- 用户明确要求多次 Executor 调用时可以例外拆分，但必须在 Plan 中显式记录该例外，不能由 Planner 自行假设。
- 用户若明确要求真正并行或多个独立实例，第一阶段不能假装已经支持；当前调度仍是串行的，应澄清或明确说明串行限制。真正并行 WorkUnit 与 worktree 隔离不属于本计划第一阶段。

### 2. 静态能力启动注入，实时状态仍由 Runtime 管理

Executor AgentClass 的静态能力是 Planner 每次规划可执行工作的基础事实，应在 `PlanningAgent.plan()` 的启动上下文中直接提供，不再要求 Planner 调用 `list_executor_classes` 才能获得。

静态能力与实时状态必须继续分离：

- 启动上下文：AgentClass 名称、domains、capabilities、输入/输出类型、strengths、weaknesses、主要/避免用例、skills、MCP、plugins、风险等级，以及是否具有已注册 Runtime Adapter 等静态事实。
- Runtime：WorkUnit 的 idle/claimed/running/failed、探测结果、heartbeat、capacity 和 claim 状态。
- Planner 不根据静态 `availability` 猜测健康度；Runtime 继续按获批候选顺序探测和回退。

`list_executor_classes` 当前把静态能力和实时 WorkUnit capacity 混在一个 MCP 结果中。实施时应删除该 Planner 工具，而不是保留两份能力来源。未来若确有容量感知规划需求，应另行设计只返回实时摘要的工具，并单独评审其必要性。

### 3. 结构校验与能力授权分层

纯结构校验器只负责无需外部事实即可判断的不变量；PolicyKernel 使用受信任的 AgentClass 目录执行能力覆盖校验。不要让 Schema validator 读取数据库，也不要让 Planner 自己成为能力规则的唯一执行者。

### 4. 能力目录是一个深模块

不要继续在 Seeder、Planner prompt、MCP SQL、命令格式化和测试 fixture 中分别维护能力字段。新增一个静态 AgentClass 目录模块作为唯一内置定义来源，隐藏以下实现复杂度：

- 内置 profile 定义与版本。
- Planner-safe 能力视图投影。
- 内置 profile 升级与用户自定义保护。
- Adapter 注册名与 AgentClass 名一致性检查。
- 三个 demo Executor 的能力包元数据。

建议 seam 位于 `src/executor/`，例如 `built-in-agent-class-catalog.ts`；具体文件名可在实施时调整，但不应把新的业务路由层放回 `src/core/` 或 `src/session/`。

## 建议的目标契约

### PlanningAgentPlan 版本

建议将本次工作图契约升级为 `PlanningAgentPlan v3`，不在仍标记为 v2 的结构中静默加入新的必填语义字段。原因是本次不是提示词微调，而是改变了 `single_executor`、`multi_executor` 和 Subtask 的可执行含义。

建议新增或收紧以下结构：

```ts
interface WorkGraphDecomposition {
  basis:
    | 'single_executor_capable'
    | 'capability_boundary'
    | 'user_requested_multiple_executors';
  userRequestedExecutorCount: number | null;
  reason: string;
}

interface SubtaskProposal {
  // 现有字段保留
  requiredCapabilities: string[];
  agentClassHint: string; // 不再允许 executable subtask 的主执行器为空
  candidateAgentClasses: string[]; // 第一项为主执行器，其余为获批回退链
}

interface WorkGraphProposal {
  reason: string;
  decomposition: WorkGraphDecomposition;
  subtasks: SubtaskProposal[];
}
```

`execution.selectedExecutor` 与每个 Subtask 的 `agentClassHint` 目前存在信息重复。第一轮为控制迁移范围可以保留，但必须增加一致性校验：单 Executor 计划中二者相同；多 Executor 计划中 plan-level `selectedExecutor` 只能表示首个/协调用主候选，不能被 Runtime 当作所有 Subtask 的执行器。后续可在独立改造中删除该冗余字段。

### 结构校验规则

`validatePlanningAgentPlan` 应新增以下确定性规则：

- `single_executor` 必须恰好包含一个 Subtask。
- `single_executor` 的 decomposition basis 必须是 `single_executor_capable`。
- `multi_executor` 必须至少包含两个 Subtask。
- `multi_executor` 的 basis 只能是 `capability_boundary` 或 `user_requested_multiple_executors`。
- `user_requested_multiple_executors` 必须包含大于等于 2 的 `userRequestedExecutorCount`；其他 basis 必须为 `null`。
- 每个可执行 Subtask 必须有非空 `requiredCapabilities`、非空 `agentClassHint` 和非空 `candidateAgentClasses`。
- `candidateAgentClasses[0]` 必须等于 `agentClassHint`，以固定主选与回退顺序。
- 现有唯一 ID、依赖引用、无环、枚举和 priority 规则继续保留。

### PolicyKernel 能力校验规则

PolicyKernel 使用 `RuntimeSnapshot.agentClasses` 执行目录感知的确定性授权：

- 所有主选和候选名称都必须是已注册的 executor AgentClass。
- 每个候选 AgentClass 必须覆盖该 Subtask 的全部 `requiredCapabilities`；不能只因名称存在就保留为候选。
- `capability_boundary` 计划中，如果目录里存在一个 AgentClass 能覆盖所有 Subtask 的能力并集，则拒绝该过度拆分计划并触发 Planner repair/clarification，而不是让 Runtime 自动合并自然语言 goal。
- `user_requested_multiple_executors` 是唯一允许“同一 AgentClass 可覆盖全部任务但仍保留多个 Subtask”的例外。
- Kernel 只验证和重写候选，不创建 Subtask、不读写存储、不 claim WorkUnit。

能力标签必须使用受控词汇，而不是 Planner 临时发明的自然语言短语。第一轮可由内置目录导出合法 capability 集合；若后续需要层级能力或蕴含关系，再单独引入 capability taxonomy，暂不做模糊匹配。

## Planner 侧改动范围

### A. 启动上下文注入 ExecutorClasses

预计修改：

- `src/planning/planning-types.ts`
  - 为 `PlanningContext` 增加只读、Planner-safe 的 `executorClasses` 快照。
  - 不直接暴露数据库行、runtime command、环境变量或实时 WorkUnit 状态。
- `src/planning/planning-context-builder.ts`
  - 通过依赖注入接收静态 AgentClass 目录视图；Builder 不自行打开数据库。
  - 对顺序和字段做稳定化，保证 prompt 与测试可复现。
- `src/session/metaclaw-session.ts`
  - 在每次 `PlanningAgent.plan()` 前，从 `AgentClassService` 获取 executor 静态目录并交给 Builder。
  - Planner 与 PolicyKernel 应读取同一次目录快照，避免规划和授权之间看到不同 catalog。
- `src/planning/codex-planning-agent.ts`
  - 在启动 prompt 中明确序列化 `executorClasses`。
  - 删除“规划可执行工作时调用 list_executor_classes”的工具规则。
- `docker/codex-config/planner/skills/metaclaw-planner/SKILL.md`
  - 写入 Executor 级拆分规则、最少 Subtask 原则、用户多 Executor 例外和串行限制。
  - 明确静态能力已经在启动上下文中，禁止为此查询 MCP。

### B. 移除 Planner MCP 中的能力目录

预计修改：

- `src/planning/planner-mcp-server.ts`
  - 删除 `list_executor_classes` 注册和静态能力 SQL。
  - 保留任务、会话和运行时只读工具。
- `tests/planning/planner-mcp-server.test.ts`
  - 删除/改写能力目录工具测试。
- `scripts/smoke-planner-mcp.mjs`、`scripts/smoke-planner-codex.mjs`
  - 更新工具数量、工具调用预期和启动上下文断言。
- Docker/README/技术概览/ADR
  - 将“五个 Planner MCP 工具”更新为四个。

如实施中发现 `get_runtime_state` 依赖 Executor capacity，应只保留聚合实时状态，不返回静态 capabilities、strengths 或 tools；这不是静态目录的第二入口。

### C. Planner 提示与 repair

`CodexPlanningAgent.buildPrompt` 和 Planner Skill 应同时表达同一组规则，但职责不同：

- host prompt 放不可违反的输出契约与安全规则；
- Skill 放拆分方法、能力比较过程和示例。

Planner 在产生工作图前应执行以下思考顺序：

1. 从启动上下文读取全部 Executor AgentClass。
2. 求整个用户目标所需的能力集合。
3. 判断是否存在一个 Executor 能覆盖全部能力。
4. 若存在，产生一个完整 Subtask；验证属于该 Subtask 内部 acceptance，而不是额外 Executor 调用。
5. 若不存在，按最小能力交接集合拆分；每个 Subtask 只对应一个主 AgentClass，并列出 required capabilities。
6. 只有检测到用户明确要求多 Executor 调用时，使用例外 basis。

repair prompt 必须包含具体结构/能力错误，使 Planner 能把 4 个同类 Subtask 合并成 1 个，而不是只修字段。

## Executor 执行防线

当前 `SubtaskExecutionSpec` 已包含 `subtask`、`acceptance` 和 `expectedOutput`，但 `ExecutionRuntime.run()` 只把原 `executorInput` 传给 Adapter，未将这些 spec 字段构造成 Executor 可见范围。这是需要补齐的 seam。

建议新增一个集中式执行输入构造模块，例如 `SubtaskExecutionContextBuilder`：

- 输入：顶层 Task、当前 Subtask、同一工作图的 sibling 摘要、已完成 dependency 结果、AgentClass、acceptance、expectedOutput 和原 `ExecutionContextBundle`。
- 输出：每次 Executor 调用专用的 `ExecutorInput` 或扩展后的 context bundle。
- 顶层 Task goal 标记为“背景与最终整体目标”，不得作为当前调用的直接执行范围。
- 当前 Subtask goal 标记为“本次唯一执行范围”。
- 注入明确的 in-scope、out-of-scope、acceptance、expected output 和依赖交接信息。
- 禁止当前 Executor 主动完成尚未调度的 sibling Subtask。
- 单 Subtask 计划仍只注入一次完整目标，不产生额外范围噪声。

预计修改：

- `src/session/session-execution-coordinator.ts`
  - 在每次 dispatch 前为当前 Subtask 构建专用 context，而不是原样复用顶层 bundle。
  - dependency 输出只注入必要摘要；不要重复注入所有历史 Executor 最终结果。
- `src/execution/execution-runtime.ts`
  - 让 `SubtaskExecutionSpec` 真正参与 Executor input 构建或把构造职责放到上游后收紧接口。
- `src/executor/prompt-builder.ts`
  - 明确显示“顶层背景 / 当前执行范围 / 不在本次范围 / 验收 / 预期输出”。
  - 保证当前范围的视觉和语义优先级高于顶层 goal。
- `src/core/types.ts`
  - 如需扩展 `ExecutionContextBundle`，新增结构化 `currentSubtaskContext`，不要使用自由文本数组承载核心边界。

平台后验验证继续由 `VerificationAndDeliveryService` 执行，但 Planner 不应为了“验证”默认新增另一次 Executor 调用。Executor 在同一次执行中完成能力范围内的测试、文件检查和产物验证，平台只做轻量确定性后验检查。只有独立审查能力确实属于另一个 AgentClass，或用户明确要求第二执行器复核时，才产生 verification Subtask。

## Executor 能力目录与三个 Demo Executor

### A. 重构 Seeder 为内置目录同步器

`agent-class-seeder.ts` 应停止根据 `defaultExecutorName` 生成一份通用 profile。建议拆分为：

- `built-in-agent-class-catalog.ts`
  - 定义 `planner` 和每个内置 Executor 的规范 profile。
  - 提供 `listBuiltInAgentClasses()`、`findBuiltInAgentClass(name)` 和 Planner-safe projection。
- `agent-class-seeder.ts`
  - 只负责将缺失或可安全升级的内置定义同步到存储。
- `agent-class-service.ts`
  - 提供稳定的 `listPlannerVisibleExecutorClasses()` 接口。

AgentClass 名称必须与 `ExecutorAdapterRegistry` 注册名一致。新增一个启动期或测试期一致性检查：目录中声明为内置可执行的 AgentClass 必须有 Adapter binding；Adapter registry 中面向 demo 的内置 Executor 也必须有能力 profile。

### B. 内置定义升级与用户自定义保护

现有“只插入缺失记录”策略会让旧 `codex-cli` profile 永远停留在通用表。不能简单改成每次无条件 upsert，否则会覆盖 `/executor register` 或管理员定制。

建议为 AgentClass 增加来源与定义版本，例如：

```ts
managedBy: 'builtin' | 'user' | 'migration';
definitionVersion: number | null;
```

数据库迁移策略：

- 新增内置 profile 写入 `managedBy=builtin` 和明确版本。
- 已有记录若与旧版本内置默认值完全一致，可安全升级为新版本。
- 已有记录若关键能力或 runtime 配置已被修改，则标记为 user/migration 并保留，不自动覆盖。
- 管理命令修改内置 profile 时，应产生显式 override 语义，而不是下次启动静默还原。
- Planner 只看到最终有效目录，不需要理解迁移细节。

如果不希望本轮增加数据库列，最低限度也必须实现“旧默认 profile 指纹匹配后升级、非默认记录保留”的一次性迁移；但长期推荐显式 provenance/version，避免把脆弱的对象比较变成永久机制。

### C. 三个 Demo 的能力分布

#### 1. `codex-cli`：代码库工程 Executor

定位：本地代码库理解、修改、测试、调试、重构、代码审查，以及同一工程上下文内的相关文档和产物生成。

应明确：

- capabilities：repo inspection、coding、tests、debugging、refactor、code review、local artifact generation、noninteractive execution。
- 可以在一次调用内完成“实现 + 测试 + README/设计文档 + 本地产物验证”。
- 不因为任务同时包含代码、文档和 PDF 就自动拆分。
- avoid：需要实时公开网络研究、专用企业系统写入、独立第二方审查。

#### 2. `pi-agent`：公开网络研究 Executor

定位：需要当前信息、公开网页搜索、URL 抓取、来源核验和带引用研究报告的工作。

已有基础：`PiAgentAdapter` 已生成 `web_search` / `web_fetch` 扩展，并带研究型 system prompt。实施时应补充：

- 真实安装与版本锁定。
- 网络、代理和 curl 依赖。
- 来源质量、失败降级和引用验收。
- 限制其能力描述，不把“具有 bash/read/write”夸大成与 Codex 完全等价的代码工程能力。
- 针对时效性研究的端到端 smoke。

#### 3. 第三个 Executor：先做能力包设计门，再确定实现

第三个 demo 不应只选另一个通用 coding CLI，因为这无法验证能力驱动拆分。目标应与前两者形成明显正交能力，优先评估以下方向：

1. **外部系统/工作流执行型**：基于 `openclaw` 或其他可非交互运行的 Agent，配置明确的 plugins/MCP/凭据边界，用于企业系统操作、跨应用工作流或通知交付。
2. **结构化文档与办公产物型**：配置专用 document/PDF/spreadsheet/presentation Skills 与必要工具，用于高质量办公产物生成和格式验证。

选择门槛：

- 能力必须来自真实安装的工具、Skill、Plugin 或 MCP，不是只写在 `capabilities` 数组里。
- 与 Codex 工程能力、Pi 公网研究能力有清晰的主要用例和 avoid 用例差异。
- 具有非交互命令、availability probe、超时/中止、权限和凭据方案。
- 能在 Docker 运行镜像或受支持的本地环境中稳定安装。
- 至少有一个必须拆成跨 Executor Subtask 的 demo 场景，以及一个应保持单 Executor 的反例。

当前不建议把 `hermes-agent`、`claude-code` 或 `deepseek-tui` 仅因模型/CLI 不同直接作为第三个 demo；它们目前的代码只证明 Adapter 能启动，尚未证明能力边界不同。若后续能力包调研能证明其中之一具备独特工具链，可以重新进入候选。

### D. 三 Executor 场景验收

至少准备以下规划场景：

| 场景 | 预期计划 |
|---|---|
| 修改代码、补测试、更新文档、生成本地 PDF 并验证 | 1 个 `codex-cli` Subtask |
| 调研最新产品信息并形成带来源 Markdown 报告 | 1 个 `pi-agent` Subtask |
| 先做最新公开研究，再在代码库实现结果 | `pi-agent` → `codex-cli` 两个能力边界 Subtask |
| 代码实现后写入专用外部系统 | `codex-cli` → 第三个 Executor |
| 用户明确要求两个独立 Executor 交叉审查同一结论 | 多 Executor 例外；记录用户要求，当前串行执行 |
| Planner 把实现、文档、PDF、验证拆成四个 `codex-cli` Subtask | 结构/Kernel 拒绝并 repair 为一个 Subtask |

## 分阶段实施顺序

### Phase 0：契约与第三 Executor 能力设计

- 确认 PlanningAgentPlan v3 字段与 capability 受控词汇。
- 确认“用户要求多个 Executor”在第一阶段表示多次串行调用，不承诺并行。
- 对第三 Executor 的两条方向做最小可运行 spike，记录工具、权限、安装体积、非交互支持和 smoke 结果。
- 写一份 ADR，记录静态目录启动注入、MCP 工具删除、Executor 级拆分和内置目录版本策略；该 ADR 修订 ADR-0015 的相关决定。

### Phase 1：静态能力目录与持久化升级

- 建立内置 AgentClass 目录模块。
- 增加 provenance/version 迁移或安全指纹升级机制。
- 定义 `codex-cli` 与 `pi-agent` 的真实 profile；第三 Executor 通过设计门后再加入。
- 增加 Adapter registry 与内置 profile 一致性测试。
- 保持 Executor WorkUnit 按需创建，不 seed 虚假 idle capacity。

### Phase 2：Planner 启动上下文与 MCP 收缩

- 向 PlanningContext 注入 Planner-safe executor capability snapshot。
- 保证 Planner 与 Kernel 使用同一次目录快照。
- 删除 `list_executor_classes` MCP 工具、相关 SQL、Skill 规则和 smoke 预期。
- 更新 Planner prompt 与 Skill 的最少 Subtask 算法。

### Phase 3：Plan v3、结构校验与 Kernel 能力授权

- 更新 types、Zod output schema、默认值应用、validator 和 repair。
- 实现 mode/count/decomposition/requiredCapabilities 结构不变量。
- 实现 Kernel 的候选能力覆盖和可合并工作图拒绝规则。
- 更新全部 fixture，不支持 v2/v3 双读；失败继续 fail-closed。

### Phase 4：每 Subtask 执行范围防线

- 建立集中式 Subtask execution context builder。
- 将 acceptance、expectedOutput、dependency handoff 和 sibling out-of-scope 注入每次 Executor 调用。
- 调整 prompt 分层，顶层目标只作为背景。
- 保证单 Subtask 路径仅一次调用、一次最终 Executor 结果、一次平台完成汇报。

### Phase 5：三 Executor 运行能力与 Demo

- 安装/锁定三个 Executor 的 Runtime 依赖。
- 配置第三 Executor 所需 Skills/Plugins/MCP 与凭据边界。
- 增加 availability probe、失败回退和容器 smoke。
- 添加能力驱动拆分与不过度拆分的真实 Planner 场景。

### Phase 6：文档、ADR 与收尾

- 更新 `CONTEXT.md`、`docs/current/technical-overview.md`、中文技术概览、README 和 Docker 说明。
- 更新 ADR-0015 的工具数量与静态上下文决定，或由新 ADR 明确 supersede 对应段落。
- 回填本计划开头的完成日期、实际行为、验证结果和 commits。

## 重点测试范围

### Planner 与 Schema

- `tests/planning/planning-context-builder.test.ts`
  - executorClasses 启动注入、稳定排序、字段最小化、无实时容量泄漏。
- `tests/planning/codex-planning-agent.test.ts`
  - prompt 包含完整静态能力目录。
  - 单 Executor 能覆盖时生成一个 Subtask。
  - 无单 Executor 覆盖时按能力拆分。
  - 用户明确多 Executor 例外。
  - repair 能把过度拆分合并。
- `tests/planning/planning-agent-plan-schema.test.ts`
  - v3 默认值和 JSON Schema 镜像。
- `tests/planning/planning-agent-plan-validator.test.ts`
  - mode/count/decomposition、主候选顺序、requiredCapabilities、依赖 DAG。

### PolicyKernel

- 候选不存在、类型不是 executor、能力不覆盖时拒绝或过滤。
- capability-boundary 图可被单一 AgentClass 覆盖时拒绝。
- 不可由单一 AgentClass 覆盖时接受。
- 用户多 Executor 例外仅在结构证据完整时接受。
- Kernel 保持纯函数，不访问 repo 或 Adapter。

### Executor 目录与 Runtime

- `tests/executor/agent-class-service.test.ts`
  - 三个内置 profile seed。
  - 旧默认 profile 安全升级。
  - 用户定制不被覆盖。
  - 不 seed executor WorkUnit。
- `tests/execution/execution-runtime.test.ts`
  - 三个 profile 均能解析到对应 Adapter。
  - 未安装时 availability probe 失败并按获批链回退。
- 容器测试
  - 三个 CLI/工具链真实存在。
  - Pi web tools 和第三 Executor 能力包真实可用。

### 执行范围与会话

- `tests/executor/prompt-builder-context-layering.test.ts`
  - 当前 Subtask 范围优先于顶层目标。
  - sibling 明确 out-of-scope。
  - acceptance、expectedOutput 与 dependency handoff 可见。
- `tests/session/planner-work-unit-bugfix.test.ts`
  - 单 Executor 计划只 claim/execute/release 一次。
  - 多 Executor 计划每个能力边界只调用一次。
  - 顶层结果不重复聚合。
- 新增针对“Python + docs + PDF + verify”的回归测试，断言一个 `codex-cli` Subtask、一次 Executor 调用和唯一产物集合。

## 验证命令

本地 Windows 只运行不会触发 SQLite native binding 的检查：

```bash
npm run lint
npm run build
```

所有存储、Planner/Kernel 集成和全量测试必须按仓库规范在 Docker 中执行：

```bash
docker build -f Dockerfile.test -t metaclaw-test .
docker run --rm metaclaw-test
```

实现完成后还必须运行：

```bash
npm run smoke:metaclaw
```

以及运行镜像内的 Planner/MCP smoke 和三个 Executor 的代表性真实任务。若第三 Executor 依赖外部凭据，必须提供无凭据的 probe 测试与有凭据的显式可选 smoke，不能让默认 CI 静默访问真实外部系统。

## 风险与控制

### 1. 能力元数据与真实运行能力漂移

控制：内置 profile 与 Adapter/能力包放在同一目录模块管理；每个 capability 至少对应一个可验证工具或行为；增加一致性与 smoke 测试。

### 2. Planner 上下文膨胀

控制：只注入 Planner-safe 静态视图；字段有界、稳定排序，不注入 runtime args、项目 URL、完整 Skill 内容或 WorkUnit 列表。三个 demo 的规模不会造成明显负担，未来大量自定义 Executor 再引入摘要/分页策略。

### 3. 目录更新覆盖用户定制

控制：引入 provenance/version；旧记录只在匹配已知旧默认指纹时自动升级，其他记录保留并显式标记。

### 4. Kernel 误把合法工作流判为可合并

控制：本计划有意采用严格的 Executor 能力边界规则。用户要求多 Executor 是明确例外；并行、权限隔离和独立审查等更多 basis 若未来需要，应通过新增受控枚举和 Runtime 能力实现，而不是自然语言绕过。

### 5. 用户要求多个 Executor，但 Runtime 实际复用一个 WorkUnit

控制：第一阶段文档和 Planner 语义只保证多个串行 Executor 调用，不宣称并行或独立实例。若产品必须保证不同 WorkUnit，应另加 claim exclusion/instance-count 设计与 worktree 隔离，不在本计划中隐式实现。

### 6. v3 迁移面较大

控制：不做 v2/v3 双读，统一更新 Zod Schema、镜像产物、fixture、Planner Skill、repair 和 smoke；失败继续走 clarification，禁止旧规则兜底。

## 明确暂缓

- 真正并行 Subtask 调度和多 worktree 隔离。
- Planner 在 Executor probe 全部失败后自动重规划。
- 基于历史成功率、价格或延迟的动态 Executor 排名。
- 模糊 capability 匹配、能力继承图和自动 ontology 学习。
- 为了凑够三个 demo 而注册没有真实工具差异的 Executor。
- 将实时 WorkUnit 健康状态重新塞进静态 AgentClass capability 表。

## 建议提交拆分

1. `docs: plan executor capability boundaries`
2. `refactor: establish versioned agent class catalog`
3. `feat: inject executor capabilities into planner context`
4. `feat: validate capability-bound work graphs`
5. `fix: isolate executor subtask scope`
6. `feat: add differentiated demo executors`
7. `docs: document capability-driven planning`

