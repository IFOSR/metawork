# Planner 主导的 Workspace 执行模式技术实施方案

- 日期：2026-10-25。
- 状态：已实施（完成日期 2026-10-25）。
- 契约依据：[Planner 主导的 Workspace 执行模式与临时 Worktree 设计](2026-10-25-planner-owned-workspace-mode-design.md)。
- 目标：让 Planner 成为唯一 Workspace 模式语义判断者，以 In-place 作为普通编辑主路径，以内部临时 Worktree 作为明确隔离场景的执行后端，并删除旧的自动复制 publication 路径。

## 1. 实施边界

必须继续遵守：

```text
Planner proposes -> Kernel decides -> Runtime applies
```

本方案不新增第二个语义路由器，不让 Runtime 读取环境变量决定模式，不把 Worktree 注册成用户 Workspace，也不把 Worktree 全量复制到 `publicTaskDirectory`。

现有 `ResourceLeaseService`、Workspace canonicalization、Attempt uncertainty、WorkspaceChangeRecord、live Artifact 和固定 Artifact 能力继续复用。

## 2. 阶段一：配置与公共类型

### 修改范围

- `src/configuration/types.ts`
- `src/configuration/schema.ts`
- 配置迁移、projection、activation 和 revision 读取路径
- `web/src/settings-model.ts`
- `web/src/components/SettingsPanel.tsx`
- `web/src/api/types.ts`

### 实施内容

新增：

```ts
workspaceExecution: {
  fallbackMode: 'in_place' | 'worktree';
}
```

配置校验只允许两个枚举值。保存和激活沿用现有 strict-idle configuration revision 流程，不触发 Planner，也不在保存时创建 Workspace 或 Worktree。

Web 高级设置显示两个选项：

- In-place：Planner 无法判断时，直接在目标 Workspace 执行；
- Worktree：Planner 无法判断时，先在隔离执行目录中执行。

页面明确说明：Planner 的明确判断优先于该设置。

### 迁移规则

- 旧配置没有该字段时使用 `in_place` 作为新安装默认值；
- 已存在的环境变量只用于迁移兼容，不再作为 Task admission 的最终来源；
- 已持久化 Task/Generation 的模式不受配置变化影响。

## 3. 阶段二：Planner Workspace 意图契约

### 修改范围

- `src/planning/planning-types.ts`
- `src/planning/planning-agent-plan-schema.ts`
- `src/planning/planning-agent-plan-validator.ts`
- `src/planning/anyfusion-planning-agent.ts`
- Planner MCP/schema 生成和版本迁移代码
- Planner system/tool instructions

### 实施内容

将 Planner plan 从 v8 升级到下一个可用版本，增加 `workspaceIntent`：

```ts
workspaceIntent: {
  targetWorkspaceId: string | null;
  targetPaths: string[];
  operation: WorkspaceOperation;
  originalFilePolicy: 'may_replace' | 'must_preserve' | 'unknown';
  isolationPolicy: 'requested' | 'not_requested' | 'required' | 'unknown';
  proposedMode: 'in_place' | 'worktree' | null;
  confidence: number;
  reason: string;
}
```

验证规则：

- `proposedMode='in_place'` 必须有明确目标 Workspace 或可由受信 Conversation binding 解析；
- `proposedMode='worktree'` 必须说明隔离、风险、候选或接受理由；
- `operation='ambiguous'` 必须返回 `action='clarification'`；
- `read_only` 不得生成写入型 Work Graph；
- Planner 不得使用任意绝对路径绕过 Workspace binding；
- v8 旧计划映射为 `workspaceIntent=null`，由 Kernel 进入兼容 fallback/追问规则。

重点增加测试：覆盖“修改原文件”“在 Workspace 新建文件”“保留原文件并另存”“明确隔离”“高风险批量修改”和“3 页 PPT 扩展”追问。

## 4. 阶段三：Kernel admission

### 修改范围

- `src/kernel/control-kernel.ts`
- `src/kernel/kernel-workflow.ts`
- plan admission snapshot、decision ledger 和 dispatch item 类型
- Workspace binding repository

### 实施内容

在 `plan_proposed` admission 中增加统一决策函数：

