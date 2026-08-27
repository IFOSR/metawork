# Workspace-Scoped Conversation Organization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Status:** Approved; not started

**Plan date:** 2026-08-27

**Review completed:** 2026-08-27; no product decisions remain open.

**Design:** [MetaWork Workspace 级 Conversation 组织设计](2026-08-27-workspace-scoped-conversation-organization-design.md)

**Goal:** 把 Workspace 建成 Account 下稳定的一级 Conversation 容器，让 TUI、
Web 和飞书进入同一 Workspace 后共享 Conversation 目录、历史摘要和运行状态，同时
保留每个 Conversation 的独立历史、回放、执行轨迹和实时事件。

**Architecture:** 新增 Account-scoped Workspace Catalog 和 Workspace Directory
Application service，以不可变 `workspaceId` 组织 Conversation。Conversation
format 升级到 v3，第一条普通用户 Query 后锁定 Workspace binding；Gateway v2
增加 Workspace selection、Workspace directory snapshot/delta 和 Workspace 下
Conversation create/attach，具体 Conversation 继续使用现有详细事件流。

**Tech Stack:** Node 22.19+, TypeScript ESM, atomic JSON persistence, Unix socket
JSONL, loopback HTTP/WebSocket, React/Vite, vendored AnyFusion-Pi TUI, Feishu
adapter, Vitest.

---

## 0. 实施约束

- 必须先落地 ADR-0035，再修改生产行为。
- 保持 ADR-0020 依赖方向；UI、Gateway adapter 和 Feishu adapter 不直接读取
  persistence。
- AccountRuntime 继续是 Kernel、Task、Execution、recovery 和 event publication
  的唯一 Runtime owner。
- WorkspaceDirectory 只拥有 Workspace identity、Conversation 目录和 activity
  projection，不调度任务。
- `workspaceId` 是产品身份；path 只是不受信任输入经 Server 确认后的本机绑定。
- 同一 Account、同一 available canonical path 只能有一个 active Workspace。
- 第一条普通用户 Query 准入后，Conversation Workspace binding 不可变。
- `/workspace <path>` 改为选择 Client/transport binding 的当前 Workspace，不得
  静默搬迁已有历史 Conversation。
- Conversation 详细历史只在 attach 后 replay；Workspace 首页只接收有界摘要。
- Web 当前 Conversation、Trajectory、Execution、Artifact、Settings 和 Composer
  必须保持现有展示与交互。
- `accounts/<id>/workspace-store/` 继续只用于 Executor managed workspaces；产品
  Workspace Catalog 使用独立 `workspace-catalog/`。
- Conversation v3 migration 必须原子、幂等、可恢复，不进入长期双读双写。
- Gateway root 和 vendored AnyFusion-Pi mirror 必须在同一提交切换协议。
- 每个生产改动先写失败测试、确认 RED，再写最小实现、确认 GREEN。
- 每个任务完成后使用 Conventional Commit。

## Task 1: 固定 ADR 和当前权威文档

**Files:**

- Create: `docs/adr/0035-workspace-scoped-conversation-organization.md`
- Modify: `docs/adr/0031-account-runtime-and-unified-client-gateway.md`
- Modify: `docs/adr/0034-independent-server-and-client-process-lifecycle.md`
- Modify: `docs/adr/README.md`
- Modify: `CONTEXT.md`
- Modify: `docs/current/account-runtime-and-gateway-operations.md`
- Modify: `docs/current/technical-overview.md`
- Modify: `docs/current/technical-overview.zh-CN.md`
- Modify: `AGENTS.md`

**Step 1: 创建 ADR-0035**

ADR 必须接受以下层级：

```text
AccountRuntime
  -> WorkspaceDirectory
    -> Workspace
      -> Conversations
```

并明确：

- Workspace 是产品组织和查询边界，不是 Runtime/Kernel ownership boundary；
- Conversation 仍是 Planner history、mailbox、trace 和 detailed replay boundary；
- `workspaceId` 不可变，canonical path 不是 identity；
- Conversation 第一条普通 Query 后 binding locked；
- `/workspace` 选择 Client Workspace，不 reparent 历史 Conversation；
- Workspace directory 只返回有界摘要；
- 详细事件仍按 Conversation attach；
- Account 单 Task 规则不变。

**Step 2: 修订 ADR-0031 与 ADR-0034**

ADR-0031 的固定层级增加 WorkspaceDirectory，并把 Conversation resolution 改成：

```text
authorize Account
  -> resolve/select Workspace
  -> create or attach Conversation within that Workspace
```

ADR-0034 保留 Server Workspace-neutral、Client cwd hint 和 path-free Web
bootstrap，但把 cwd hint 目标从“初始化新 Conversation path”改为“选择/创建
Workspace”。

**Step 3: 更新当前文档**

删除以下过时表述：

