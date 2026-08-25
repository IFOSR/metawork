# Web Routing Identity And Workspace Presentation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Status:** Completed。

**Completion date:** 2026-08-25

**Goal:** 使用 configuration revision 固定的用户可见路由身份修复模型名称歧义，
使用 canonical Runtime Subtask ID 消除重复执行卡片，并完成轨迹页只读布局和
浅色/深色/跟随系统主题；执行叙事使用用户标签替代超长内部 Attempt ID。

**Architecture:** Work Graph 模块拥有 proposal Subtask ID 到 Runtime Subtask ID
的纯映射；Configuration 模块拥有 Provider/Model/AgentClass/Harness 的公共名称
解析；Management 只输出安全 projection；Web 不解释内部引用、不猜测 ID
对应关系。主题和 Composer 可见性属于纯 Web presentation，不改变 Gateway、
Kernel 或 Executor 语义。

**Tech Stack:** Node 22.19+, TypeScript ESM, React 18, Vite 6, CSS variables,
Vitest, existing Chrome CDP browser E2E.

---

## 0. 实施约束

- 严格按 TDD 顺序执行：先增加失败回归，再写最小实现。
- 不修改 `AutoModelResolver` 的候选选择、评分或能力判定。
- 不修改当前模型配置来让 `code-cli-5` 通过。
- 不通过标题、数组顺序或字符串后缀启发式合并 Subtask。
- 不新增 SQLite schema；proposal/runtime ID 映射是可重复计算的纯事实。
- 不改变 AnyFusionConfigurationV2 schema；公共显示名称由 revision snapshot
  和统一的公共目录派生。
- 不改变 `attemptId` 的生成规则或任何幂等、恢复、回执关联语义。
- 不要求 Docker。生产和验收路径均为 native。
- 实施完成后不创建 Git commit，不同步 GitHub，等待用户明确指令。

## Task 1: 固定 canonical Subtask identity

**Files:**

- Create: `src/work-graph/subtask-identity.ts`
- Modify: `src/work-graph/index.ts`
- Modify: `src/execution/work-graph-runtime-service.ts`
- Test: `tests/work-graph/subtask-identity.test.ts`
- Test: `tests/execution/work-graph-runtime-service.test.ts`

**Step 1: 写失败测试**

增加以下断言：

```ts
const aliases = buildCanonicalSubtaskIdentityMap(
  'task_abc',
  1,
  [{ id: 'research' }, { id: 'render-html' }],
);

expect(aliases.get('research')).toBe('task_abc_r1_research');
expect(aliases.get('render-html')).toBe('task_abc_r1_render-html');
```

同时覆盖：

- 已经 canonical 的 ID 保持不变。
- 非安全字符执行与 Runtime 当前实现一致的规范化。
- 规范化后发生冲突时稳定追加 `_2`。
- 相同输入在 Runtime materialization 和 presentation 中得到完全相同结果。

**Step 2: 运行测试并确认失败**

```text
npm test -- tests/work-graph/subtask-identity.test.ts tests/execution/work-graph-runtime-service.test.ts
```

Expected: FAIL，公共 identity 工具尚不存在。

**Step 3: 抽取纯函数**

公共接口固定为：

```ts
export function buildCanonicalSubtaskIdentityMap(
  taskId: string,
  graphRevision: number,
  proposals: readonly Pick<WorkGraphSubtask, 'id'>[],
): ReadonlyMap<string, string>;
```

把 `WorkGraphRuntimeService` 中私有的 `buildSubtaskIdMap`、
`stableSubtaskId` 和 `normalizeSubtaskId` 收敛到该 owner。Runtime 只调用公共
函数，不保留第二份算法。

**Step 4: 运行聚焦测试**

Expected: PASS。

## Task 2: 建立统一的公共路由身份目录

**Files:**