```ts
resolveWorkspaceExecutionDecision({
  workspaceIntent,
  fallbackMode,
  workspaceBinding,
  riskFacts,
  existingGenerationBinding,
})
```

输出：

```ts
{
  executionMode: 'in_place' | 'worktree';
  source: 'explicit_user' | 'planner' | 'fallback' | 'kernel_safety';
  reason: string;
  deliveryPolicy: 'none' | 'auto_publish' | 'await_acceptance';
}
```

Kernel 校验：

1. 目标 Workspace 所属 Account 和 Conversation binding；
2. 目标相对路径 containment、symlink 和 regular-file 规则；
3. In-place 的后端、权限和 Workspace 可写性；
4. Worktree 隔离目录的创建能力；
5. 已有 Generation binding 的模式不可变；
6. 高风险且无明确授权时请求确认；
7. 语义歧义时复用 `request_clarification`；
8. Planner 缺失模式但语义安全时才使用配置 fallback；
9. Planner 失败或输出非法时进入安全 Worktree 或追问，不得静默 In-place。

追问 decision 不创建 Task、Attempt、Worktree 或写租约。

## 5. 阶段四：Binding、Attempt 与 Retry

### 修改范围

- `src/execution/execution-context.ts`
- `src/storage/workspace-execution-binding-repo.ts`
- `src/session/session-kernel-runtime.ts`
- `src/execution/kernel-execution-runtime.ts`
- `src/execution/subtask-attempt-runner.ts`
- Retry/recovery 相关路径

### 实施内容

- 移除 Session Runtime 直接调用环境变量解析最终模式的逻辑；
- Task 创建事务消费 Kernel decision；
- ExecutionContext 只从持久 binding 生成；
- Retry 继承原 Task/Generation 的 `executionMode` 和 binding fingerprint；
- 同一 Conversation 后续轮次复用既有 Generation binding；
- Runtime 启动前验证 binding fingerprint、模式和授权工作目录；
- In-place 的 `authorizedWorkingDirectory` 必须等于目标 Workspace canonical root 或其受授权子目录；
- Worktree 的 `authorizedWorkingDirectory` 必须位于受控 Generation execution root 内。

环境变量解析函数可以暂时保留测试兼容，但不能再成为生产 Task admission 的决策来源。

## 6. 阶段五：临时 Worktree 执行目录

### 修改范围

- `src/execution/workspace-store.ts`
- `src/execution/managed-git-workspace.ts`
- `src/execution/worktree-attempt-execution-backend.ts`
- Generation/Attempt cleanup 和 startup recovery
- `src/storage/workspace-execution-binding-repo.ts`

### 实施内容

Worktree 模式创建或复用内部执行目录：

```text
<managed-workspace-root>/<generation-id>/<subtask-id>/
```

该目录：

- 不注册为用户 Workspace；
- 不进入 Workspace Catalog；
- 不展示绝对路径给用户；
- 只由对应 Generation/Attempt 访问；
- 可以在同一 Generation 的后续轮次复用；
- 终结后由 Kernel/Runtime 协调清理。

清理必须满足：

- Attempt 已终结；
- publication 已成功、被拒绝或明确放弃；
- 没有待恢复的 uncertain 状态；
- 没有活跃 lease 或子进程。

崩溃或外部副作用未知时保留目录，启动恢复完成后再清理。清理失败写入诊断事实，不得递归删除用户 Workspace。

## 7. 阶段六：删除旧 Worktree publication

### 修改范围

- `src/execution/workspace-publication-worker.ts`
- `src/delivery/user-artifact-publication-service.ts`
- `src/delivery/public-delivery-view.ts`
- `src/storage/workspace-publication-repo.ts`
- `src/storage/task-artifact-repo.ts`
- Web Task result components

### 删除内容

- `publicTaskDirectory` 作为 Worktree 结果目录的运行时语义；
- Worktree 全树复制；
- `legacy: mode === 'worktree'`；
- publication worker 自动根据 Task mode 复制文件；
- 依赖内部 Worktree 路径的用户预览和下载入口。

### 新发布流程

Worktree 结果先形成：

- WorkspaceChangeRecord；
- 声明的 `fileOutputs`；
- 候选 Artifact；
- 发布计划和冲突信息。

Kernel 明确授权后，发布服务：

