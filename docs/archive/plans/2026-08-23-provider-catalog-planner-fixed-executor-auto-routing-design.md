# Provider Catalog And Planner/Executor Routing Design

> 本文是 2026-08-23 配置工作台优化的修正版设计。它收敛本期范围，
> 不包含新增 Executor 或 Executor 热插拔。

**Status:** Implemented

**Plan date:** 2026-08-23

**Completion date:** 2026-08-23

**Scope:** 桌面 Web 配置工作台；本期不考虑移动端配置。

## 1. Goals

本期只解决配置页面中的 Provider、模型候选集和 Planner/Executor 路由交互：

- Provider 内加入的模型进入全局候选模型集。
- Planner 只能由用户手动选择一个固定模型，不提供 Auto。
- Codex Executor 支持 Fixed/Auto；Auto 候选跨 Provider，默认匹配 GPT 相关模型。
- Pi Executor 支持 Fixed/Auto；Auto 默认可使用全部 Provider 候选模型。
- Provider 和模型可以在空闲状态下删除，并自动清理候选集。
- 删除 Fixed 当前模型后不自动替换，只提示该 AgentClass 暂无可用模型。
- 配置修复完成后通过“保存并激活”一次性生效。
- 不向用户展示独立的 Model Facts/模型事实配置模块。

## 2. Explicitly Out Of Scope

本期不实现：

- 新增 Executor。
- 删除 Executor。
- 自定义 Harness、Driver、Executor command 或运行时插件。
- Executor 连通性测试。
- Executor 热插拔、类似 Skill 的 Executor package 生命周期。
- 移动端配置界面。
- 用户手工编辑模型能力、context、质量、延迟、成本等 Model Facts。

新增 Executor 后续单独设计为 Agent/Skill 风格的热插拔能力，不在本期修改
AgentClass/Harness 的生命周期边界。

## 3. Product Semantics

### 3.1 Provider catalog is the candidate source

Provider 维护连接信息和模型目录。只有已经加入 Provider 目录的模型才进入全局
candidate model set。模型加入 Provider 后不会自动绑定 Planner 或 Executor；
AgentClass 仍单独决定 Fixed 模型或 Auto 允许集合。

用户侧不配置 Model Facts。运行时仍可以保留内部 `ModelProfile`、能力投影和
Provider/Model binding，因为 Planner、Kernel 和 Runtime 需要这些事实；这些事实
由系统预置、Provider completion 或保守推断生成，不作为设置页一级资源。

### 3.2 Planner is always fixed

Planner 的 `modelPolicy` 必须是：

```text
{ mode: 'fixed', modelRef: string }
```

Planner 页面只允许用户从当前候选模型集中选择一个模型。系统可以展示能力警告，
但不得自动选择、自动替换或在运行时改用其他模型。

### 3.3 Executor policies

Codex Executor 和 Pi Executor 支持：

```text
Fixed: 用户选择一个模型
Auto: 用户从系统筛选出的支持候选中勾选允许路由的模型
```

Auto 运行时仍由 ControlKernel/AutoModelResolver 解析 concrete binding。用户选择
的是允许集合，不是直接授权 Runtime 自行选择。

内置候选规则：

- Codex：跨所有启用 Provider，匹配 GPT 相关模型并满足 coding/tools 基础约束。
- Pi：跨所有启用 Provider，默认展示全部已加入模型。

### 3.4 Delete semantics

删除 Provider 或 Provider 下的模型只修改当前草稿，实际持久化和运行时切换仍通过
一次 activation 完成。

空闲时允许删除，即使该 Provider/Model 被当前 Fixed 或 Auto 配置引用。删除后：

- Auto 候选池自动移除已删除模型。
- Fixed 若引用已删除模型，保留该 Fixed policy 的语义，但标记为“没有可用模型”。
- 不自动替换 Fixed 模型。
- 配置校验失败，“保存并激活”保持不可用，直到用户重新选择有效模型。

有 Planner turn、Task、attempt、dispatch、lease、verification、publication 或
recovery 正在进行时：

- Provider/Model 删除按钮不可用。
- “保存并激活”按钮不可用。
- 后端 activation gate 返回 `409 runtime_busy`。
- 已运行的 generation、attempt 和 receipt 继续使用原 configuration revision。