- Create: `src/configuration/public-routing-identity.ts`
- Create: `src/configuration/public-provider-catalog.ts`
- Modify: `src/configuration/configuration-completion-service.ts`
- Modify: `src/configuration/index.ts`
- Modify: `src/index.ts`
- Modify: `src/execution/execution-transparency.ts`
- Modify: `src/execution/kernel-execution-runtime.ts`
- Modify: `src/session/conversation-session.ts`
- Modify if required for compatibility: `src/session/metaclaw-session.ts`
- Modify: `web/src/api/types.ts`
- Modify: `web/src/components/SettingsPanel.tsx`
- Delete after migration: `web/src/preset-providers.ts`
- Test: `tests/configuration/configuration-completion-service.test.ts`
- Test: `tests/execution/execution-transparency.test.ts`
- Test: `tests/session/conversation-session.test.ts`
- Test: `tests/web/settings-workbench.test.ts`

**Step 1: 写真实 modelId 回归测试**

构造 revision snapshot：

```ts
models: {
  'code-cli-5': {
    providerRef: 'code-cli',
    modelId: 'gpt-5.6-terra',
    capabilities: [],
    reasoning: 'high',
    enabled: true,
  },
}
```

断言公共身份为：

```ts
expect(identity).toMatchObject({
  providerDisplayName: 'Code CLI',
  modelDisplayName: 'gpt-5.6-terra',
  executorDisplayName: 'Codex CLI',
  harnessDisplayName: 'Codex CLI',
});
expect(JSON.stringify(identity)).not.toContain('code-cli-5');
```

再构造两个 revision，证明历史 binding 必须使用自己的 revision，不能被 active
revision 中同名 `modelRef` 的新 `modelId` 覆盖。

**Step 2: 运行测试并确认失败**

```text
npm test -- tests/configuration/configuration-completion-service.test.ts tests/execution/execution-transparency.test.ts tests/session/conversation-session.test.ts tests/web/settings-workbench.test.ts
```

Expected: FAIL，当前 `displayNameFromRef(modelRef)` 会得到错误名称。

**Step 3: 实现公共身份 resolver**

核心接口：

```ts
export interface PublicRoutingIdentity {
  executorDisplayName: string;
  harnessDisplayName: string;
  providerDisplayName: string;
  modelDisplayName: string;
}

export function resolvePublicRoutingIdentity(
  snapshot: ConfigurationSnapshot,
  binding: RevisionedAgentBinding,
): PublicRoutingIdentity;
```

解析规则：

- Model 必须由 `snapshot.config.models[binding.modelRef].modelId` 得到。
- Provider 使用统一公共 Provider Catalog 的 label。
- AgentClass/Harness 使用统一的产品名称规则，例如 `Codex CLI`、`Pi Agent`。
- revision、binding fingerprint 和内部 refs 不进入返回值。
- snapshot 或 model 缺失时返回结构化 unavailable 状态，不回退显示 `modelRef`。

**Step 4: 收敛 Provider 名称来源**

把当前 `web/src/preset-providers.ts` 的目录数据迁入 Configuration 所有者下的
`public-provider-catalog.ts`。`ConfigurationCompletionResult` 增加安全字段：

```ts
providers[providerRef].displayName
providerPresets: Array<{
  providerRef: string;
  displayName: string;
  baseUrl: string;
  modelIds: string[];
}>
```

Settings 页面改为消费后端 completion 返回的名称和 preset，不再维护另一份
Provider label 真相。自定义 Provider 使用稳定的公共 fallback 名称。

**Step 5: 替换未来 trace 的错误名称来源**

`buildExecutorDisplayFacts` 不再接受裸 binding 后自行 humanize。调用方必须传入
由绑定 revision 解析后的 `PublicRoutingIdentity`。更新 routing、dispatch、
verification 和 publication 等所有 trace 生成点。

**Step 6: 运行聚焦测试**

Expected: PASS，并证明 trace details 中出现 `gpt-5.6-terra`，不出现
`code-cli-5`。