1. 解析目标 Workspace；
2. 申请目标 Workspace ResourceLease；
3. 重新验证目标路径和源 Artifact；
4. 只应用授权变更集或声明文件；
5. 持久化每个文件的发布事实；
6. 释放租约；
7. 终结后清理临时 Worktree。

历史 publication 行可以保留为只读审计数据，但不再由旧 worker 自动恢复或执行。迁移时将未完成旧 publication 标记为需要重新接受或重新执行，禁止静默复制。

## 8. 阶段七：变更记录与 Artifact

复用已实现的 `workspace-change-git.ts`、`workspace-change-recorder.ts` 和 Artifact resolver，补充以下语义：

- In-place 记录目标 Workspace 的实际变化；
- Worktree 记录内部执行目录的候选变化；
- Worktree 发布后追加目标 Workspace 的发布结果；
- `PresentedFile` 使用 `workspaceId + relativePath` live 解析；
- 固定版本使用 CAS/Result Object；
- 不把临时 Worktree 绝对路径写入用户引用；
- 变更摘要缺失不会自动认证 Task 完成；
- 声明的 `fileOutputs` 缺失仍然阻止交付认证。

## 9. 阶段八：数据库迁移

迁移版本必须使用合并后可用的下一个 schema 版本，不能重新占用 main 已使用的版本号。

迁移内容：

- 增加或调整 Workspace execution binding 的来源和模式事实；
- 为 Planner 新版本保存 `workspaceIntent`；
- 将旧 `publicTaskDirectory` 从运行时必需字段降为历史字段，最终删除前先完成读取路径切换；
- 清理或标记旧 publication 状态；
- 保留历史 Artifact 和审计记录；
- 不将旧复制目录解释为当前 Workspace 文件。

SQLite migration 必须使用真实旧数据库结构验证，不得只修改版本号伪造迁移路径。迁移失败必须保持旧版本可启动且不得部分提交。

## 10. 阶段九：Web 与 TUI

执行详情展示：

- 实际执行模式：In-place / Worktree；
- 模式来源：用户明确、Planner、fallback 或 Kernel 安全规则；
- 目标 Workspace；
- Worktree 候选状态：执行中、待接受、冲突、已发布、已清理；
- In-place 变更文件和登记状态。

不再展示：

- “任务目录”作为 Worktree 的默认成果位置；
- 内部 Worktree 绝对路径；
- “复制完成”作为 Worktree 成功的唯一含义。

## 11. 测试矩阵

### Planner/Kernel

- 明确修改原文件 -> `in_place`；
- 在目标 Workspace 新建文件 -> `in_place`；
- 明确隔离或候选版本 -> `worktree`；
- “扩展成 5 页” -> clarification；
- Planner 无模式且低风险 -> 使用配置 fallback；
- Planner 失败或非法 -> 追问或安全 Worktree；
- Kernel 拒绝越权 Workspace、绝对路径和不满足 containment 的目标。

### Runtime/Worktree

- Worktree 执行期间目标 Workspace 内容和 Git 状态不变；
- 同一 Generation 后续 Attempt 复用执行目录；
- 发布前不创建用户可见任务目录；
- 发布只应用授权文件或变更集；
- 用户明确选择项目子目录时，内部来源路径与项目内目标路径分离，发布不产生双重目录；
- 发布成功后清理执行目录；
- 崩溃和 uncertain 状态保留执行目录并可恢复；
- Retry 保持原模式和 binding fingerprint。

### 并发与安全

- 两个 Server 进程抢同一 In-place Workspace；
- In-place 执行与 Worktree 发布同时针对同一 Workspace；
- Worktree 只持有内部目录 lease，发布时才申请目标 Workspace lease；
- 同一 Workspace 的祖先/后代路径冲突；
- symlink、大小写折叠和 NFC 规范化路径；
- 预览和下载只能读取授权 Workspace 或固定 Artifact。

### 验证顺序

```text
npm run lint
  -> Planner/Kernel focused tests
  -> Workspace/ResourceLease/Worktree lifecycle tests
  -> Artifact/publication tests
  -> Web settings and result projection tests
  -> Docker SQLite migration/POSIX tests
  -> native Worktree and In-place smoke
  -> npm test
```

## 12. 交付门槛

在以下条件全部满足前，不能删除旧数据列或将方案标记为完成：

