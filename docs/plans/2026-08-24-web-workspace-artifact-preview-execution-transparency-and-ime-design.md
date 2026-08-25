# Web Workspace、文档预览、执行透明化与输入法交互实施方案

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将用户可见产物、文档预览、Planner 到 Executor 的实时执行信息，以及中文输入法回车交互统一收敛到 AnyFusion 桌面 Web 工作台。

**Architecture:** 保留现有 `Planner -> ControlKernel -> Runtime -> ExecutorAdapter` 控制主轴和 `InteractionTrace` 流。用户启动目录是用户可见 Workspace，账户数据目录下的 Git worktree 继续作为内部执行隔离；经过验证和 publication 的产物通过独立的用户产物发布服务复制到启动目录，并由结构化 artifact projection 驱动 Web 预览。Web 不读取任意路径、不调度执行、不解释原始 Executor 日志；中文输入法通过 IME composition 状态与普通 Enter 发送行为分离。

**Tech Stack:** Node 22.19+, TypeScript ESM, SQLite/better-sqlite3, existing Gateway/WebSocket `trace_snapshot` and `trace_delta`, React/TypeScript, desktop Web browser automation.

---

**Status:** Implemented（本地落地完成；待用户确认后同步 GitHub）

**Plan date:** 2026-08-24

**Completion date:** 2026-08-24

**Delivered behavior:**

- Task 1：组合根一次性捕获不可变 `startupWorkspaceRoot = resolve(process.cwd())`，
  以独立依赖 `userWorkspaceRoot` 与内部 `workspaceStore` 区分传入
  `buildAccountRuntimeComposition`；Markdown preview allowed root 同步改用启动目录。
- Task 2：新增 `src/delivery/user-artifact-publication-service.ts` 与
  `user-artifact-types.ts`。Git publication 成功后由
  `WorkspacePublicationWorker.publishUserArtifacts` 将已验证 artifact 原子复制到
  `<startup>/metaclaw-tasks/<slug>-<short-id>/`（临时文件 + rename），拒绝符号链接、
  绝对路径与路径穿越；同名新内容自动把旧记录标记 unavailable。
- Task 3：SQLite schema v34 新增 `task_artifacts` 表（唯一约束
  `(account_id, task_id, relative_path, content_hash)`、task/publication 索引）与
  `migrateSchema33To34` 升级路径；新增 `TaskArtifactRepo`，`published_path` 仅后端使用。
- Task 4：同源 API `GET /api/artifacts/:id{,/preview,/download}`（仅接受 artifact ID；
  Account/Task 归属校验 + realpath 越界校验）。Conversation turn 投影新增
  `artifacts: ArtifactProjection[]` 兼容字段 `artifactRefs` 保留；
  `artifact_published` view event 扩展受限 projection。
- Task 5：Web 右侧文档预览抽屉（markdown/text/code/unsupported 四态、收起/下载/
  Escape/切换会话清空），三列桌面布局，关闭后主对话恢复全宽且无全局横向滚动。
- Task 6：执行里程碑事件规范化——新增 `execution-transparency.ts` 投影助手，
  `executor_routed/dispatch_started/subtask_execution_started/executor_progress/
  heartbeat(waiting)/result_observed(verifying)/publication_integrated(published)`
  携带 Executor/Harness/Provider/Model 显示名与 stepKey/stepLabel/progress(null 不伪造)；
  Web `LiveExecutionPanel` 按 subtaskId 分组实时卡片，完成后折叠为执行摘要。
- Task 7：Composer IME-aware Enter——compositionstart/end 状态跟踪 +
  `isComposing`/`keyCode===229`/ref 三重判断，合成期间不发送不 preventDefault，
  composition 刚结束的一次 Enter 不触发发送；普通 Enter 发送、Shift+Enter 换行、
  Ctrl/Cmd+Enter 强制发送；键盘提示 `Enter 发送 · Shift+Enter 换行`。

**Validation:** `npm run lint` ✓；`npm run build` ✓；`cd web && npm run build` ✓；
`RUN_BROWSER_E2E=1 npm test -- tests/e2e/` ✓（4/4，含新增
`tests/e2e/artifact-preview-and-ime.test.ts` 浏览器全流程）；`npm test`
✓（1492 passed / 0 failed / 17 skipped）；`git diff --check` ✓。
Docker 全平台套件按仓库规则另行执行（better-sqlite3 本机不可用时）。