- Workspace path 是 Conversation 可变所有权；
- `/workspace` 会修改有历史 Conversation；
- Account 下只有扁平 Conversation catalog；
- Web-local session catalog 是会话目录权威。

增加 Workspace Catalog、Conversation immutable binding、Workspace directory
events、Client active Workspace 和迁移规则。

**Step 4: 检查文档一致性**

Run:

```bash
rg -n "Conversation-scoped Workspace|Conversation Workspace|/workspace|workspaceId|WorkspaceDirectory" \
  AGENTS.md CONTEXT.md docs/adr docs/current
```

Expected: 当前权威文档都采用 ADR-0035 语义；旧的安全 launch hint 规则仍保留。

**Step 5: 提交**

```bash
git add AGENTS.md CONTEXT.md docs/adr docs/current
git commit -m "docs: define workspace-scoped conversation organization"
```

## Task 2: 新增 Workspace Domain 和 Catalog Store

**Files:**

- Create: `src/workspace/workspace-types.ts`
- Create: `src/workspace/workspace-catalog-store.ts`
- Create: `src/storage/file-workspace-catalog-store.ts`
- Modify: `src/account/account-paths.ts`
- Create: `tests/workspace/workspace-types.test.ts`
- Create: `tests/storage/file-workspace-catalog-store.test.ts`
- Test: `tests/account/account-paths.test.ts`

**Step 1: 写失败的 Workspace identity 测试**

覆盖：

```ts
expect(isValidWorkspaceId('workspace_01abc')).toBe(true);
expect(isValidWorkspaceId('../escape')).toBe(false);
expect(normalizeWorkspaceDisplayName('  MetaWork  ')).toBe('MetaWork');
```

定义核心类型：

```ts
export type WorkspaceId = string;

export interface WorkspaceRecord {
  readonly id: WorkspaceId;
  readonly accountId: string;
  readonly displayName: string;
  readonly canonicalPath: string;
  readonly availability: 'available' | 'unavailable';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdByPrincipal: string;
  readonly archived: boolean;
}
```

**Step 2: 写失败的 File store 测试**

证明：

- initialize 创建 versioned empty catalog；
- write/read 原子 round-trip；
- duplicate active canonical path 被拒绝；
- invalid record 被 quarantine；
- path traversal workspace ID 被拒绝；
- mode 为 `0700`，文件为 `0600`；
- archived record 可读但不出现在默认 active list；
- unavailable record 保留 canonical/last-known path。

**Step 3: 运行测试确认 RED**

Run:

```bash
npx vitest run \
  tests/workspace/workspace-types.test.ts \
  tests/storage/file-workspace-catalog-store.test.ts \
  tests/account/account-paths.test.ts
```

Expected: FAIL，因为 Workspace Catalog 类型、store 和 account path 尚不存在。

**Step 4: 实现最小 Catalog**

在 `AccountPaths` 增加：

```ts
readonly workspaceCatalog: string;
```

路径固定为：

```text
accounts/<account-id>/workspace-catalog/
```

Store port 只提供：

```ts
initialize(): Promise<void>;
readCatalog(): Promise<WorkspaceCatalogFile>;
writeCatalog(catalog: WorkspaceCatalogFile): Promise<void>;
findById(id: WorkspaceId): Promise<WorkspaceRecord | null>;
findByCanonicalPath(path: string): Promise<WorkspaceRecord | null>;
```

不要把业务级 select/create policy 写进 Storage adapter。

**Step 5: 运行测试确认 GREEN**

Run: Task 2 Step 3 的命令。

Expected: PASS。

**Step 6: 提交**

```bash
git add src/workspace src/storage/file-workspace-catalog-store.ts \
  src/account/account-paths.ts tests/workspace tests/storage tests/account/account-paths.test.ts
git commit -m "feat(workspace): add account workspace catalog"
```

## Task 3: Conversation v3 和幂等迁移

**Files:**

- Modify: `src/session/conversation-store.ts`
- Modify: `src/session/file-conversation-store.ts`
- Create: `src/workspace/workspace-conversation-migrator.ts`
- Modify: `src/account/account-runtime-factory.ts`
- Modify: `src/server/server-composition.ts`
- Test: `tests/session/file-conversation-store.test.ts`
- Create: `tests/workspace/workspace-conversation-migrator.test.ts`
- Test: `tests/installation/composition-runtime.test.ts`

**Step 1: 写失败的 v3 normalize 测试**

Conversation metadata 改成：

```ts
export interface ConversationWorkspaceBinding {
  readonly workspaceId: WorkspaceId;
  readonly boundAt: string;
  readonly boundByPrincipal: string;
}

export interface ConversationMetadata {
  // existing fields
  readonly workspaceBinding: ConversationWorkspaceBinding | null;
}
```

测试必须证明 v3 不写 legacy `workspace`。

