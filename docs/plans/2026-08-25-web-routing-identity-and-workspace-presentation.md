# Web 路由身份、执行卡片、轨迹布局与主题优化实施方案

**Status:** Completed。

**Plan date:** 2026-08-25

**Completion date:** 2026-08-25

**Goal:** 修复执行卡片重复和路由信息歧义，确保所有普通用户界面只展示与
用户配置一致的 Provider、Model、Executor 名称；同时让轨迹页专注审计，并为
Web 工作台增加浅色、深色、跟随系统三种主题。

**Architecture:** 保留 `Planner proposes -> ControlKernel decides -> Runtime
applies -> Executor reports facts` 主轴。路由与执行事实仍由 Kernel/Runtime
产生，Management 层依据 Task generation 固定的 configuration revision
生成用户安全 projection，Web 只负责展示。不得在前端重新解释路由、猜测
Subtask 对应关系或读取内部配置文件。

## 1. 已确认问题

### 1.1 路由候选与实际 Executor 容易被误解

当前轨迹中的路由卡片直接展示内部 `providerRef/modelRef`。例如：

```text
code-cli/code-cli-5
```

当前生效配置中，`code-cli-5` 不是 Provider 真实模型名，而是内部
`modelRef`，其实际配置为：

```text
Provider: code-cli
Model ID: gpt-5.6-terra
Capabilities: []
```

Codex AgentClass 同时允许另一个候选 `code-cli-gpt-5-6-sol`，实际
`modelId` 为 `gpt-5.6-sol`，并声明了 `coding` 和 `tools`。因此本次事实是：

- Codex CLI AgentClass 没有被整体拒绝。
- `gpt-5.6-terra` 这个模型候选因未声明 `coding` 能力而未入选。
- 同一个 Codex CLI AgentClass 下的 `gpt-5.6-sol` 候选被选中。
- 最终由 Codex CLI Executor 执行与该路由结果一致。

路由逻辑与当前配置一致，普通 UI 的名称和层级表达存在回归。既有
Provider Catalog 设计已经规定普通 UI 不展示内部 `modelRef` 和 revision。

### 1.2 同一 Subtask 出现两个执行卡片

当前卡片可能同时按 Planner proposal Subtask 标识和 Runtime 持久化
Subtask ID 分组。两个标识代表同一个逻辑 Subtask，但 Web 将它们当成两个
独立 key，形成重复卡片和分裂的事件详情。

### 1.3 轨迹页仍展示输入框

Composer 当前属于整个 Workspace Shell，因此在 Conversation 和 Trajectory
两个 tab 都显示。轨迹页是只读审计视图，不应呈现可输入状态。

### 1.4 页面只有深色主题

当前页面缺少浅色模式和系统主题跟随能力，也没有持久化用户偏好。

### 1.5 内部 Attempt ID 覆盖状态和时间

Execution Narrative 当前直接展示 Kernel 的确定性 `attemptId`，例如：

```text
attempt_dispatch_event_..._primary
```

该 ID 由派发事件、Subtask、绑定指纹和 attempt kind 组成，用于幂等、恢复、
回执关联和审计，不是用户可读名称。由于它是不可断行的长字符串，而 attempt
header 使用三列 Grid，第一列无法正常收缩，最终覆盖内部 `terminal` 状态和耗时。

这里同时存在两个问题：

- 普通界面泄露了没有用户价值的内部关联键。
- UI 直接展示 `terminal` 等内部持久化状态，没有转换为用户状态，且没有为极端
  长文本建立可靠的收缩和溢出规则。

## 2. 用户界面决策

### 2.1 路由卡片的用户可见身份

普通路由卡片按以下层级展示：

```text
Executor: Codex CLI
最终选择: Code CLI / gpt-5.6-sol
未入选模型候选:
  Code CLI / gpt-5.6-terra
  原因: 该模型未声明任务所需的 coding 能力
```

显示规则：

- Provider 使用用户在 Provider Catalog 中看到的显示名称。
- Model 使用用户配置的真实 `modelId`，例如 `gpt-5.6-terra`。
- Executor/AgentClass 使用用户界面的公开显示名称，例如 `Codex CLI`。
- Harness 使用公开显示名称，不显示内部 runtime key。
- “拒绝”改为“未入选模型候选”，避免暗示整个 Executor 被拒绝。
- 最终绑定与未入选候选分区展示，不混在一条红色错误信息中。
- 能力原因转换为用户可理解的文字，同时保留稳定 reason code 供测试和诊断。