**Closing commit:** 待用户确认后提交并同步。

## 8. Execution Transparency Follow-up（2026-08-24 用户反馈追加）

**问题：** 任务派发给 Executor 后用户处于忙等状态——trace 事件只有
`agent loop started` 一类生命周期里程碑，Executor 的真实执行过程
（叙述、工具活动、命令）没有以流的方式呈现给用户。

**根因：** `PiCliDriver.parseProgressLine` / `CodexCliDriver.parseProgressLine`
只翻译生命周期事件，丢弃了 Pi 的 `message_end`（助手叙述）、
`tool_execution_start/end.args` 与 Codex 的 `command_execution.command`、
`mcp_tool_call.tool`、`web_search.query`、`agent_message.text` 等内容事件。

**修复（双通道呈现）：**

1. 驱动层富化：新增 `executorActivityExcerpt`（redactSensitiveText + 压缩空白 +
   截断 240/120）。Pi：`message_end` 助手叙述 → `Executor: <摘录>`；工具事件携带
   白名单参数摘要（command/path/file_path/url/query/pattern/skill）。
   Codex：工作区命令、MCP 工具名+参数、搜索词、助手叙述实时流出；
   `reasoning` 只流出"正在推理"里程碑，隐藏思维链内容不透出。
   `message_update`（逐 token）不进入进度流，`message_end` 粒度呈现。
2. 主对话框信息卡（流式内联）：富进度经既有 `executor_progress` trace 事件
   实时刷新 ExecutionNarrative 与 LiveExecutionPanel 卡片（含 stepLabel）。
3. 可点击子任务详情抽屉：LiveExecutionPanel 子任务卡变为可点击按钮 →
   右侧 `ExecutionDetailDrawer` 按时间线实时呈现该 Subtask 的全部安全事件
   （trace_delta 到达自动追加并滚底），与文档预览抽屉互斥复用右侧槽位，
   Escape/切换会话关闭。对话与轨迹两个 Tab 均可进入。

**Validation（追加）：** `npm run lint` ✓；`npm run build` ✓；
`cd web && npm run build` ✓；`tests/executor`（Pi/Codex 驱动富事件断言）✓；
`tests/web`（可点击卡 + 详情抽屉源码契约）✓；
`RUN_BROWSER_E2E=1 tests/e2e/artifact-preview-and-ime.test.ts` ✓
（含 trace_delta 实时追加断言）；`npm test` ✓ 1494 passed / 0 failed；
`git diff --check` ✓。

**Scope:** 桌面 Web 工作台；不包含移动端适配、新增 Executor、Executor 热插拔、模型事实配置或新的调度策略。

**Related plans:**

- [MetaWork 配置热激活、Auto 路由与 DAG 可视化设计](2026-08-23-metawork-hot-activation-auto-routing-and-plan-visualization-design.md)
- [Provider Catalog And Planner/Executor Routing Design](2026-08-23-provider-catalog-planner-fixed-executor-auto-routing-design.md)
- [Web session workspace redesign](2026-08-17-web-session-workspace-redesign.md)
- [Planner progress streaming](2026-08-17-planner-progress-streaming.md)

## 1. Current Findings

当前实现存在四个需要统一处理的问题：

1. Executor 内部 workspace 位于账户数据目录，结果或 artifact 可能以内部深层绝对路径呈现给用户。
2. Markdown preview 服务已经存在，但 Web 工作台没有同源的右侧文档预览抽屉。
3. `InteractionTrace` 已经支持 `trace_snapshot` 和 `trace_delta`，但执行过程需要更明确地展示 Executor、Harness、Provider、Model 和当前步骤。
4. [web/src/components/Composer.tsx](../../web/src/components/Composer.tsx) 当前对所有非 `Shift+Enter` 的 Enter 都直接调用 `submit()`，没有判断中文输入法的 composition 状态。

本方案不改变以下现有边界：