**Step 2: 写失败的迁移测试**

场景：

1. 两个 v2 Conversation 使用同一 canonical path，迁移后共享一个 workspaceId；
2. 不同 path 生成不同 workspaceId；
3. path 不存在时生成 `availability: unavailable` Workspace；
4. `workspace: null` 保持 `workspaceBinding: null`；
5. catalog 与 record 同步升级；
6. 中途写入失败时保留 v2 权威文件；
7. migration journal 恢复 prepared transaction；
8. 重跑迁移不生成新的 Workspace ID；
9. Web presentation records 不成为 Workspace identity 输入。

**Step 3: 运行测试确认 RED**

Run:

```bash
npx vitest run \
  tests/session/file-conversation-store.test.ts \
  tests/workspace/workspace-conversation-migrator.test.ts \
  tests/installation/composition-runtime.test.ts
```

Expected: FAIL，因为 format v3 和 migrator 尚不存在。

**Step 4: 实现 v3 与 migration transaction**

要求：

- `CONVERSATION_FORMAT_VERSION = 3`；
- v1/v2 只在 migration reader 中接受；
- Workspace ID 使用注入的 `createWorkspaceId()`，测试中固定；
- migration journal 写入 `workspace-catalog/migration.json`；
- prepared files fsync 后再原子切换；
- commit 后 runtime 只读 v3；
- migration 失败阻止 AccountRuntime 激活。

**Step 5: 运行测试确认 GREEN**

Run: Task 3 Step 3 的命令。

Expected: PASS。

**Step 6: 提交**

```bash
git add src/session src/workspace/workspace-conversation-migrator.ts \
  src/account/account-runtime-factory.ts src/server/server-composition.ts \
  tests/session tests/workspace tests/installation/composition-runtime.test.ts
git commit -m "feat(workspace): migrate conversations to workspace bindings"
```

## Task 4: 实现 WorkspaceDirectory 和 binding lock

**Files:**

- Create: `src/workspace/workspace-directory-service.ts`
- Create: `src/workspace/workspace-conversation-projector.ts`
- Modify: `src/workspace/conversation-workspace-service.ts`
- Modify: `src/session/conversation-session.ts`
- Modify: `src/session/conversation-runtime-port.ts`
- Modify: `src/session/conversation-registry.ts`
- Create: `tests/workspace/workspace-directory-service.test.ts`
- Test: `tests/workspace/conversation-workspace-service.test.ts`
- Test: `tests/session/conversation-session.test.ts`
- Test: `tests/session/conversation-registry.test.ts`

**Step 1: 写失败的 select/create 测试**

目标 API：

```ts
interface WorkspaceDirectoryPort {
  selectByPath(path: string, principalId: string): Promise<WorkspaceSelectionResult>;
  listWorkspaces(principalId: string): Promise<WorkspaceSummary[]>;
  listConversations(
    workspaceId: string,
    principalId: string,
    page: WorkspaceConversationPageRequest,
  ): Promise<WorkspaceConversationPage>;
  createConversation(
    workspaceId: string,
    principalId: string,
  ): Promise<ConversationMetadata>;
}
```

测试证明：

- same realpath 返回 same workspaceId；
- unauthorized/unavailable/archived fail closed；
- new Conversation 在一次 operation 中写 workspace binding；
- default page size 50、maximum 100；
- activity-first + updatedAt + ID 稳定排序；
- archived 默认隐藏；
- search 默认只搜当前 Workspace。

**Step 2: 写失败的 binding lock 测试**

证明：

- 空 Conversation 可以 rebind；
- 第一条普通 user message 准入后返回 `workspace_binding_locked`；
- slash command 不锁定 binding；
- attach 恢复原 workspaceId；
- busy Conversation 不能 archive/delete/rebind；
- 每个 admitted Turn 保留 workspaceId + canonical path。

**Step 3: 运行测试确认 RED**

Run:

```bash
npx vitest run \
  tests/workspace/workspace-directory-service.test.ts \
  tests/workspace/conversation-workspace-service.test.ts \
  tests/session/conversation-session.test.ts \
  tests/session/conversation-registry.test.ts
```

Expected: FAIL。

**Step 4: 实现最小 Application service**

`ConversationWorkspaceService` 不再把 path 直接写入 Conversation。它只保留
legacy migration/empty-conversation binding 的窄接口：

```ts
bindEmptyConversation(
  workspaceId: WorkspaceId,
  principalId: string,
): Promise<WorkspaceBindingResult>;
```

`WorkspaceDirectoryService` 负责 path selection、Workspace create/find、Conversation
create/list/archive/delete。`WorkspaceConversationProjector` 只消费 ports，不读取具体
SQLite 或 File store。

**Step 5: 运行测试确认 GREEN**

Run: Task 4 Step 3 的命令。

Expected: PASS。

**Step 6: 提交**