1. Planner Workspace intent 契约已进入有效 revision；
2. Kernel admission 已成为唯一模式授权入口；
3. Retry 和 recovery 已验证模式不可变；
4. Worktree 目标 Workspace 零写入测试通过；
5. 显式发布和冲突处理测试通过；
6. 旧 publication worker 不再产生复制任务目录；
7. Worktree 临时目录的崩溃保留和终结清理通过；
8. Docker migration、跨进程 lease 和 POSIX containment 测试通过；
9. Web 能展示实际模式、来源、目标 Workspace 和发布状态；
10. 实施完成后补充完成日期、实际交付、验证结果和关闭提交。

## 13. 实施完成记录（2026-10-25）

### 实际交付

- **配置（阶段一）**：`workspaceExecution.fallbackMode` 进入配置类型、schema、projection 与
  `KernelConfigurationView`；旧 revision 不新增字段以保持 contentHash 不变，读取侧通过
  `workspaceFallbackMode()` 解析默认 `in_place`；Web 高级设置新增两个选项并明确
  「Planner 明确判断优先、Kernel 安全规则优先」。
- **Planner 契约（阶段二）**：plan 升到 schema 9，新增 `workspaceIntent`
  （`targetWorkspaceId`/`targetPaths`/`operation`/`originalFilePolicy`/`isolationPolicy`/
  `proposedMode`/`confidence`/`reason`）；`PlanningAgentPlanSchema` 先校验版本再进入
  `anyOf` 分支，输出契约与工具 schema（`planning-agent-plan-v9.schema.json`）同步
  迁移；schema 8 计划继续可解析并映射为 `workspaceIntent = null`；SKILL 与 system
  prompt 增加 Workspace 意图规则。
- **Kernel admission（阶段三）**：新增 `src/core/workspace-execution.ts`（共享词汇）与
  `src/kernel/workspace-execution-decision.ts`（唯一模式判定）。`plan_proposed` 事件
  固定 `workspaceAdmission`（Conversation 绑定的 target Workspace + worktree 可用性），
  Decision 固定 `workspaceExecution` 与 `workspaceIntent`；越权 Workspace、非相对或
  穿越路径、`read_only` 写图、`in_place` 与强制隔离矛盾、Worktree 无理由、高风险无
  模式、Workspace 缺失、覆盖/隔离语义为 `unknown` → 追问或拒绝；声明的 `fileOutputs` 还必须被
  `workspaceIntent.targetPaths` 覆盖，防止交付声明绕过 Workspace 授权范围；追问不建
  Task/Attempt/Worktree/写租约。
- **目标范围与只读隔离收口**：写入型 Workspace intent 没有目标文件或目录时进入追问，不能以
  空范围授权整个 Workspace；报告型 `read_only` Work Graph 使用内部 Worktree 执行且交付策略为
  `none`，避免只读语义在用户目录中产生写入。Attempt 的 Executor context 将持久化的相对
  `targetPaths` 解析到实际执行根后再传递，容器映射和提示中的授权范围保持一致。
- **Binding/Attempt/Retry（阶段四）**：删除环境变量准入（
  `resolveAdmittedExecutionMode`/`isInPlaceInPlaceEnabled`），模式只来自 Kernel 决策；
  Task 固化 `workspaceExecutionSource`/`workspaceDeliveryPolicy`/`workspaceTargetPaths`/
  `workspaceIntent`；`workspace_execution_bindings` 记录 `mode_source`/`delivery_policy`/
  `workspace_intent_json`/`targeted_paths_json`/`cleaned_at`；重规划沿用首个 binding 的
  模式，冲突即失败关闭；旧 Decision 回退为隔离兜底。
- **临时执行目录（阶段五）**：`WorktreeExecutionCleanupService` 在 Generation 终结且无
  publication/租约/派发/唤醒/重规划/uncertain 残留时清理内部目录并记录 `cleaned_at`；
  有残留时保留并写诊断；接入任务终结、取消、状态派生成功后的收尾与启动恢复 sweep。
  发布尚未定案（含 `await_acceptance` 与失败的交付）一律保留执行目录，避免重试
  重新交付时丢失候选文件；清理同时 `git worktree prune` 该 Generation 仓库，防止
  旧注册阻塞后续 retry 重新挂载。