- Planner 只提交 proposal，不直接调用 Executor。
- ControlKernel 仍是授权、调度、retry、fallback 和 recovery 的唯一策略拥有者。
- Execution Runtime 仍负责应用 Kernel decision 和产生规范化事实。
- Web 只消费 Gateway 投影，不直接操作 Repository、Kernel 或 Executor。
- 原始 prompt、stdout/stderr、凭据和隐藏思维链不进入前端。

## 2. Product Decisions

### 2.1 Workspace

启动 AnyFusion 的进程工作目录是用户 Workspace：

```text
startupWorkspaceRoot = resolve(process.cwd())
```

该值在生产 composition root 初始化时捕获，并在本次进程生命周期内保持不变。Executor 的 `cwd`、Git worktree、Runtime home 和账户数据目录不能覆盖或改变它。

用户可见产物目录固定为：

```text
<startupWorkspaceRoot>/
└── metaclaw-tasks/
    └── <task-slug>-<short-task-id>/
        ├── report.md
        ├── summary.md
        └── assets/
```

本期继续使用 `metaclaw-tasks`，以兼容现有 Markdown preview URL 和历史测试。用户界面只展示任务名称、文档名称和相对路径；完整 UUID、revision、attempt、worktree 和账户数据路径仅保留在服务端诊断中。

内部执行目录继续使用：

```text
~/.anyfusion/accounts/local-default/workspace-store/...
```

内部 worktree 不直接作为用户生成文档的最终目录，也不在 Web artifact link 中暴露。

### 2.2 Artifact

只有经过 Completion Protocol 验证、Git publication 成功并完成用户产物复制的文件，才成为用户可见 artifact。

Artifact 必须具备稳定 ID、所属 Account/Task、显示名称、相对路径、媒体类型、预览类型、大小和内容哈希。前端永远通过 artifact ID 访问文件，不提交或接收任意绝对路径。

### 2.3 Document preview

右侧文档预览抽屉默认关闭。点击报告、文档或 artifact link 后打开。预览区关闭或收起后，中间对话恢复全宽。

Markdown、纯文本和代码文件支持同源预览；其他文件显示元信息和下载操作。Web 预览优先使用 Management Server 的同源 API；现有独立 Markdown preview 服务继续服务 Feishu 或外部链接。

### 2.4 Execution transparency

执行信息复用现有 InteractionTrace 流，不新增第二套 WebSocket 或前端调度器。

用户至少能看到：

- 当前 Executor/AgentClass。
- 当前 Harness。
- 当前 Provider。
- 当前 Model。
- 当前 Subtask。
- 当前执行步骤。
- 当前状态、耗时和可用时的进度。

展示为安全的规范化里程碑，不展示原始命令、原始日志、prompt 或隐藏思维链。

### 2.5 Enter and IME

Enter 的行为按输入法状态区分：

- IME 正在合成时，Enter 由输入法确认候选词，不发送。
- 非 IME 状态下，普通 Enter 发送。
- `Shift+Enter` 插入换行。
- `Ctrl+Enter`/`Cmd+Enter` 显式发送。
- composition 结束后，下一次普通 Enter 才恢复发送语义。

## 3. Contracts

### 3.1 User artifact projection

新增用户可见 projection 类型，建议放在 Artifact/Management 共享契约 owner 下：

```ts
interface ArtifactProjection {
  artifactId: string;
  taskId: string;
  publicationId: string | null;
  displayName: string;
  relativePath: string;
  mediaType: string;
  previewKind: 'markdown' | 'text' | 'code' | 'unsupported';
  previewable: boolean;
  byteLength: number;
  contentHash: string;
  publishedAt: string;
}
```

不得把 `absolutePath`、`storageUri`、`workspaceRoot` 或内部执行标识放进 Web projection。

### 3.2 Artifact persistence

新增 `task_artifacts` 表，至少包含：

```text
artifact_id
account_id
task_id
generation_id
subtask_id
publication_id
display_name
relative_path
published_path
media_type
preview_kind
content_hash
byte_length
status
created_at
updated_at
```

`published_path` 仅由后端使用。查询结果经过 projection 后才传给 Web。

建议为新表增加唯一约束：