普通 UI 禁止展示：

- `modelRef`，例如 `code-cli-5`；
- 内部 `providerRef`，当其与用户可见 Provider 名称不一致时；
- configuration revision；
- binding fingerprint；
- Runtime、attempt 或存储内部 ID。

显式“高级诊断”可以显示内部引用，但必须放在次级折叠区域，并同时展示用户
可见名称，不能用内部引用替代主名称。

### 2.2 名称解析必须绑定历史配置 revision

Management projection 必须使用 Task generation 已固定的 configuration
revision 解析名称，不能使用当前 active 配置替换历史事实。

解析流程：

1. 从已授权 binding 或 routing audit 读取内部引用。
2. 使用该 generation 固定的 revision 查询 Provider/Model/AgentClass。
3. 输出独立的用户可见字段，如 `providerDisplayName`、`modelDisplayName`、
   `executorDisplayName` 和 `harnessDisplayName`。
4. Web 只消费用户可见字段，不自行查表或 humanize 内部引用。

如果历史 revision 中的显示信息确实不可恢复，普通 UI 显示“历史模型信息不可用”
并保留稳定状态码；不得回退显示 `modelRef`。

### 2.3 路由卡片语义

每个 Subtask 只展示一张路由决策卡：

- `最终选择`：Kernel 最终授权的具体 Provider、Model、AgentClass 和 Harness。
- `未入选候选`：候选模型级别的淘汰原因。
- `未选择 Executor`：仅在整个 AgentClass 确实不合格时使用。
- `执行中/已完成`：来自实际 dispatch/attempt，不由候选审计推断。

这样可以直接解释“候选模型未入选，但最终仍由 Codex CLI 执行”的情况。

### 2.4 执行卡片去重

Runtime 持久化 Subtask ID 是执行卡片、详情抽屉和轨迹事件的唯一 canonical
identity。

- Management 层建立 proposal Subtask 到 Runtime Subtask 的显式映射。
- proposal 阶段事件进入公开 projection 前转换为 canonical Subtask ID。
- Web 只按 canonical ID 分组和选择详情。
- 标题仅用于显示，禁止通过标题相同、顺序相同等启发式方式合并。
- reconnect、历史 replay 和实时 delta 必须使用同一个 canonical identity。

### 2.5 轨迹页隐藏 Composer

- `Conversation` tab 保留 Composer、附件和草稿。
- `Trajectory` tab 不渲染 Composer，也不保留其底部占位空间。
- 切换到轨迹页不会清空草稿或待上传附件。
- 切回 Conversation 后恢复原输入状态和焦点语义。
- 轨迹页保持完全只读，不新增另一套命令入口。

### 2.6 浅色、深色和跟随系统

在 Workspace Header 增加三态主题开关：

- `跟随系统`：默认值，响应 `prefers-color-scheme` 实时变化。
- `浅色`：固定浅色主题。
- `深色`：固定当前深色主题。

实现约束：

- 使用 `data-theme` 和 CSS variables 统一颜色 token。
- 偏好写入 localStorage，刷新和重新打开页面后保持。
- 仅在“跟随系统”模式监听系统主题变化。
- 初始化时在首屏渲染前应用主题，避免深浅主题闪烁。
- 对正文、卡片、抽屉、表格、代码块、状态色、边框和 focus ring 做完整适配。
- 浅色主题继续保持当前产品的高信息密度，不改成通用白底模板。
- 两种主题都满足文本和关键状态的可读对比度。

### 2.7 Attempt 的用户可见表达

普通执行叙事不展示原始 `attemptId`。Management 根据 `attemptKind` 和同一
Subtask 内的序号输出用户标签：

- `primary`：`主执行`；
- `continuation`：`继续执行`；
- `fallback`：`回退执行`；
- `contract_correction`：`结果修正`；
- `merge_repair`：`合并修复`。

内部 dispatch/receipt 状态统一转换为 `等待启动`、`执行中`、`已完成`、`失败`、
`已取消` 或 `状态未知`。`terminal` 不能直接出现在普通界面。

Attempt header 固定为“执行标签 / 用户状态 / 耗时”三部分：