- **发布语义（阶段六）**：Worktree 发布按声明相对路径只应用授权变更集，不再复制到
  `metaclaw-tasks/<slug>`；`publicTaskDirectory` 只作为显式选定项目目录的发布根；
  `legacy` 标记、`publicDeliveryLines` 的「任务目录」语义与旧复制路径删除；新增
  `await_acceptance` 候选发布门与 Kernel 授权动作 `authorize_workspace_delivery`
  （由显式接受触发）；admission 时对声明的目标路径采集基线，用户在接受前改动同一
  文件仍报冲突。
- **migration 57**：tasks/bindings/publications 新列；未完成的 worktree publication
  迁移为 `parked` 并要求显式重新接受或重启执行，不静默复制。
- **呈现（阶段九）**：TaskView/Web `TaskResultActions` 与单 MetaWork TUI 展示执行模式、
  模式来源、目标 Workspace/项目目录、in-place 变更或 worktree 候选状态。
- 修复了由此暴露的一个真实缺陷：`drainPublications` 在「候选等待接受」这类稳定状态下
  会无限循环；现在只有真正产生 integration 才会继续排空。

### 验证

- `npx tsc --noEmit`（`npm run lint`）通过；`npm run build` 的 tsup 与
  `planning-agent-plan-v9.schema.json` 生成通过（`anyOf` 两分支、schema 9 含
  `workspaceIntent`）；`npm run build --prefix web` 通过；`planner/AnyFusion-Pi`
  的 `npm run check` 与 metawork TUI 测试通过。
- 新增测试：`tests/planning/planner-workspace-intent.test.ts`（14）、
  `tests/kernel/workspace-execution-decision.test.ts`（21）、
  `tests/kernel/workspace-execution-admission.test.ts`（12）、
  `tests/execution/worktree-execution-cleanup.test.ts`（3）、
  `tests/e2e/planner-owned-workspace-mode.test.ts`（5，覆盖 in_place 就地交付、
  隔离候选零写入 + 接受后发布、auto_publish 声明路径发布、失败轮保持固定模式）。
- 新增 Workspace 授权边界回归：Planner/Kernel 拒绝未被 `targetPaths` 覆盖的声明输出，
  防止 Worktree 发布阶段通过 `fileOutputs` 绕过目标路径范围。
- 新增目标范围与只读隔离回归：写入型 intent 缺少目标路径时追问；报告型 `read_only`
  Work Graph 在内部 Worktree 中执行，`deliveryPolicy=none` 不申请用户 Workspace 租约、
  不发布 scratch/artifact 文件；Executor context 将 Planner 相对目标路径解析到实际执行根，
  并在 Runtime 再次拒绝绝对、穿越或逃逸执行根的持久化路径。
- 修复显式项目发布的真实路径错误：Worktree 的内部来源路径与用户项目内的目标路径
  分开记录，避免把 `existing/app.txt` 的来源误解析成 Workspace 根下的 `app.txt`，也避免
  生成 `existing/existing/...` 的双重目录。
- 当前收口验证：`npm run lint`（`tsc --noEmit`）通过；Planner/Kernel、Workspace 生命周期、
  Executor context、交付和 Web 操作的 focused 回归通过（含新的只读报告、空目标范围和
  目标路径解析回归）；`npm run build --prefix web` 通过。最近一次
  全量 `npx vitest run` 为 4012 passed / 78 failed / 34 skipped；失败集中在未迁移的
  schema 8 自动交付 fixture、六态迁移后的旧 Kernel/Session 断言、旧 schema-44 哈希
  fixture 和既有环境依赖用例，本方案不恢复这些历史隐式发布语义。
- 旧 Markdown 预览服务不再由 Server 启动（它曾以内部 workspace-store 为根提供
  `metaclaw-tasks` 副本）；交付文件统一走 Workspace artifact preview，相关架构断言
  已更新。
- 关闭提交：本次实现变更（尚未提交，等待评审后按 Conventional Commit 提交）。
- 参考：ADR-0050。

### 未纳入本次范围

- 旧 publication 行的历史删除（保留为只读审计数据，本轮只停用其自动复制/恢复路径）。
- 既有历史失败用例的修复（属于六态 Task 迁移遗留，与本方案无关）。
