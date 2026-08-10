# Phase 1：工作图语义收敛总体行动计划

## 计划状态

- **计划日期**：2026-07-16
- **当前状态**：已完成并归档
- **所属路线图**：[`2026-07-16-planner-kernel-concurrency-convergence-roadmap.md`](../../plans/2026-07-16-planner-kernel-concurrency-convergence-roadmap.md)
- **对应阶段**：Phase 1——工作图语义收敛
- **完成日期**：2026-07-16
- **实现提交**：本次 Phase 1 收尾提交（见 Git 历史）

### 实际交付与验证

- `PlanningAgentPlan` 已一次性切换到严格 v3；删除顶层 `execution` 和旧 Subtask 路由字段，生产路径只接受受控 capability 与完整有序 canonical AgentClass 清单。
- 新增纯工作图结构规则 seam，Planner validator 与 Kernel 共同消费；Kernel 额外完成静态能力认证、动态健康过滤和 rewrite 后复检。
- migration v21 将 v2 Subtask 整表转为只读审计，新生产表只含 v3 字段；非终态旧图任务停驻等待自然语言 replan。
- Runtime 只应用 Kernel 批准的新图或恢复已有 v3 图；无图及图冲突显式返回不可执行，不再合成 fallback 图；DAG 继续串行消费。
- 构建产物、容器默认路径、Planner skill 和 smoke 均已切换到 `planning-agent-plan-v3.schema.json`。
- 验证通过：`npm run lint`、聚焦 planning/kernel/execution/storage 测试、能力拆分/合并授权测试、`npm run build`、Docker 镜像构建、Docker/Linux 全套测试（176 个文件通过、2 个跳过；776 个测试通过、4 个跳过）及真实 artifact smoke。

本计划只规定 Phase 1 的改动范围、验收标准、实施原则与阶段边界。字段最终形态、规则模块接口、迁移步骤、测试用例组织及逐文件改动清单，留待后续 Plan 模式讨论后补充或形成可执行分解，不在本文预先定案。

计划完成时必须回填：实际交付行为、最终 schema 版本与迁移结果、验证命令及结果、相关文档更新、实现提交和收尾提交。

## 一、阶段目标

让 PlanningAgent 输出的工作图在当前串行 Runtime 中已经具备最终、可靠、可授权的结构语义：Subtask 按受控能力交接形成，而不是按操作步骤罗列；依赖图是节点拆分、合并和执行先后的唯一结构依据；Planner 与 PolicyKernel 对同一组结构规则达成一致；Kernel 使用 canonical capability definitions 完成不可绕过的能力覆盖授权。

Phase 1 完成后，工作图虽然仍然串行执行，但其结构不得依赖未来并发实现再次解释或重写。

## 二、当前代码基线

截至计划日期，当前实现具备以下基础：

- `PlanningAgentPlan` 仍为 schema v2；顶层 `execution` 同时保留 selected/candidate executor summary，`SubtaskProposal` 同时保留 `requiredAgentClassKind`、`agentClassHint` 和 `candidateAgentClasses`，尚无受控的 `requiredCapabilities` 与唯一有序 AgentClass 偏好表达。
- Planner 输出 schema 会为部分 Subtask 字段补默认值；尚未实施一次性的新 schema 切换。
- `validatePlanningAgentPlan` 已校验基本 plan 形状；其内部工作图校验已覆盖非空节点、唯一 ID、依赖存在和 DAG，但尚未覆盖执行模式一致性、派生层规则、同层首选唯一、同 AgentClass 无分叉单链合并和能力覆盖等 Phase 1 语义。
- `PolicyKernel` 会再次调用 plan validator，并会依据持久化 AgentClass 与动态 executor status 过滤候选；它尚未依据 canonical routing capability definitions 校验每个候选对 Subtask 必需能力的完整覆盖。
- canonical executor definitions、Planner-safe catalog、Seeder 投影和 Adapter binding 已经统一，可作为本阶段能力授权的前置事实源。
- `WorkGraphRuntimeService` 会持久化 Kernel 批准的工作图，`SessionExecutionCoordinator` 会按 `dependsOn` 查找下一个 ready Subtask；生产路径当前保持串行。