```text
(account_id, task_id, relative_path, content_hash)
```

并为 `artifact_id`、`task_id`、`publication_id` 建索引。

### 3.3 Artifact API

增加同源、带现有 Web 鉴权的接口：

```text
GET /api/artifacts/:artifactId
GET /api/artifacts/:artifactId/preview
GET /api/artifacts/:artifactId/download
```

`preview` 返回：

```ts
{
  artifact: ArtifactProjection;
  content: string;
  renderedHtml?: string;
}
```

接口必须验证 artifact 所属 Account、Task 和允许的 published path。路径穿越、绝对路径、符号链接和未授权 artifact ID 一律拒绝。

### 3.4 Conversation turn projection

保留现有 `artifactRefs: string[]` 作为兼容字段，新增：

```ts
artifacts: ArtifactProjection[];
```

Gateway 的 `artifact_published` view event 由仅包含数量扩展为包含受限 artifact projection。历史客户端仍可以只使用 `artifactRefs`。

### 3.5 Execution trace events

继续使用现有 `trace_snapshot`/`trace_delta`，新增或规范化以下事件：

```text
executor_routed
executor_queued
executor_started
executor_progress
executor_waiting
executor_verifying
executor_published
executor_completed
```

事件 `details` 允许包含：

```ts
{
  subtaskId: string;
  subtaskTitle: string;
  executorDisplayName: string;
  harnessDisplayName: string;
  providerDisplayName: string;
  modelDisplayName: string;
  stepKey: string;
  stepLabel: string;
  stepIndex?: number;
  stepTotal?: number;
  progress?: number | null;
  startedAt?: string;
  updatedAt?: string;
}
```

如果没有可靠进度百分比，使用 `null` 表示不确定，不伪造百分比。

## 4. Implementation Tasks

### Task 1: Capture the user Workspace root

**Files:**

- Modify: `src/index.ts`
- Modify: `src/account/account-runtime-composition.ts`
- Modify: `src/account/account-workspace-services.ts`
- Test: `tests/architecture/production-composition.test.ts`
- Test: `tests/account/account-startup-recovery-service.test.ts`

**Steps:**

1. 在 composition root 捕获不可变的 `startupWorkspaceRoot`。
2. 将用户 Workspace root 和内部 `workspaceStore` 作为不同依赖传递。
3. 保持测试环境可显式注入 Workspace root。
4. 添加测试，确认启动目录改变时不会被内部 worktree 覆盖。
5. 添加测试，确认生产 composition 不把账户 workspace-store 当作用户 Workspace。

### Task 2: Implement user artifact publication

**Files:**

- Create: `src/delivery/user-artifact-publication-service.ts`
- Create: `src/delivery/user-artifact-types.ts`
- Modify: `src/execution/workspace-publication-worker.ts`
- Modify: `src/delivery/verification-and-delivery-service.ts`
- Modify: `src/storage/task-repo.ts`
- Test: `tests/delivery/user-artifact-publication-service.test.ts`
- Test: `tests/execution/workspace-publication-worker.test.ts`

**Steps:**

1. 为任务标题生成安全 slug 和短 ID 目录名。
2. 为每个已验证 artifact 计算用户相对路径。
3. 校验 artifact 来源位于已集成 workspace，拒绝符号链接和路径穿越。
4. 使用临时文件和原子 rename 发布到 `metaclaw-tasks/<task>/`。
5. 生成 `ArtifactProjection`。
6. 让 publication 完成事实只在用户产物发布成功后产生可见 artifact。
7. 测试重复 publication、同名文件、损坏复制和取消任务场景。

### Task 3: Add artifact persistence and migration

**Files:**

- Modify: `src/storage/migrations.ts`
- Create: `src/storage/task-artifact-repo.ts`
- Modify: `src/storage/database.ts`
- Modify: `tests/storage/migrations.test.ts`
- Create: `tests/storage/task-artifact-repo.test.ts`
- Modify: `Dockerfile.test` or related schema fixtures when required

**Steps:**