- 状态和耗时不可被主标签挤压。
- 主标签设置 `min-width: 0`、单行省略和 tooltip。
- 移动端允许调整为两行，但不得相互覆盖或造成横向滚动。
- 原始 `attemptId` 仅可进入显式高级诊断，并使用截断文本和复制操作。

## 3. 实施任务

### Task 1: 增加失败回归测试

- 复现 proposal ID 与 Runtime ID 导致两个执行卡片。
- 复现路由卡片显示 `code-cli/code-cli-5`。
- 证明同一 AgentClass 的一个模型候选未入选、另一个候选最终被选中。
- 证明 Trajectory tab 当前仍渲染 Composer。
- 增加主题默认值、持久化和系统变化测试。

### Task 2: 扩展用户安全路由 projection

主要涉及：

- `src/management/work-graph-presentation-projector.ts`
- Management/Web session projection 类型
- configuration revision 查询 port
- `web/src/api/types.ts`

输出用户可见名称和候选层级，保留内部 ID 仅供服务端关联。历史名称解析必须使用
generation 固定 revision。

### Task 3: 统一 canonical Subtask identity

在 Management projection 边界完成 proposal/runtime Subtask 映射，使
Conversation、Trajectory、Work Graph、LiveExecutionPanel 和
ExecutionDetailDrawer 消费同一 ID。

### Task 4: 修正路由卡片信息架构

主要涉及：

- `web/src/components/RoutingDecisionCard.tsx`
- Work Graph/Trajectory 路由展示组件
- `web/src/styles.css`

分别展示最终绑定、未入选模型候选和原因，不把候选淘汰渲染成整个 Executor
失败。

### Task 5: 隐藏内部 Attempt ID 并修复执行叙事布局

主要涉及：

- `src/management/execution-projector.ts`
- `web/src/api/types.ts`
- `web/src/components/ExecutionNarrative.tsx`
- `web/src/styles.css`

Management 输出 `attemptKind`、`attemptOrdinal`、`attemptLabel` 和用户状态。
Execution Narrative 不显示 `attemptId` 和内部 `terminal`，并对桌面和移动端的
状态/耗时列增加稳定布局约束。

### Task 6: 将 Composer 限定在 Conversation

调整 `WorkspaceShell`/`App` 的 tab 布局条件，保持草稿和附件状态仍由上层持有。

### Task 7: 实现三态主题

新增小型 theme preference 模块、Header 控件和 CSS token。不得引入新的全局状态
框架或服务端持久化。

### Task 8: 完成端到端验证

浏览器场景必须覆盖：

1. 路由页只显示 `Code CLI / gpt-5.6-terra` 等用户配置名称，不出现
   `code-cli-5`。
2. 一个模型候选未入选后，同一 Codex CLI AgentClass 的另一个模型正常执行。
3. 一个逻辑 Subtask 始终只有一张执行卡片，详情流完整且不中断。
4. Conversation 有 Composer，Trajectory 无 Composer；切回后草稿和附件不丢失。
5. 浅色、深色、跟随系统切换、刷新持久化和系统主题变化都正确。
6. 桌面和移动视口无横向溢出，抽屉、轨迹表格和执行卡片在两种主题下可读。
7. Execution Narrative 显示“主执行”等用户标签和本地化状态，不显示
   `attempt_dispatch_event_...` 或 `terminal`，标签、状态和耗时互不覆盖。

## 4. 验收标准

- 所有普通用户界面的 Provider、Model、Executor、Harness 名称与用户配置页面一致。
- 普通用户界面不出现 `modelRef`、内部 revision 或 binding fingerprint。
- 路由卡片明确区分“模型候选未入选”和“Executor 未被选择”。
- `gpt-5.6-terra` 未声明 `coding` 时，原因指向该模型候选，不指向整个 Codex CLI。
- 最终选择 `gpt-5.6-sol` 后，实际 Codex CLI Executor 与路由展示一致。
- 同一逻辑 Subtask 在实时、历史和重连状态下都只产生一张执行卡片。
- 普通界面不显示原始 `attemptId` 或内部 `terminal` 状态。
- Attempt 标签、状态和耗时在桌面及移动视口都不重叠、不产生横向滚动。
- Trajectory 页面不展示 Composer，Conversation 草稿和附件不受 tab 切换影响。
- 主题支持浅色、深色、跟随系统，并在刷新后保持且无明显首屏闪烁。
- 不改变 Kernel 路由决策、Executor 选择策略或配置激活语义。

## 5. 验证范围

实施后执行：