因此，本阶段不是新增一个依赖字段，而是升级已有工作图契约，并消除 Planner、Kernel、持久化模型和 Runtime 之间的重复路由事实。

## 三、改动范围

### 3.1 纳入范围

本阶段允许且要求触及以下范围：

1. **PlanningAgentPlan 契约升级**
   - 将 plan 硬升级到新的单一 schema 版本。
   - 让每个 Subtask 声明受控 `requiredCapabilities`。
   - 用一个有序的 `preferredAgentClassList` 表达 preferred 与 fallback 顺序。
   - 删除可由工作图或有序偏好派生的旧 hint、candidate 和顶层 executor summary，避免多份路由事实。

2. **纯工作图规则模块**
   - 建立一个小接口、无 I/O、无数据库依赖、无运行时状态依赖的深模块。
   - 统一承载工作图结构不变量，并输出稳定、可测试、可供 repair 使用的违规结果。
   - PlanningAgent validator 与 PolicyKernel 必须跨同一 seam 消费该模块，不能复制规则实现。

3. **Planner 生成与 repair 契约**
   - 更新 Planner 输出约束、提示语义和 repair 判据，使其以能力交接为 Subtask 边界。
   - 保证结构违规在进入 Kernel 前可触发 Planner repair；重复失败仍走现有安全失败路径。

4. **Kernel 能力授权**
   - Kernel 使用 canonical capability definitions 校验受控 capability ID、AgentClass 存在性、偏好顺序合法性及逐候选完整覆盖。
   - 数据库中的自由文本 capability、动态健康度或近期状态不得替代内置静态能力认证；动态状态仍只承担运行时可用性职责。
   - Kernel 必须能拦截绕过 Planner validator 的结构或能力违规计划。

5. **领域模型、持久化与串行消费路径同步切换**
   - 同步升级 Subtask 领域类型、存储投影、仓储读写、工作图恢复、事件审计和测试 fixture，使生产路径只读写新契约。
   - 保持依赖图驱动的串行 ready 选择；本阶段不增加并行 dispatch。
   - 明确历史已完成决策只作为审计记录读取；升级点仍未完成的旧工作图必须重新规划，不通过 optional defaults 或双 validator 继续执行。

6. **验证与文档**
   - 为纯规则、schema/repair、Kernel 授权、持久化迁移和串行 Runtime 集成补充聚焦回归测试。
   - 更新与最终行为不一致的 `CONTEXT.md`、当前技术总览、相关 ADR/文档索引及本计划和总路线图状态。

### 3.2 明确不纳入范围

以下事项属于后续阶段，不得顺带进入 Phase 1：

- Executor 只执行当前 Subtask 的 execution context 与 dependency handoff 改造（Phase 2）。
- 将 capacity、failure、timer、fallback、retry、熔断等策略迁入统一 Kernel 控制面（Phase 3～4）。
- workspace/resource partition、读写冲突、持久租约、worktree 隔离和崩溃清理（Phase 5）。
- runnable frontier 的异步并行调度、跨 Task 公平性、并发结果合并和取消传播（Phase 6）。
- 第三个内置 Executor、新的动态能力发现机制，或把 CLI 理论能力自动提升为 canonical routing capability。
- 为旧新 schema、旧新路由字段或旧新规则保留 feature flag、双写、双读和长期兼容层。
- 与工作图语义收敛无直接关系的 Session、Scheduler、TUI、Gateway 或 Executor Adapter 重构。

## 四、必须遵循的原则