```bash
git add src/workspace src/session tests/workspace tests/session
git commit -m "feat(workspace): add workspace directory and binding lock"
```

## Task 5: Gateway v2 Workspace control 和目录事件

**Files:**

- Modify: `src/gateway/client-protocol.ts`
- Modify: `src/gateway/client-events.ts`
- Modify: `src/gateway/client-gateway.ts`
- Modify: `src/gateway/conversation-resolver.ts`
- Modify: `src/gateway/conversation-gateway-runtime.ts`
- Modify: `src/gateway/server.ts`
- Modify: `src/gateway/protocol.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/gateway-protocol.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/gateway-client.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/gateway-socket-transport.ts`
- Test: `tests/gateway/client-protocol.test.ts`
- Test: `tests/gateway/client-events.test.ts`
- Test: `tests/gateway/client-gateway.test.ts`
- Test: `tests/gateway/conversation-resolver.test.ts`
- Test: `tests/gateway/conversation-gateway-runtime.test.ts`
- Test: `tests/gateway/native-tui-gateway.test.ts`
- Test: `tests/architecture/current-client-runtime-topology.test.ts`

**Step 1: 写失败的协议测试**

Gateway protocol 升级到 v2，并区分两类 scope：

```ts
type GatewayScope =
  | { kind: 'workspace' }
  | { kind: 'conversation'; selection: ConversationSelection };
```

新增 command：

```ts
type WorkspaceGatewayCommand =
  | { kind: 'select_workspace'; path: string }
  | { kind: 'list_workspace_conversations'; workspaceId: string; cursor?: string; query?: string }
  | { kind: 'create_conversation'; workspaceId: string }
  | { kind: 'archive_conversation'; conversationId: string };
```

Conversation `new` selection 必须携带 Server-authorized workspaceId；attach 时验证
Conversation 属于目标 Workspace。

测试拒绝：

- workspace command 带 conversation-only fields；
- conversation command 缺 workspace binding；
- Client 注入 accountId、Principal、canonical path metadata 或 activity；
- v1 envelope；
- root/mirror 协议不一致。

**Step 2: 写失败的 Workspace directory 事件测试**

新增事件：

```text
workspace_directory_snapshot
workspace_conversation_upserted
workspace_conversation_removed
workspace_activity_changed
workspace_availability_changed
```

证明：

- 事件有 accountId/workspaceId，Conversation delta 有 conversationId；
- payload 有界、脱敏；
- Workspace subscriber 不收到 final answer/result chunks/trace；
- Conversation attach subscriber 继续收到现有详细事件；
- stale cursor 回退到 Workspace directory snapshot；
- duplicate delta 被 eventId 去重。

**Step 3: 运行测试确认 RED**

Run:

```bash
npx vitest run \
  tests/gateway/client-protocol.test.ts \
  tests/gateway/client-events.test.ts \
  tests/gateway/client-gateway.test.ts \
  tests/gateway/conversation-resolver.test.ts \
  tests/gateway/conversation-gateway-runtime.test.ts \
  tests/gateway/native-tui-gateway.test.ts \
  tests/architecture/current-client-runtime-topology.test.ts
```

Expected: FAIL。

**Step 4: 实现协议 hard cut**

- 同一 release 同时修改 root 与 vendored mirror；
- endpoint manifest protocol version 改为 2；
- Server 拒绝旧 Client，不增加长期 compatibility parser；
- `select_workspace` 完成后把选择保存在 authenticated ClientConnection；
- Feishu binding 由后续任务持久化选择；
- Conversation command 使用当前/显式 workspaceId resolve；
- directory subscribe 和 Conversation attach 使用独立 subscription filter；
- Workspace command admission 仍使用 requestId/idempotencyKey 和 durable admission。

**Step 5: 运行测试确认 GREEN**

Run: Task 5 Step 3 的命令。

Expected: PASS。

**Step 6: 提交**

```bash
git add src/gateway planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion \
  tests/gateway tests/architecture/current-client-runtime-topology.test.ts
git commit -m "feat(gateway): add workspace-scoped client protocol"
```

## Task 6: AccountRuntime activity projection 和 composition

**Files:**

- Modify: `src/account/account-runtime-ports.ts`
- Modify: `src/account/account-runtime.ts`
- Modify: `src/account/account-runtime-composition.ts`
- Modify: `src/account/account-runtime-factory.ts`
- Modify: `src/server/server-composition.ts`
- Create: `src/workspace/conversation-activity-projector.ts`
- Test: `tests/account/account-runtime.test.ts`
- Test: `tests/architecture/unified-server-composition.test.ts`
- Create: `tests/workspace/conversation-activity-projector.test.ts`

**Step 1: 写失败的 activity projection 测试**

状态优先级：

```text
blocked > executing > waiting > planning > idle
```

测试证明：