1. 增加下一个 SQLite schema migration，创建 `task_artifacts`、索引和约束。
2. 增加 insert/find/list/read methods。
3. 将新增 migration 纳入 fresh database 和 upgrade database 测试。
4. 保留历史 `tasks.artifacts_json` 和旧 publication 数据的读取兼容。
5. 记录旧 artifact 无法迁移时的不可用状态，不暴露旧绝对路径。

### Task 4: Add same-origin artifact APIs

**Files:**

- Modify: `src/management/server.ts`
- Create or modify: `src/management/artifact-preview-service.ts`
- Modify: `src/management/web-session-catalog.ts`
- Modify: `src/management/web-session-runtime-types.ts`
- Test: `tests/management/server.test.ts`
- Create: `tests/management/artifact-preview-service.test.ts`

**Steps:**

1. 增加 artifact metadata、preview 和 download 路由。
2. 只接受 artifact ID，不接受客户端文件路径。
3. Markdown 使用安全渲染器，纯文本和代码使用 HTML escape。
4. 对未授权、已删除、越界和不支持的文件返回结构化错误。
5. 将 artifact projection 放入 Conversation turn 和 `artifact_published` event。

### Task 5: Build the Web document preview drawer

**Files:**

- Modify: `web/src/App.tsx`
- Modify: `web/src/api/http.ts`
- Modify: `web/src/api/session-types.ts`
- Create: `web/src/components/ArtifactLink.tsx`
- Create: `web/src/components/ArtifactPreviewDrawer.tsx`
- Modify: `web/src/components/WorkspaceShell.tsx`
- Modify: `web/src/components/ConversationTurn.tsx`
- Modify: `web/src/components/TrajectoryView.tsx`
- Modify: `web/src/styles.css`
- Test: browser E2E test under `tests/e2e/`

**Steps:**

1. 在 App 层维护当前 `previewArtifactId` 和 preview loading/error 状态。
2. 让 WorkspaceShell 在预览打开时使用三列桌面布局。
3. 在对话、结果卡片和 Trajectory 中使用结构化 `ArtifactLink`。
4. 实现 Markdown、text、code 和 unsupported 四种预览状态。
5. 实现关闭、收起、Escape、切换文档和切换会话行为。
6. 确认抽屉打开时不造成全局横向滚动。
7. 确认关闭抽屉后主对话恢复原布局宽度。

### Task 6: Extend execution transparency projection

**Files:**

- Modify: `src/management/interaction-trace.ts`
- Modify: `src/session/interaction-trace-stream.ts`
- Modify: `src/session/conversation-session.ts`
- Modify: `src/session/metaclaw-session.ts`
- Modify: `src/management/execution-projector.ts`
- Modify: `src/management/web-conversation-projector.ts`
- Modify: `web/src/api/types.ts`
- Modify: `web/src/api/session-types.ts`
- Modify: `web/src/App.tsx`
- Create: `web/src/components/LiveExecutionPanel.tsx`
- Modify: `web/src/components/ConversationTurn.tsx`
- Modify: `web/src/components/TrajectoryView.tsx`
- Modify: `web/src/styles.css`
- Test: `tests/session/planning-kernel-path.test.ts`
- Test: `tests/session/interaction-trace-stream.test.ts`
- Test: `tests/management/server.test.ts`

**Steps:**

1. 将 Kernel 已授权 binding 投影为用户可读的 Executor/Harness/Provider/Model 名称。
2. 在 dispatch、launch、progress、verification、publication 和 completion 边界追加安全 trace event。
3. 保持 event sequence 单调递增和 event ID 可重放。
4. 多 Subtask 并发时按 `subtaskId` 分组，不能覆盖其他 Subtask 的状态。
5. 前端增加当前执行卡片和步骤列表。
6. 完成后将实时卡片折叠为执行摘要，Trajectory 继续保留完整事件。
7. 测试 trace snapshot、delta、断线重连和超过事件上限时的行为。

### Task 7: Fix IME-aware Enter behavior

**Files:**

- Modify: `web/src/components/Composer.tsx`
- Modify: `web/src/styles.css`
- Create: `tests/web/composer-ime.test.tsx` or repository-equivalent Web component test
- Modify: `tests/e2e/` browser test suite

**Steps:**