```text
npm run lint
npm run build
cd web && npm run build
npm test -- tests/management/ tests/web/
RUN_BROWSER_E2E=1 npm test -- tests/e2e/
npm test
git diff --check
```

当前生产流程为 native，本方案不包含 Docker 功能，也不把 Docker 验证作为验收
条件。

## 6. 非目标

- 不修改模型能力配置来绕过候选淘汰。
- 不改变 Auto routing、fallback 或 Kernel 授权策略。
- 不把内部 `modelRef` 重命名为 `modelId`。
- 不删除内部引用；它们继续用于稳定关联和审计。
- 不改变 `attemptId` 的生成、幂等、恢复或回执关联语义。
- 不给 Trajectory 增加输入或执行能力。
- 不新增服务端用户主题存储。
- 未经用户确认不实施、不提交、不同步 GitHub。

## 7. 实施完成记录

### 7.1 Delivered behavior

- Work Graph 新增唯一 canonical Subtask identity owner，Runtime materialization、
  历史读取、重连 snapshot 和实时 delta 使用同一 proposal-to-Runtime 映射。
- Configuration 新增统一公共 Provider Catalog 和 revision-pinned 路由身份解析；
  Settings 与执行投影使用相同的 Provider 显示名称和真实 `modelId`。
- Management Work Graph、Conversation 和 Attempt projection 仅输出普通用户安全
  字段；无法恢复的历史模型显示“历史模型信息不可用”，不回退内部引用。
- 路由卡分开展示“最终选择”和“未入选模型候选”，能力原因定位到具体模型。
- Attempt narrative 显示用户标签和本地化状态，不显示原始 `attemptId` 或
  `terminal`；桌面和移动布局都保持标签、状态、耗时互不覆盖。
- Trajectory 不渲染 Composer；App 继续持有草稿与待上传附件。
- Web Header 已提供跟随系统、浅色、深色三态主题，使用
  `anyfusion.theme` 持久化并在首屏前应用。

### 7.2 验收标准证据

- `tests/work-graph/subtask-identity.test.ts` 和
  `tests/management/execution-presentation-normalizer.test.ts` 证明不按标题或后缀
  猜测，且 proposal/runtime 两类 ID 统一为一个 canonical Subtask。
- Configuration、Execution transparency、Session、Work Graph projector 和
  Settings 测试证明公开路由只使用 revision-pinned Provider/Model/Executor/
  Harness 名称，不泄露 `code-cli-5`、revision 或 binding fingerprint。
- Execution projector 与 Web narrative 测试覆盖五种 attempt kind、本地化状态和
  内部 ID/`terminal` 隐藏。
- `tests/e2e/web-routing-identity-and-theme.test.ts` 使用包含旧双 ID 和超长
  attempt ID 的 Mock Gateway/HTTP fixture，在真实 Chrome 中证明只有一张执行卡、
  详情事件完整、路由身份正确、Composer/附件/草稿行为正确、三态主题正确。
- 浏览器视口覆盖 `1440x1000` 和 `390x844`；两种主题下 routing、warning、
  blocked、failure 和 focus ring 对比度及全局横向溢出均通过断言。
- 未修改 `AutoModelResolver`、Kernel 决策、Executor 选择、配置激活语义或
  `attemptId` 生成规则。

### 7.3 Validation

```text
npm run lint
npm run build
cd web && npm run build
npm test -- focused routing/management/web groups
RUN_BROWSER_E2E=1 npm test -- tests/e2e/web-routing-identity-and-theme.test.ts
npm test
RUN_BROWSER_E2E=1 npm test -- tests/e2e/
git diff --check
```

- 聚焦验证：116 tests passed。
- 全量 native：333 test files passed，7 skipped；1544 tests passed，18 skipped。
- 全量 E2E：5 test files passed；5 tests passed。
- Docker：未运行，按方案明确不属于生产或验收路径。

### 7.4 Residual risk

- Chrome E2E 使用真实浏览器和 Mock Gateway/HTTP fixture，不调用外部 Provider；
  Provider 网络可用性仍由既有 probe、activation 和运行时测试覆盖。
- 主题仍保留少量不随主题变化的语义图表色；普通 Workspace、Routing、Trajectory、
  Composer、Settings 和两个 Drawer 的关键表面已通过双主题浏览器验收。

**Closing commit:** pending user instruction

代码未提交，未同步 GitHub。