1. **Planner 提案，Kernel 决策，Runtime 执行副作用。** 本阶段不得改变三者职责方向。
2. **单一事实源。** Canonical definitions 是静态 Routing Capability 的唯一事实源；工作图是依赖与执行次序的唯一事实源；有序 AgentClass 列表是 Subtask 路由偏好的唯一事实源。
3. **按能力交接最小拆分。** 单一 AgentClass 能完整完成的无分叉工作不得按实现、文档、产物、验证等步骤拆成多节点；只有不可替代的能力交接才产生新的 Subtask。
4. **共享 seam，不复制规则。** 结构规则应在一个深模块中集中实现，Planner validator 与 Kernel 通过同一小接口获得 leverage 与 locality。
5. **纯规则与环境授权分离。** 图结构判断不得读取目录、数据库、健康度或 capacity；能力覆盖授权可以读取同次决策使用的 canonical 快照，但不得污染纯结构模块。
6. **派生优于存储。** 执行层、runnable 层级、首选 executor summary 等可由 DAG 或偏好列表得出的信息不得再持久化为平行事实。
7. **一次性切换。** 升级时同步修改 Planner、validator、Kernel、Runtime、存储和测试调用方；删除旧字段、旧默认值、旧分支与旧 fixture，不建立过渡协议。
8. **确定性与可审计。** 相同输入必须产生稳定排序的违规与授权结果；Kernel rewrite/reject 原因和持久化事件要足以解释决策。
9. **串行不变量保持。** 在 partition 授权和租约完成前，Runtime 继续一次只执行一个 ready Subtask；不得把同层节点解释为生产并发许可。
10. **计划文档是完成门槛。** 未回填本计划与总路线图的状态、行为、验证和提交前，不得宣告 Phase 1 完成。

## 五、验收标准

### 5.1 契约与唯一事实源

- 生产路径只接受新的 PlanningAgentPlan schema；旧 schema 不可通过默认值、兼容解析或 Kernel rewrite 获得执行授权。
- 每个可执行 Subtask 都有受控、非歧义的必需能力和唯一有序 AgentClass 偏好列表。
- 旧 hint/candidate/顶层 executor summary 不再参与领域决策、持久化或 Runtime 路由。
- Planner 与 Kernel 对一次决策使用同源 canonical capability definitions；数据库自由文本不能伪造内置能力覆盖。

### 5.2 工作图结构规则

共享规则模块至少证明以下行为：

- Subtask ID 唯一，所有依赖均存在，依赖图无环且至少有一个起始节点。
- execution mode 与工作图节点数一致，且执行层只能由 DAG 推导。
- 同一派生层内的首选 AgentClass 不重复。
- 同一 AgentClass 的无分叉、单入单出链必须合并；存在分叉或汇合时不得被该规则误合并。
- 每个候选 AgentClass 都完整覆盖对应 Subtask 的全部 `requiredCapabilities`；未知 capability、未知 AgentClass、空偏好或覆盖不足均不能被授权。
- Planner validator 和 PolicyKernel 对同一结构违规给出一致结论；Planner repair 无法修复时不会落入 Runtime。

### 5.3 用户可见行为场景

- “Python 实现 + 文档 + 普通 PDF + 验证”在单一 `workspace-engineering` 能力可覆盖时收敛为一个 `codex-cli` Subtask 和一次串行执行。
- “查询当前公开资料并形成带来源研究”形成一个 `current-web-research` Subtask，并优先选择覆盖该能力的 AgentClass。
- “先研究当前公开资料，再据此修改代码库”仅在没有单一 AgentClass 覆盖能力并集时形成有依赖的能力交接链。
- 若某一 AgentClass 能覆盖上述能力并集，相同任务必须收敛为单节点，而不是保留历史步骤拆分。
- 直接构造绕过 Planner 的非法 plan 会被 Kernel 拒绝或澄清，且不会创建/恢复可执行 Subtask。

### 5.4 存储与 Runtime

- 新建、恢复和重新规划的工作图只使用新字段；迁移后不存在新旧路由字段双写或双读。
- 已完成历史 planning decision 保持可审计但不会被重新授权；未完成旧图在升级点按明确规则重新规划。
- Runtime 仍按依赖完成情况串行选择 ready Subtask；Phase 1 不改变 active attempt、WorkUnit claim 或并发上限。
- 结构违规不会以“无 ready 节点”的形式静默卡死，而是在 Planner repair 或 Kernel admission 阶段被明确阻止。