## Task 3: 让 Work Graph projection 使用 canonical ID 和公共路由身份

**Files:**

- Modify: `src/management/work-graph-presentation-projector.ts`
- Modify: `src/management/server.ts`
- Modify: `src/index.ts`
- Modify: `web/src/api/types.ts`
- Test: `tests/management/work-graph-presentation-projector.test.ts`
- Test: `tests/management/server.test.ts`
- Test: `tests/e2e/hot-activation-auto-routing.test.ts`

**Step 1: 写失败投影测试**

输入 proposal ID `research`，Runtime fact ID `task_1_r1_research`，断言：

- projection 只有一个 node；
- node ID 使用 canonical Runtime ID；
- status、dispatch、receipt 和 publication 都落在同一个 node；
- dependency/edge 也转换为 canonical ID；
- routing 只包含公共名称和规范化候选原因。

路由断言：

```ts
expect(routing).toMatchObject({
  executorDisplayName: 'Codex CLI',
  selected: {
    providerDisplayName: 'Code CLI',
    modelDisplayName: 'gpt-5.6-sol',
  },
  rejectedCandidates: [{
    providerDisplayName: 'Code CLI',
    modelDisplayName: 'gpt-5.6-terra',
    reasonCode: 'missing_capability',
    reasonDetail: 'coding',
  }],
});
```

序列化结果不得包含 `code-cli-5`、`modelRef`、binding fingerprint 或 raw
configuration revision details。

**Step 2: 运行测试并确认失败**

```text
npm test -- tests/management/work-graph-presentation-projector.test.ts tests/management/server.test.ts tests/e2e/hot-activation-auto-routing.test.ts
```

**Step 3: 修改 projector 输入**

`WorkGraphPresentationInput` 增加：

```ts
taskId: string;
graphRevision: number;
configuration: ConfigurationSnapshot;
```

Projector 使用 Task 1 的 identity map 统一 graph、facts、decisions、dispatch、
receipts 和 publications。使用 Task 2 的 resolver 生成公共路由字段。

**Step 4: 规范化候选原因**

将 `missing_capability:coding` 拆成稳定字段：

```ts
{ reasonCode: 'missing_capability', reasonDetail: 'coding' }
```

其他原因保持稳定 code；未知 reason 使用 `unknown` 和安全摘要，不显示原始异常。

**Step 5: 运行聚焦测试**

Expected: PASS。

## Task 4: 修复实时与历史 Conversation 的重复执行卡片

**Files:**

- Create: `src/management/execution-presentation-normalizer.ts`
- Modify: `src/management/web-session-catalog.ts`
- Modify: `src/management/web-gateway-session-runtime.ts`
- Modify: `src/management/web-conversation-projector.ts`
- Modify: `src/management/web-session-types.ts`
- Modify: `src/index.ts`
- Modify: `web/src/components/LiveExecutionPanel.tsx`
- Modify: `web/src/components/ExecutionDetailDrawer.tsx`
- Test: `tests/management/web-session-catalog.test.ts`
- Test: `tests/management/web-gateway-session-runtime.test.ts`
- Test: `tests/management/web-conversation-projector.test.ts`
- Test: `tests/web/workspace-shell.test.ts`

**Step 1: 写重复卡片回归**

构造一个 turn：

- routing trace 使用 proposal ID `research`；
- execution trace/timeline 使用 `task_1_r1_research`；
- 两者标题相同。

断言规范化后所有事件均使用 `task_1_r1_research`，Web 卡片集合长度为 1，详情
抽屉同时包含 routing 和 execution 事件。

增加两个相同标题但不同 proposal ID 的 Subtask，证明实现没有按标题合并。

**Step 2: 运行测试并确认失败**

```text
npm test -- tests/management/web-session-catalog.test.ts tests/management/web-gateway-session-runtime.test.ts tests/management/web-conversation-projector.test.ts tests/web/workspace-shell.test.ts
```

**Step 3: 修复未来实时事件**