## 4. Desktop Interaction Design

设置页只保留两个主要区块：

```text
01 Provider 与模型目录
02 Planner / Executor 路由
```

revision 只在“高级诊断”中展示；页面不展示内部 `modelRef`、binding fingerprint
或无意义的运行时 ID。

### 4.1 Provider section

每个 Provider 卡片展示：

- Provider display name。
- Base URL。
- Secret/credential 状态。
- 已加入模型数量。
- 模型目录列表。
- `加入模型`。
- `删除 Provider`。

模型行展示：

```text
Model ID    已加入候选集    移除
```

已知 Provider 使用模型选择下拉框；没有可发现目录的自定义 Provider 才允许手动
填写 Model ID。

### 4.2 Planner section

Planner 卡片不显示 Fixed/Auto 切换，只展示：

```text
Planner
使用模型: [候选模型下拉框]
```

候选模型来自 Provider catalog。选中模型不满足 Planner 基础结构化输出要求时，
展示明确警告；如果 schema 将该能力定义为硬约束，则阻止激活，但不替用户切换。

删除当前 Planner 模型后：

```text
Planner 当前没有可用模型，请重新选择
```

### 4.3 Codex and Pi sections

两者均显示路由模式：

```text
Auto · 运行时智能选择
Fixed · 固定一个模型
```

Fixed 模式显示一个候选模型下拉框。

Auto 模式显示：

- 当前 AgentClass 支持的候选模型。
- Provider 名称。
- 模型 ID。
- 勾选框。
- 系统筛选/排除原因。
- 默认偏好模型。

如果 Auto 候选为空，显示配置错误并禁用激活。

### 4.4 Activation feedback

页面区分三类不能激活原因：

1. `runtime_busy`：当前运行时有任务或执行活动。
2. `invalid_configuration`：例如 Fixed 引用已删除模型或 Auto 候选为空。
3. `revision_conflict`：其他客户端已激活了新配置。

错误信息必须包含 AgentClass 名称和修复动作，例如：

```text
Planner 当前没有可用模型，请重新选择。
Codex Auto 至少需要一个候选模型。
```

## 5. Technical Design

### 5.1 User configuration and internal projection

Provider 作为用户侧模型目录来源。现有内部 `models`/`ModelProfile` 继续存在，
但由 Provider catalog 编译生成或更新，不再由独立 Model Facts UI 直接编辑。

建议的用户语义：

```text
providers[providerRef].catalogModelIds
agentClasses.planner.modelPolicy = fixed
agentClasses.codex-cli.modelPolicy = fixed | auto
agentClasses.pi-agent.modelPolicy = fixed | auto
```

内部 projection 继续提供：

- `providerRef`
- `modelRef`
- `modelId`
- capability tags
- reasoning/quality/latency/context 等运行时事实
- revision-scoped Provider/Model binding

### 5.2 Policy validation

配置编译和 activation validation 必须校验：

- Provider reference 存在且启用。
- Provider 内 Model ID 唯一。
- Planner 存在且 policy 必须为 fixed。
- Planner fixed model 存在于当前候选集。
- Codex/Pi fixed model 存在且被 AgentClass 支持。
- Codex/Pi auto `allowedModelRefs` 非空。
- Auto 的所有 model refs 存在、启用且属于当前支持候选。
- `defaultModelRef` 为空或属于 `allowedModelRefs`。
- 不存在悬空 Fixed 或 Auto 引用。

删除 Provider/Model 后允许草稿暂时不完整，但不允许激活不完整草稿。

### 5.3 Candidate projection

候选生成分三步：

```text
Provider catalog
  -> enabled global candidates
  -> AgentClass system compatibility filter
  -> user Fixed selection or Auto allowed set
```

系统兼容性规则必须是代码拥有的 routing policy，不新增第二套路由器。

Codex 的 GPT 相关判断优先使用预置 Provider/model catalog 元数据和稳定的模型
family classifier；未知自定义模型不因为字符串偶然匹配就自动获得 coding/tools
能力。Pi 默认使用全部候选，但仍受 Provider enabled、Model enabled 和基础运行时
可用性校验约束。

### 5.4 Activation and revision pinning