### 5.5 验证门槛

至少完成并记录以下验证：

- `npm run lint`
- 聚焦的 planning、kernel、execution 与 storage 回归测试
- `docker build -f Dockerfile.test -t metaclaw-test .`
- `docker run --rm metaclaw-test`
- 覆盖上述能力拆分/合并场景的端到端或等价集成验证

由于本地 Windows 环境不提供 `better-sqlite3`，涉及存储与完整测试套件的验收必须在 Docker/Linux 中完成；不得以宿主机失败或跳过结果代替。

## 六、总体实施分段

后续详细计划应把实现组织为以下四个收敛门，而不是长期并行的新旧路径：

1. **契约门**：确认最终 schema、受控词汇与删除项，冻结 Phase 1 接口。
2. **规则门**：建立纯工作图规则 seam，并让 Planner validator 与 Kernel 对其形成共同测试表面。
3. **切换门**：一次性同步 Planner、Kernel、领域模型、存储与串行 Runtime，移除旧协议。
4. **验收门**：完成迁移、行为场景、Docker 全量验证和文档回填后，才关闭 Phase 1 并激活 Phase 2。

各门内部的具体文件、函数、数据迁移顺序和测试用例矩阵由后续 Plan 模式确定。任何细化方案若突破本文“不纳入范围”或违反全局不变量，必须先修改本计划和总路线图，而不能在实现中隐式扩张范围。

## 七、完成与归档要求

Phase 1 关闭时必须同时完成：

1. 回填本文件开头的完成日期、实际交付、验证结果与实现/收尾提交。
2. 更新总路线图的当前激活阶段、Phase 1 实际行为和验证记录。
3. 更新 `CONTEXT.md` 与当前技术总览，使其只描述新 schema 和唯一生产路径。
4. 对形成长期架构约束的决定补充或修订 ADR。
5. 将本计划移入 `docs/archive/plans/`，并确认 `docs/README.md` 只将下一激活阶段列为 active plan。

## 八、已锁定的详细实施决策

以下决策于 2026-07-16 进入实施，不再留给实现阶段临时选择：

- `PlanningAgentPlan` 升级为严格 v3，删除整个顶层 `execution`、`requiredAgentClassKind`、旧 hint/candidate 字段及失效的 `CapabilityClass` 词汇。
- 每个可执行 Subtask 使用非空 `requiredCapabilities` 和非空 `preferredAgentClassList`；偏好列表必须是所有静态能力覆盖者的完整排序。
- Phase 1 自然语言路由只允许 canonical AgentClass；自定义 AgentClass 保留但不获得受控 Routing Capability 认证。
- 纯工作图规则模块只返回稳定排序的结构化违规，不读取 catalog、数据库或运行状态，也不自动重写工作图。
- 同 AgentClass 单链按局部边判定：A 只指向 B、B 只依赖 A、两者首选相同；A 的上游汇合和 B 的下游分叉不阻止判定。
- Planner validator 使用同次 catalog 对能力覆盖错误提供一次 repair；Kernel 使用同源 catalog 重检并防止绕过。
- Kernel 只对静态合法列表过滤动态 `error`/`disabled`，保留 `unverified`/`healthy` 及顺序；过滤后重新执行结构规则。
- 删除 Runtime `fallbackWorkGraph`；Runtime 只应用 Kernel 批准的新图或恢复已有 v3 图。
- 已有 v3 图不可被 `plan_work_graph` 替换；整图 replan、retry 和 recovery 策略留到 Phase 4。
- migration v21 将旧 `subtasks` 整表转为只读 v2 审计，新建单一 v3 生产表；旧非终态任务停驻，等待用户通过自然语言显式重规划。
- startup、timer 和 slash resume 遇到无 v3 图时不得自动执行或合成默认路由。
- 工作图仍按 DAG 串行消费；dependency result handoff 属于 Phase 2，并发属于 Phase 6。