- active Planner turn -> planning；
- active attempt/task -> executing；
- Kernel retry/capacity wait -> waiting；
- blocked Task -> blocked；
- terminal/no active work -> idle；
- activity 带 bounded taskId 和 updatedAt；
- 状态来源为 AccountRuntime facts，不读取 UI state；
- origin Conversation 决定 activity 归属；
- restart 后从 durable facts 恢复。

**Step 2: 运行测试确认 RED**

Run:

```bash
npx vitest run \
  tests/workspace/conversation-activity-projector.test.ts \
  tests/account/account-runtime.test.ts \
  tests/architecture/unified-server-composition.test.ts
```

Expected: FAIL。

**Step 3: 实现 composition**

AccountRuntime 构造一次：

```text
FileWorkspaceCatalogStore
WorkspaceDirectoryService
ConversationActivityProjector
WorkspaceDirectory event publisher
```

ConversationSession 通过窄 port 通知 title/turn/activity changes。Workspace
projector 查询 AccountRuntime/Task facts，不 import UI、HTTP 或 platform adapter。

**Step 4: 运行测试确认 GREEN**

Run: Task 6 Step 2 的命令。

Expected: PASS。

**Step 5: 提交**

```bash
git add src/account src/server src/workspace tests/account tests/architecture \
  tests/workspace/conversation-activity-projector.test.ts
git commit -m "feat(runtime): project workspace conversation activity"
```

## Task 7: 收敛 Web 会话目录权威

**Files:**

- Modify: `src/management/web-session-runtime-types.ts`
- Modify: `src/management/web-session-types.ts`
- Modify: `src/management/web-gateway-session-runtime.ts`
- Modify: `src/management/web-session-catalog.ts`
- Create: `src/storage/file-conversation-presentation-store.ts`
- Delete after migration: `src/storage/file-web-session-store.ts`
- Modify: `src/management/server.ts`
- Modify: `src/server/server-composition.ts`
- Test: `tests/management/web-gateway-session-runtime.test.ts`
- Test: `tests/management/web-session-catalog.test.ts`
- Test: `tests/storage/file-web-session-store.test.ts`
- Test: `tests/management/server.test.ts`

**Step 1: 写失败的 single-authority 测试**

证明：

- Workspace/Conversation list 来自 WorkspaceDirectory；
- Web 不持久化第二份 Conversation metadata catalog；
- Web presentation store 只保存 safe rich turns/trace/artifact projection；
- active Conversation 属于 Web Client session，不是 Account-global
  `session.active`；
- 两个 Web Client 可以选择不同 Workspace/Conversation；
- title/archive/delete 从统一 ConversationStore 投影；
- create 在 active workspaceId 下原子完成；
- Web list API 分页并限定 Workspace。

**Step 2: 写失败的 HTTP contract 测试**

目标 endpoints：

```text
GET  /api/workspaces
POST /api/workspaces/select
GET  /api/workspaces/:workspaceId/conversations
POST /api/workspaces/:workspaceId/conversations
GET  /api/conversations/:conversationId
POST /api/conversations/:conversationId/attach
DELETE /api/conversations/:conversationId
```

旧 `/api/sessions` 内部 API 在同一 Web release 中删除，不保留双 API。

**Step 3: 运行测试确认 RED**

Run:

```bash
npx vitest run \
  tests/management/web-gateway-session-runtime.test.ts \
  tests/management/web-session-catalog.test.ts \
  tests/storage/file-web-session-store.test.ts \
  tests/management/server.test.ts
```

Expected: FAIL。

**Step 4: 实现最小切换**

- `WebSessionCatalog` 收敛为 WorkspaceDirectory/ConversationStore adapter；
- rich presentation store 以 conversationId 为 key，不拥有 catalog；
- Web auth session 保存 activeWorkspaceId/activeConversationId；
- launch context 只携带 path hint 和 optional conversationId；
- direct attach 用 Conversation binding 恢复 Workspace；
- no active Conversation 时允许 Workspace home；
- 完成迁移后删除 `FileWebSessionStore` catalog 权威。

**Step 5: 运行测试确认 GREEN**

Run: Task 7 Step 3 的命令。

Expected: PASS。

**Step 6: 提交**

```bash
git add src/management src/storage src/server tests/management tests/storage
git commit -m "refactor(web): use the workspace conversation directory"
```

## Task 8: Web Workspace 导航与现有体验保护

**Files:**