`ConversationSession` 处理 `authorize_task_plan` 时，使用 action 中的 `taskId`、
`graphRevision` 和 `workGraph` 计算 canonical ID，再写入 routing trace。
Runtime 后续事件已经使用持久化 ID，两条事件链由此一致。

**Step 4: 增加历史只读修复**

Management 增加只读 normalizer。它通过该 Task 的已授权 graph decision 计算显式
alias map，在加载历史 turn、stale-cursor replay 和 reconnect snapshot 时替换旧
proposal ID。

约束：

- 不修改历史 Kernel ledger。
- 不修改历史执行结果。
- 不按标题或后缀猜测。
- 无法获得授权 graph 时保持原事件并标记 identity unavailable，不错误合并。

**Step 5: 简化 Web 分组**

`LiveExecutionPanel` 和 `ExecutionDetailDrawer` 只接受 canonical `subtaskId`。
删除任何前端 fallback 合并逻辑；Map key、按钮选择和详情过滤使用同一 ID。

**Step 6: 运行聚焦测试**

Expected: PASS，实时、历史、重连都只有一张卡片。

## Task 5: 输出用户可读的 Attempt projection

**Files:**

- Modify: `src/management/execution-projector.ts`
- Modify: `src/management/web-session-types.ts`
- Modify: `web/src/api/types.ts`
- Test: `tests/management/execution-projector.test.ts`
- Test: `tests/management/web-session-types.test.ts`

**Step 1: 写超长 Attempt ID 回归测试**

使用与截图同类的 ID：

```text
attempt_dispatch_event_exec_int_..._primary
```

断言 Timeline projection：

```ts
expect(attempt).toMatchObject({
  attemptKind: 'primary',
  attemptOrdinal: 1,
  attemptLabel: '主执行',
  displayStatus: '已完成',
});
```

分别覆盖 `primary`、`continuation`、`fallback`、`contract_correction` 和
`merge_repair`，以及等待、运行、完成、失败和取消状态。

**Step 2: 运行测试并确认失败**

```text
npm test -- tests/management/execution-projector.test.ts tests/management/web-session-types.test.ts
```

Expected: FAIL，当前 public timeline 直接携带 `attemptId` 和内部状态。

**Step 3: 扩展内部查询并收窄公共 projection**

`ExecutionProjector` 从 dispatch/receipt 读取 `attemptKind`，按同一 Subtask 的
时间顺序计算 ordinal，并输出：

```ts
interface TimelineAttempt {
  attemptKind: KernelAttemptKind;
  attemptOrdinal: number;
  attemptLabel: string;
  displayStatus: '等待启动' | '执行中' | '已完成' | '失败' | '已取消' | '状态未知';
  startedAt?: string;
  updatedAt?: string;
  progress?: Record<string, unknown>;
  progressHistory?: TimelineProgressEntry[];
}
```

原始 `attemptId` 继续留在 Repository、Kernel、Runtime 和服务端去重逻辑，不进入
任何普通可见文本。Web timeline 可以继续携带它作为非展示 correlation key，
供历史 trace 与 durable progress 去重、详情过滤和 React identity 使用；组件不得
把它作为标签、状态、tooltip 或空值 fallback。

**Step 4: 运行聚焦测试**

Expected: PASS。

## Task 6: 重构路由卡片的信息层级

**Files:**

- Modify: `web/src/components/RoutingDecisionCard.tsx`
- Modify: `web/src/components/WorkGraphPanel.tsx`
- Modify: `web/src/components/TrajectoryView.tsx`
- Modify: `web/src/api/types.ts`
- Modify: `web/src/styles.css`
- Test: `tests/web/interaction-trace.test.ts`
- Test: `tests/web/trajectory-view.test.ts`
- Test: `tests/web/workspace-shell.test.ts`

**Step 1: 写失败 UI 契约测试**

断言普通路由卡包含：