1. 增加 `compositionstart` 和 `compositionend` 状态跟踪。
2. 在 `keydown` 中检查 `event.nativeEvent.isComposing`、内部 composition ref 和 `keyCode === 229`。
3. IME 合成期间的 Enter 不调用 `preventDefault()`，不触发发送。
4. 非合成状态的普通 Enter 发送。
5. `Shift+Enter` 保持换行。
6. `Ctrl+Enter`/`Cmd+Enter` 支持显式发送。
7. 确保 form submit、键盘发送和鼠标发送不会重复提交。
8. 增加键盘提示 `Enter 发送 · Shift+Enter 换行`。

## 5. Compatibility And Security

### Existing artifacts

历史任务继续保留现有数据库事实。读取历史 artifact 时：

- 文件存在：生成新的安全 projection，必要时复制到当前用户 Workspace。
- 文件不存在：显示“历史产物不可用”。
- 前端不显示旧的内部绝对路径。
- 不移动或删除内部 Git worktree。

### Existing Markdown preview

[src/integrations/markdown-preview.ts](../../src/integrations/markdown-preview.ts) 继续支持现有外部 Markdown preview 链接，但 allowed root 必须使用捕获的启动目录，并只允许 `metaclaw-tasks` 下的已发布 Markdown 文件。

### Security rules

- 所有用户产物路径通过 `resolve`、`relative` 和 realpath 校验。
- 禁止符号链接作为 artifact 来源或目标。
- Web 只接受 artifact ID。
- preview/download 必须执行 Account 和 Task 归属检查。
- trace 继续使用现有敏感字段过滤和文本截断。
- 不把完整内部 revision、binding fingerprint、命令、日志和凭据发送给浏览器。

## 6. End-to-End Acceptance

必须增加并通过以下桌面浏览器场景：

1. 从临时目录启动 AnyFusion，生成 Markdown 报告。
2. 报告最终位于 `<启动目录>/metaclaw-tasks/<task>/`，而不是账户内部深层目录。
3. 对话中的报告链接打开右侧预览抽屉。
4. Markdown 内容、标题、任务名称和文件信息正确显示。
5. 关闭或收起抽屉后主对话恢复全宽且页面无横向滚动。
6. 连续点击两个 artifact 时，预览内容正确切换。
7. 切换会话后，旧会话的预览不会残留。
8. Executor 路由、启动、步骤、校验、发布和完成事件以 WebSocket delta 流式显示。
9. 页面显示实际 Executor、Harness、Provider、Model 和当前步骤。
10. 多 Subtask 并发时执行卡片互不串线。
11. WebSocket 断线重连后，trace snapshot 恢复当前执行摘要和事件历史。
12. `../`、绝对路径、符号链接和未授权 artifact ID 全部被拒绝。
13. 中文输入法合成期间按 Enter 不发送，只确认候选词。
14. 普通英文输入按 Enter 发送，Shift+Enter 换行，Ctrl/Cmd+Enter 强制发送。
15. 输入法确认后不会出现重复发送。
16. 历史 artifact 可查看；旧文件缺失时显示可理解的不可用状态。
17. Feishu 现有 Markdown preview 和 artifact delivery 不回归。

最终验证命令：

```text
npm run lint
npm run build
cd web && npm run build
RUN_BROWSER_E2E=1 npm test -- tests/e2e/
npm test
git diff --check
```

SQLite migration、POSIX path 和完整跨平台运行时测试按仓库既有规则在 Docker 中执行：

```text
docker build -f Dockerfile.test -t metaclaw-test .
docker run --rm metaclaw-test
```

## 7. Delivery Boundaries

本方案完成后，用户可见行为应满足：

- 用户只看到启动目录下的任务产物，不看到内部执行 workspace。
- 生成文档可以在当前 Web 工作台右侧直接预览和关闭。
- Executor 执行不是黑盒，用户能看到实际路由和安全的执行步骤。
- 中文输入法回车确认不会误发消息。

本方案不改变：

- Planner、Kernel、Runtime 和 Executor 的所有权边界。
- Provider/Model 热激活和 Auto routing 语义。
- 新增 Executor 或 Executor 热插拔机制。
- 内部 Git publication、retry、fallback 和 recovery 策略。