- Modify: `web/src/api/session-types.ts`
- Modify: `web/src/api/types.ts`
- Modify: `web/src/api/http.ts`
- Modify: `web/src/api/ws.ts`
- Modify: `web/src/App.tsx`
- Create: `web/src/components/WorkspaceSelector.tsx`
- Modify: `web/src/components/SessionSidebar.tsx`
- Modify: `web/src/components/WorkspaceShell.tsx`
- Modify: `web/src/components/WorkspaceHeader.tsx`
- Modify: `web/src/styles.css`
- Test: `tests/web/workspace-shell.test.ts`
- Test: `tests/web/conversation-view.test.ts`
- Test: `tests/web/trajectory-view.test.ts`
- Test: `tests/e2e/settings-workbench-browser.test.ts`
- Create: `tests/e2e/workspace-conversation-directory-browser.test.ts`

**Step 1: 写失败的 Web model 测试**

覆盖：

- Workspace selector 展示 displayName/path/availability；
- sidebar 只显示 active Workspace conversations；
- running/planning/waiting/blocked 状态可见；
- search 只查当前 Workspace；
- new Conversation 使用 active workspaceId；
- attach Conversation 自动切换 Workspace；
- Workspace home 不要求 active Conversation；
- Settings、Composer、Trajectory、Artifact props 保持原契约。

**Step 2: 写失败的真实浏览器测试**

浏览器 fixture 同时启动两个 Web sessions：

1. 两端选择同一 Workspace；
2. A 创建 Conversation；
3. B 收到目录 upsert；
4. A 进入 running；
5. B 看到 running badge，但没有收到 A 的完整 trace/result；
6. B attach 后收到 replay 和后续详细事件；
7. A 切换 Workspace 不改变 B 的 active Workspace；
8. Settings workbench 视觉和交互回归保持通过；
9. 1440px 和 mobile viewport 无横向溢出。

**Step 3: 运行测试确认 RED**

Run:

```bash
npx vitest run \
  tests/web/workspace-shell.test.ts \
  tests/web/conversation-view.test.ts \
  tests/web/trajectory-view.test.ts

npm run build --prefix web

RUN_BROWSER_E2E=1 npx vitest run \
  tests/e2e/workspace-conversation-directory-browser.test.ts \
  tests/e2e/settings-workbench-browser.test.ts
```

Expected: 新测试 FAIL，现有 Web tests 仍可运行。

**Step 4: 实现 UI**

保留当前 Conversation 主视图。只在 sidebar 顶部加入 Workspace selector，
Conversation row 增加 Server-derived activity label。Workspace 无 Conversation 时
展示清晰 empty state 和“新建会话”。

不得：

- 合并多 Conversation 内容；
- 在 Workspace home 拉取每个 Conversation detail；
- 用客户端 spinner 覆盖 Server activity；
- 改写 Settings、Trajectory、Artifact 或 Composer 信息结构。

**Step 5: 运行测试确认 GREEN**

Run: Task 8 Step 3 的全部命令。

Expected: PASS。

**Step 6: 提交**

```bash
git add web/src tests/web tests/e2e
git commit -m "feat(web): organize conversations by workspace"
```

## Task 9: TUI Workspace home 和 Conversation attach

**Files:**

- Modify: `src/client/tui-client-launcher.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/gateway-client.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/gateway-socket-transport.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/anyfusion-client-mode.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/metawork-client-model.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/metawork-client-reducer.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/metawork-client-view.ts`
- Create: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/components/metawork-conversation-selector.ts`
- Test: `tests/client/tui-client-launcher.test.ts`
- Test: `tests/gateway/native-tui-gateway.test.ts`
- Test: `tests/integration/independent-client-lifecycle.integration.test.ts`
- Test: vendored AnyFusion-Pi client reducer/view tests at the owning package seam

**Step 1: 写失败测试**

证明：

- cwd hint 选择 Workspace，不自动创建 Conversation；
- TUI 收到 directory snapshot 后显示 recent/running；
- `n` 创建 Conversation；
- Enter attach selected Conversation；
- `/conversations` 打开 selector；
- `/conversation <id>` 只 attach 当前 Workspace/已授权 Conversation；
- `/workspace <path>` 切换 Workspace，不移动当前历史；
- `--conversation <id>` 直接 attach 并恢复它的 Workspace；
- workspace delta 更新列表但不写聊天 transcript；
- attached Conversation detailed event rendering 不回归。

**Step 2: 运行测试确认 RED**

Run:

```bash
npx vitest run \
  tests/client/tui-client-launcher.test.ts \
  tests/gateway/native-tui-gateway.test.ts \
  tests/integration/independent-client-lifecycle.integration.test.ts

npm test --prefix planner/AnyFusion-Pi -- --runInBand
```

Expected: FAIL。

**Step 3: 实现最小 TUI flow**

TUI model 分开保存：

```text
workspaceDirectory
activeWorkspaceId
conversationSummaries
activeConversationId
conversationTranscript
```

Workspace directory 状态不得写进 Planner transcript。Selector 使用 current
AnyFusion-Pi interactive component patterns，不恢复 Ink standby UI。

**Step 4: 运行测试确认 GREEN**

Run: Task 9 Step 2 的命令。

Expected: PASS。

**Step 5: 提交**

```bash
git add src/client planner/AnyFusion-Pi tests/client tests/gateway \
  tests/integration/independent-client-lifecycle.integration.test.ts