- `Executor`；
- `最终选择`；
- `未入选模型候选`；
- 用户可读的 capability 原因。

断言源码和渲染 fixture 不出现：

- `routing.modelRef`；
- `routing.providerRef`；
- `拒绝 ${providerRef}/${modelRef}`；
- Work Graph header 中的 configuration revision；
- dependency/edge 的内部 Subtask ID。

**Step 2: 运行测试并确认失败**

```text
npm test -- tests/web/interaction-trace.test.ts tests/web/trajectory-view.test.ts tests/web/workspace-shell.test.ts
```

**Step 3: 实现新卡片**

显示结构：

```text
Codex CLI · AUTO
最终选择
Code CLI / gpt-5.6-sol · Codex CLI

未入选模型候选
Code CLI / gpt-5.6-terra
该模型未声明任务所需的 coding 能力
```

红色仅用于真正失败或整个 Executor 不可用。普通候选淘汰使用中性/琥珀色。

**Step 4: 清理普通界面的内部标识**

- Work Graph header 不显示 revision。
- dependency 和 edge 使用 Subtask title，不显示 Runtime ID。
- React key 可以使用不可见 canonical ID，但不能渲染到文字内容。
- 高级诊断不在本任务新增；现有设置页诊断保持不变。

**Step 5: 运行聚焦测试**

Expected: PASS。

## Task 7: 仅在 Conversation 显示 Composer

**Files:**

- Modify: `web/src/components/WorkspaceShell.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`
- Test: `tests/web/workspace-shell.test.ts`
- Test: `tests/web/composer-ime.test.ts`

**Step 1: 写失败测试**

断言 `WorkspaceShell` 接收明确的 `composerVisible`，且只有该值为 true 时渲染
Composer。App 传入：

```ts
composerVisible={tab === 'conversation'}
```

断言 draft 和 attachments 仍由 App state 持有，不随 tab 切换 reset。

**Step 2: 运行测试并确认失败**

```text
npm test -- tests/web/workspace-shell.test.ts tests/web/composer-ime.test.ts
```

**Step 3: 实现条件布局**

- Trajectory 不渲染 Composer DOM。
- Workspace main/canvas 自动占满释放出的高度。
- 切回 Conversation 时恢复草稿、附件和原有 IME 行为。

**Step 4: 运行聚焦测试**

Expected: PASS。

## Task 8: 实现浅色、深色和跟随系统主题

**Files:**

- Create: `web/src/theme.ts`
- Create: `web/src/components/ThemeControl.tsx`
- Modify: `web/index.html`
- Modify: `web/src/main.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/WorkspaceHeader.tsx`
- Modify: `web/src/styles.css`
- Create: `tests/web/theme.test.ts`
- Modify: `tests/web/workspace-shell.test.ts`

**Step 1: 写纯函数失败测试**

主题契约：

```ts
type ThemePreference = 'system' | 'light' | 'dark';
type ResolvedTheme = 'light' | 'dark';
```

覆盖：

- 无 localStorage 时默认 `system`。
- 非法存储值回退 `system`。
- `system + prefers dark` 得到 dark。
- 固定 light/dark 不受系统变化影响。
- preference 写入固定 key `anyfusion.theme`.

**Step 2: 运行测试并确认失败**

```text
npm test -- tests/web/theme.test.ts tests/web/workspace-shell.test.ts
```

**Step 3: 实现首屏初始化**

`web/index.html` 在应用脚本前放置最小同步初始化，给 `<html>` 设置：

```text
data-theme="light|dark"
data-theme-preference="system|light|dark"
```

同时设置 `color-scheme`，防止表单控件和滚动条与页面主题冲突。

**Step 4: 实现 ThemeControl**

Header 使用一个有明确 aria label 的三态 segmented control。只有 preference 为
`system` 时注册 `matchMedia('(prefers-color-scheme: dark)')` listener，并在
unmount 或 preference 改变时清理。

**Step 5: 收敛 CSS token**