继续使用现有 `ConfigurationActivationGate`、`ConfigurationRuntimeCoordinator`
和 immutable revision：

1. Web 在本地维护 Provider catalog 和 AgentClass routing draft。
2. 删除动作只修改 draft。
3. 点击“保存并激活”时提交完整配置。
4. 后端重新检查 runtime gate 和 optimistic revision。
5. 校验 Provider catalog、Planner fixed 和 Executor policy。
6. 编译内部 ModelProfile/runtime projections。
7. 原子切换 active configuration revision。
8. 新 Planner turn、新 generation 和新 attempt 使用新 revision。

旧 generation、旧 attempt、retry、fallback、recovery 和 receipt 不切换 revision。

### 5.5 API contract

本期优先保留统一 draft activation API，避免 Provider/Model 删除产生半完成的
持久化状态：

```text
GET  /api/config
GET  /api/config/activation-status
POST /api/config/activate
```

`POST /api/config/activate` 失败时返回：

```text
runtime_busy
invalid_configuration
revision_conflict
```

Provider/Model 的新增、移除和路由修改由 Web 草稿完成；后端只在 activation
事务中持久化完整配置。后续若需要多人协作，再单独引入草稿资源 API。

## 6. Testing Plan

### 6.1 Unit and integration tests

- Planner schema 拒绝 Auto policy。
- Planner 只能选择一个有效候选模型。
- Codex 跨 Provider 选择 GPT 相关候选。
- Pi 展示全部 Provider 候选。
- Auto 只在用户勾选集合中解析。
- 删除 Provider 自动清理 Auto refs。
- 删除 Fixed 当前模型不会自动替换。
- Fixed 引用删除模型时 activation 返回 `invalid_configuration`。
- Auto 候选为空时 activation 返回 `invalid_configuration`。
- 空闲时删除 Provider/Model 允许进入 draft。
- 运行时 busy 时删除和 activation 返回 `runtime_busy`。
- 新 revision 只影响新 turn/generation/attempt。
- 历史 generation 保持原 concrete binding。

### 6.2 Desktop browser E2E

覆盖：

1. Provider 加入模型。
2. Planner 手动选择模型。
3. Codex 展示跨 Provider GPT 候选。
4. Pi 展示全部候选。
5. Codex/Pi 设置 Auto 候选池。
6. 删除 Provider。
7. 验证 Auto 候选自动清理。
8. 验证 Fixed 显示没有可用模型。
9. 验证激活按钮因配置不完整而禁用。
10. 重新选择 Fixed 模型。
11. 保存并激活成功。
12. 运行任务时删除和保存并激活均禁用。

## 7. Acceptance Criteria

- 设置页没有独立 Model Facts 配置模块。
- Provider 内加入的模型才进入候选集。
- Planner 没有 Auto，只能手动选择 Fixed 模型。
- Codex 不再绑定 Code CLI Provider，能够跨 Provider 选择 GPT 相关模型。
- Pi 能够跨 Provider 选择全部候选模型。
- Provider/Model 删除不会留下 Auto 悬空引用。
- Fixed 模型被删除时不自动替换，只提示没有可用模型并要求重新选择。
- 配置不完整时不能激活。
- 运行中不能删除 Provider/Model，保存并激活按钮不可点击。
- 历史运行继续使用原 revision 和 concrete binding。
- 本期不新增 Executor，不引入 Executor 热插拔或连通性测试。

## 8. Implementation Closure

已交付 Provider-first 配置工作台、Planner fixed-only、Codex/Pi Fixed/Auto
路由、跨 Provider Codex GPT 候选投影、Provider/Model 删除级联、Fixed 删除
后的显式修复提示，以及 idle/busy/invalid activation 契约。新增 Executor、
Executor 连通性测试和 Skill-style Executor 热插拔仍按范围留待后续设计。

验证结果：

- `npm run lint` 通过。
- `npm run build` 通过。
- `cd web && npm run build` 通过。
- `npm test`：323 个测试文件通过，5 个跳过；1458 个测试通过，16 个跳过。
- `RUN_BROWSER_E2E=1 npm test -- tests/e2e/settings-workbench-browser.test.ts`：
  1 个浏览器 E2E 通过。
- `git diff --check` 通过。