git commit -m "feat(tui): browse workspace conversations"
```

## Task 10: 飞书 Workspace/Conversation 目录

**Files:**

- Modify: `src/session/conversation-binding-repository.ts`
- Modify: `src/gateway/feishu-gateway-session-port.ts`
- Create: `src/gateway/feishu-conversation-routing.ts`
- Modify: `src/integrations/feishu-app.ts`
- Modify: `src/gateway/feishu-runtime.ts`
- Test: `tests/gateway/feishu-conversation-routing.test.ts`
- Test: `tests/gateway/feishu-gateway-session-port.test.ts`
- Test: `tests/integrations/feishu-app.test.ts`
- Test: `tests/gateway/feishu-runtime.test.ts`

**Step 1: 写失败测试**

绑定记录增加：

```text
accountId
platform/channel/thread
workspaceId | null
conversationId | null
```

测试证明：

- `/workspace path` 选择 Workspace 并返回目录；
- `/conversations` 返回有界 recent/running list；
- `/conversation id` 验证 Account + Workspace 后 attach；
- 无 active Conversation 的普通消息在 selected Workspace 创建；
- 无 Workspace 返回 `workspace_required`；
- Workspace delta 更新卡片摘要；
- 未 attach 不发送其他 Conversation 的完整 answer/trace；
- 猜测 ID、cross-account 和 cross-workspace attach fail closed；
- restart 后恢复 binding。

**Step 2: 运行测试确认 RED**

Run:

```bash
npx vitest run \
  tests/gateway/feishu-conversation-routing.test.ts \
  tests/gateway/feishu-gateway-session-port.test.ts \
  tests/integrations/feishu-app.test.ts \
  tests/gateway/feishu-runtime.test.ts
```

Expected: FAIL。

**Step 3: 实现 adapter**

Feishu adapter 只把文本命令/卡片动作归一化成 Gateway v2 command。Workspace 和
Conversation binding 由 Server repository 持久化；adapter 不访问 Workspace
Catalog 或 ConversationStore。

**Step 4: 运行测试确认 GREEN**

Run: Task 10 Step 2 的命令。

Expected: PASS。

**Step 5: 提交**

```bash
git add src/session/conversation-binding-repository.ts src/gateway \
  src/integrations tests/gateway tests/integrations
git commit -m "feat(feishu): browse workspace conversations"
```

## Task 11: 安全、恢复和模块边界

**Files:**

- Modify: `tests/architecture/no-client-runtime-ownership.test.ts`
- Modify: `tests/architecture/no-direct-client-session-paths.test.ts`
- Modify: `tests/architecture/unified-server-composition.test.ts`
- Create: `tests/security/workspace-directory-account-isolation.test.ts`
- Create: `tests/integration/workspace-directory-recovery.integration.test.ts`
- Modify: `tests/gateway/gateway-load.test.ts`
- Modify: `tests/installation/account-layout-migrator.test.ts`
- Modify: `tests/installation/source-native-updater.test.ts`

**Step 1: 写失败的边界测试**

静态检查禁止：

- Web/TUI/Feishu import Workspace Catalog store；
- Gateway import concrete file store；
- WorkspaceDirectory import Kernel/Executor adapters；
- Planner/Kernel/Executor import Gateway Workspace protocol；
- `workspace-store/` 被产品 Workspace Catalog 使用；
- Web-local catalog 再次成为 Conversation metadata authority。

**Step 2: 写失败的安全/恢复测试**

覆盖：

- Account A 不能列出/attach Account B Workspace；
- unauthorized Principal 看不到 path 和 Conversation metadata；
- path 不进入 URL/manifest/audit unsafe fields；
- stale directory cursor 返回 bounded snapshot；
- event journal compaction 保留 active/blocked summary；
- Server crash during catalog migration 恢复一致 pointer；
- update/rollback 保留 workspace-catalog 和 v3 conversations；
- unavailable Workspace 重启后仍可浏览历史但不能执行；
- 1000 Conversations 的 page/event payload 保持边界。

**Step 3: 运行测试确认 RED**

Run:

```bash
npx vitest run \
  tests/architecture/no-client-runtime-ownership.test.ts \
  tests/architecture/no-direct-client-session-paths.test.ts \
  tests/architecture/unified-server-composition.test.ts \
  tests/security/workspace-directory-account-isolation.test.ts \
  tests/integration/workspace-directory-recovery.integration.test.ts \
  tests/gateway/gateway-load.test.ts \
  tests/installation/account-layout-migrator.test.ts \
  tests/installation/source-native-updater.test.ts