定义两套语义 token，而不是逐组件硬编码：

```css
:root,
:root[data-theme='dark'] {
  --surface-canvas: ...;
  --surface-panel: ...;
  --surface-raised: ...;
  --text-primary: ...;
  --text-secondary: ...;
  --line-subtle: ...;
  --status-success: ...;
  --status-warning: ...;
  --status-danger: ...;
  --focus-ring: ...;
}

:root[data-theme='light'] {
  /* 对应浅色 token */
}
```

替换 Workspace、Sidebar、Conversation、Trajectory、Work Graph、Routing、
Composer、Settings、Artifact Drawer 和 Execution Drawer 中影响主题的硬编码
颜色。仅允许保留不随主题变化的语义图表色。

**Step 6: 运行 Web 测试和构建**

```text
npm test -- tests/web/theme.test.ts tests/web/workspace-shell.test.ts
cd web && npm run build
```

Expected: PASS。

## Task 9: 修复 Execution Narrative 的溢出布局

**Files:**

- Modify: `web/src/components/ExecutionNarrative.tsx`
- Modify: `web/src/styles.css`
- Test: `tests/web/conversation-view.test.ts`
- Test: `tests/web/workspace-shell.test.ts`

**Step 1: 写失败 UI 契约测试**

断言组件渲染 `attempt.attemptLabel` 和 `attempt.displayStatus`，不渲染
`attempt.attemptId`、原始 `attempt.status` 或 `terminal`。

CSS 契约至少包含：

```css
.executor-attempt > header {
  grid-template-columns: minmax(0, 1fr) max-content max-content;
}

.executor-attempt-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.executor-attempt-status,
.executor-attempt-duration {
  white-space: nowrap;
}
```

移动端 header 可切换为两行 Grid，但必须保持状态与耗时可见。

**Step 2: 运行测试并确认失败**

```text
npm test -- tests/web/conversation-view.test.ts tests/web/workspace-shell.test.ts
```

**Step 3: 实现用户标签和稳定布局**

- 第一列显示 `主执行`、`回退执行` 等用户标签。
- 第二列显示本地化状态。
- 第三列显示 elapsed duration。
- tooltip 只重复用户标签，不放原始 ID。
- 任何来自旧 fixture 的原始 `attemptId` 都不得作为 fallback 文本。

**Step 4: 运行聚焦测试**

Expected: PASS。

## Task 10: 浏览器 E2E 与全量 native 验收

**Files:**

- Create: `tests/e2e/web-routing-identity-and-theme.test.ts`
- Modify if shared fixtures are preferable: `tests/e2e/artifact-preview-and-ime.test.ts`
- Modify: `docs/current/technical-overview.md`
- Modify: `docs/current/technical-overview.zh-CN.md`
- Modify: `CONTEXT.md`
- Modify: `docs/plans/2026-08-25-web-routing-identity-and-workspace-presentation.md`
- Modify: `docs/plans/2026-08-25-web-routing-identity-and-workspace-presentation-implementation-plan.md`

**Step 1: 增加真实浏览器场景**

使用 Mock Gateway/HTTP fixture 投影：

- Codex CLI 下 `gpt-5.6-terra` 因 `missing_capability:coding` 未入选；
- `gpt-5.6-sol` 被最终选择并进入执行；
- proposal/runtime 两类旧 ID 同时存在于历史 fixture。

浏览器断言：

1. 页面显示 `Code CLI / gpt-5.6-terra`，不显示 `code-cli-5`。
2. 页面表达“未入选模型候选”，不表达“Codex CLI 被拒绝”。
3. 最终选择和实际 Executor 都显示 Codex CLI / `gpt-5.6-sol`。
4. 同一逻辑 Subtask 只有一张执行卡片，详情包含完整事件。
5. Execution Narrative 显示 `主执行` 和 `已完成` 等用户文字，不显示
   `attempt_dispatch_event_...` 或 `terminal`。
6. 超长历史 attempt fixture 下，执行标签、状态和耗时互不覆盖。
7. Trajectory 中不存在 Composer；切回 Conversation 后草稿和附件保留。
8. light/dark/system 切换、localStorage、刷新和 system media change 正确。
9. 1440x1000 与 390x844 下无横向溢出。
10. 两种主题下 routing、warning、blocked、failure 文本和 focus ring 可辨认。

**Step 2: 运行聚焦验证**

```text
npm test -- tests/work-graph/subtask-identity.test.ts
npm test -- tests/configuration/configuration-completion-service.test.ts tests/execution/execution-transparency.test.ts
npm test -- tests/management/execution-projector.test.ts tests/management/web-session-types.test.ts
npm test -- tests/management/work-graph-presentation-projector.test.ts tests/management/web-session-catalog.test.ts tests/management/web-gateway-session-runtime.test.ts
npm test -- tests/web/theme.test.ts tests/web/conversation-view.test.ts tests/web/workspace-shell.test.ts tests/web/interaction-trace.test.ts tests/web/trajectory-view.test.ts
cd web && npm run build
RUN_BROWSER_E2E=1 npm test -- tests/e2e/web-routing-identity-and-theme.test.ts
```

**Step 3: 运行全量 native 验收**

```text
npm run lint
npm run build
cd web && npm run build
npm test
RUN_BROWSER_E2E=1 npm test -- tests/e2e/
git diff --check
```

不运行 Docker；Docker 不是当前生产流程，也不是本方案验收条件。

**Step 4: 对照目标逐项审计**

在两份 2026-08-25 文档中记录：

- 实施日期；
- 每项 delivered behavior；
- 每条 acceptance criterion 的证据；
- 实际测试数量和浏览器 viewport；
- 已知残余风险；
- `Closing commit: pending user instruction`。

只有全部目标一致且测试通过后，才向用户报告“实施完成”。仍不提交代码。

## 最终停点

实施完成后的工作区应包含经过验证但未提交的代码和文档。向用户提供：

- 变更结果摘要；
- 测试结果；
- 与设计文档逐项一致性审计；
- 未提交文件清单；
- 明确说明尚未同步 GitHub。

等待用户明确要求提交或同步后再执行 Git 操作。

## Completion Record

Tasks 1-10 were delivered on 2026-08-25 in the documented order and boundaries:

- canonical Subtask identity is owned by Work Graph and shared by Runtime and
  Management;
- public routing identity and Provider presets are owned by Configuration and
  resolved from the generation-pinned revision;
- Management normalizes historical/live execution presentation and emits
  public-safe routing and Attempt fields;
- Web renders model-level candidate outcomes, user-readable Attempt labels,
  a Conversation-only Composer, and system/light/dark themes;
- the required
  `tests/e2e/web-routing-identity-and-theme.test.ts` covers historical dual IDs,
  public model names, long Attempt IDs, attachment/draft retention, theme
  persistence/system changes, readability, and desktop/mobile overflow.

Validation evidence:

```text
Focused routing, management, and Web groups: 116 passed
Full native suite: 333 files passed, 7 skipped; 1544 tests passed, 18 skipped
Full E2E suite with RUN_BROWSER_E2E=1: 5 files passed; 5 tests passed
Browser viewports: 1440x1000 and 390x844
lint: passed
root build: passed
web build: passed
git diff --check: passed
Docker: intentionally not run
```

Acceptance audit: every criterion in the approved design is covered by focused
tests or the dedicated Chrome E2E. Kernel routing policy, AutoModelResolver,
Executor selection, activation semantics, internal `attemptId` generation,
storage schema and durable ledgers are unchanged.

Residual risk: the browser fixture does not contact external model Providers;
their availability remains covered by existing configuration probe and runtime
contracts. No known acceptance gap remains.

**Closing commit:** pending user instruction

The workspace remains intentionally uncommitted and has not been synchronized
to GitHub.