```

Expected: FAIL。

**Step 4: 完成最小加固**

只修复测试暴露的 owner/boundary/recovery 问题，不增加第二个目录服务、兼容 parser
或 Client-side persistence。

**Step 5: 运行测试确认 GREEN**

Run: Task 11 Step 3 的命令。

Expected: PASS。

**Step 6: 提交**

```bash
git add src tests/architecture tests/security tests/integration tests/gateway \
  tests/installation
git commit -m "test: enforce workspace directory isolation and recovery"
```

## Task 12: Native 多 Client 验收和文档闭环

**Files:**

- Modify: `scripts/smoke-unified-gateway.mjs`
- Modify: `tests/scripts/smoke-unified-gateway.test.ts`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/README.md`
- Modify: `docs/current/account-runtime-and-gateway-operations.md`
- Modify: `docs/current/technical-overview.md`
- Modify: `docs/current/technical-overview.zh-CN.md`
- Modify: `CONTEXT.md`
- Modify: `AGENTS.md`
- Modify: `docs/plans/2026-08-27-workspace-scoped-conversation-organization-design.md`
- Modify: `docs/plans/2026-08-27-workspace-scoped-conversation-organization-implementation-plan.md`

**Step 1: 扩展 native smoke**

Smoke 必须：

1. 启动一个 persistent Server；
2. TUI client A 从 Workspace A path 启动；
3. Web client B 从同一 path 启动；
4. 两端解析到同一 workspaceId；
5. A 创建 Conversation，B 看到目录 upsert；
6. A 提交任务，B 看到 running summary；
7. B 未 attach 时不收到详细 result；
8. B attach 后收到 replay 和 live completion；
9. TUI client C 从 Workspace B path 启动且目录隔离；
10. Server restart 后目录、binding、activity 和 history 恢复；
11. 显式 `server stop` 完成 drain。

**Step 2: 运行 focused validation**

Run:

```bash
npx vitest run \
  tests/workspace \
  tests/session/file-conversation-store.test.ts \
  tests/gateway/client-protocol.test.ts \
  tests/gateway/client-gateway.test.ts \
  tests/gateway/conversation-gateway-runtime.test.ts \
  tests/management/web-gateway-session-runtime.test.ts \
  tests/client/tui-client-launcher.test.ts \
  tests/gateway/feishu-conversation-routing.test.ts \
  tests/integration/workspace-directory-recovery.integration.test.ts
```

Expected: PASS。

**Step 3: 运行浏览器与 Client smoke**

Run:

```bash
npm run build --prefix web
RUN_BROWSER_E2E=1 npx vitest run \
  tests/e2e/workspace-conversation-directory-browser.test.ts \
  tests/e2e/settings-workbench-browser.test.ts
npm run smoke:clients
npm run smoke:gateway
```

Expected: PASS。

**Step 4: 运行仓库验证**

Run:

```bash
npm run lint
npm run build
npm test
```

Expected: PASS；环境条件型 Docker/E2E skip 必须在 completion evidence 中明确。

**Step 5: Native 用户视角验收**

在隔离 `METAWORK_INSTALL_ROOT` 安装 release，执行：

```bash
metawork server start
cd /path/to/workspace-a && metawork
cd /path/to/workspace-a && metawork web
```

验证：

- Server 不启动 Client；
- TUI/Web Workspace 目录一致；
- Web 现有详细 Conversation UX 不退化；
- DeepSeek/Provider settings 等现有配置能力不受影响；
- 同 Conversation 多 Client replay/live 一致；
- Server restart 后目录恢复。

**Step 6: 更新完成状态**

设计文档和计划写入：

- Completion date；
- delivered behavior；
- migration evidence；
- focused/full/browser/native validation；
- closing commits；
- remaining non-goals。

把 `docs/README.md` 条目从 Active Delivery 移到 Completed Delivery。

**Step 7: 提交**

```bash
git add scripts tests/scripts README.md README.zh-CN.md AGENTS.md CONTEXT.md docs
git commit -m "docs: close workspace conversation organization delivery"
```

## 最终完成门

以下条件全部满足前，不得报告完成：

1. ADR-0035 accepted，ADR-0031/0034/current docs 同步。
2. Workspace Catalog 是唯一 Workspace identity authority。
3. Conversation v3 不双写 legacy path。
4. v2 migration 原子、幂等、可恢复。
5. `/workspace` 不移动有历史 Conversation。
6. TUI/Web/飞书共享 Workspace Conversation Directory。
7. 未 attach Client 不接收其他 Conversation 的详细历史/trace/result。
8. Web 当前 Conversation 详细 UX 和 Settings 不退化。
9. root/vendored Gateway protocol 同 release 切换。
10. Account isolation、path secrecy、pagination、event bounds 和 recovery 通过。
11. focused、browser、native、lint、build 和完整测试通过。
12. 文档记录 completion date、validation evidence 和 closing commits。
