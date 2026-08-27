# Client Default Workspace And Visibility Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Status:** Approved / Ready for implementation

**Plan date:** 2026-08-27

**Review completed:** 2026-08-27; no product decisions remain open.

**Design:** [MetaWork Client 默认 Workspace 与可见性设计](2026-08-27-client-default-workspace-design.md)

**Goal:** 让新 TUI/Web Conversation 自动使用 Client 启动目录，让已有
Conversation 恢复持久 Workspace，并在 TUI、Web 和飞书中持续展示 Server 确认的
当前 Workspace。

**Architecture:** Server 保持 Workspace-neutral。TUI launcher 和 Web launcher
各自在启动时捕获一次 `process.cwd()`，把它作为不受信任的初始化提示；新
Conversation 仍通过现有 `/workspace <path>` Gateway mutation 完成
canonicalization、authorization、busy fencing、持久化和事件发布。Web 使用
mode-`0600` 本机 Unix 通道注册短时一次性 launch context，Browser URL 只携带
随机 bootstrap token，不携带 Workspace path。

**Tech Stack:** Node 22.19+, TypeScript ESM, Unix socket JSONL, loopback
HTTP/WebSocket, React, AnyFusion-Pi native TUI, Vitest.

---

## 0. 实施约束

- 先修改并提交 ADR-0034，再修改行为。
- 保持 ADR-0020 的依赖方向；Client 不 import storage、Planner、Kernel 或
  Execution。
- Server 启动不得读取或发布自己的 `process.cwd()` 作为用户 Workspace。
- Client cwd 只对新 Conversation 生效，不覆盖 attach/follow 的持久 Workspace。
- 自动默认必须复用现有 `/workspace` mutation，不新增直接 metadata write。
- `/workspace <path>` 继续是用户显式覆盖的统一命令。
- Web HTTP/WebSocket projection 必须保持当前 Web 展示字段与行为的超集。
- Workspace path 不得进入 URL query、fragment、endpoint manifest 或日志；
  fragment 只允许携带短时随机 bootstrap token。
- `src/tui/` standby Ink UI 不参与本次改造。
- 每个生产改动先写失败测试，再写最小实现。
- 每个任务完成后提交 Conventional Commit。

## Task 1: 修订 Workspace 权威契约

**Files:**

- Modify: `docs/adr/0034-independent-server-and-client-process-lifecycle.md`
- Modify: `docs/adr/README.md`
- Modify: `CONTEXT.md`
- Modify: `docs/current/account-runtime-and-gateway-operations.md`
- Modify: `docs/current/technical-overview.md`
- Modify: `docs/current/technical-overview.zh-CN.md`
- Modify: `AGENTS.md` only if onboarding/navigation text becomes inaccurate

**Step 1: 修订 ADR-0034**

将第 5 节改为以下优先级：

```text
existing persisted Conversation Workspace
  -> Client startup workspace hint for a new Conversation
  -> workspace: null and workspace_required
```

ADR 必须同时保留：

- Server startup Workspace-neutral；
- Server process cwd 不是 Workspace authority；
- Client cwd 是不受信任的新 Conversation 初始化提示；
- 默认初始化和显式覆盖使用同一 `/workspace` mutation；
- attach/follow 永不应用 startup hint；
- 校验失败保持 `workspace: null`；
- 多 Conversation、多 Client 不共享全局 Workspace。

**Step 2: 更新 authority index 和当前文档**

在 `docs/adr/README.md` 中把 ADR-0034 描述更新为“独立生命周期、Client 默认
Workspace 和 Conversation Workspace admission”的 owner。

同步修改 `CONTEXT.md`、中英文 technical overview 和 operations 文档，删除
“每个新 Conversation 必须由用户手动执行 `/workspace`”的绝对表述。

**Step 3: 检查权威文档一致性**

Run:

```bash
rg -n "workspace: null|workspace_required|process cwd|process `cwd`|/workspace /absolute/path" \
  AGENTS.md CONTEXT.md docs/adr docs/current
```

Expected: 所有当前权威文档都区分 Server cwd、Client startup hint、历史
Conversation Workspace 和显式 `/workspace` 覆盖。

**Step 4: 提交**

```bash
git add AGENTS.md CONTEXT.md docs/adr docs/current
git commit -m "docs: amend client workspace initialization contract"
```

## Task 2: 固定 Server-owned 默认初始化与事件契约

**Files:**

- Modify: `src/workspace/conversation-workspace-service.ts`
- Modify: `src/session/conversation-session.ts`
- Modify: `src/gateway/conversation-gateway-runtime.ts`
- Modify: `src/gateway/client-protocol.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/gateway-protocol.ts`
- Test: `tests/workspace/conversation-workspace-service.test.ts`
- Test: `tests/session/conversation-session.test.ts`
- Test: `tests/gateway/conversation-gateway-runtime.test.ts`
- Test: `tests/gateway/client-protocol.test.ts`

**Step 1: 写失败测试**

增加以下测试：

```ts
it('initializes an empty Conversation through the same workspace mutation', async () => {
  const result = await service.execute('/workspace /repo-a', 'local:user');
  expect(result).toMatchObject({
    status: 'changed',
    workspace: { path: '/repo-a' },
  });
});

it('does not replace an existing Workspace during default initialization', async () => {
  await seedWorkspace('/repo-a');
  await initializeDefault('/repo-b');
  expect((await service.getWorkspace())?.path).toBe('/repo-a');
});
```

同时证明：

- 自动初始化成功发布一个 `workspace_changed`；
- event payload 包含 canonical `path` 和 `selectedAt`；
- replay snapshot 在没有 live event 时也恢复 Workspace；
- 失败错误码与显式命令一致；
- `workspace_required` 仍在 Planner 启动前 fail closed；
- Gateway envelope 不接受 Client 提供 `selectedAt`、`selectedByPrincipal` 或其他
  受信 Workspace metadata。

**Step 2: 运行测试并确认失败**

Run:

```bash
npm test -- \
  tests/workspace/conversation-workspace-service.test.ts \
  tests/session/conversation-session.test.ts \
  tests/gateway/conversation-gateway-runtime.test.ts \
  tests/gateway/client-protocol.test.ts
```

Expected: FAIL，因为默认初始化幂等语义和完整 snapshot 尚未实现。

**Step 3: 实现最小 Server seam**

在 `ConversationWorkspaceService` 中提取共享的内部设置路径，供显式命令和默认
初始化共同使用。默认初始化接口只允许在当前 Workspace 为 `null` 时继续：

```ts
initializeDefault(path: string, principalId?: string): Promise<WorkspaceCommandResult>
```

它必须调用与 `execute('/workspace ...')` 相同的 canonicalization、
authorization、busy fence 和持久化逻辑。已有 Workspace 返回当前值或明确的
`unchanged` 结果，不写 store、不发布事件。

`ConversationGatewayRuntime` 在 attach/replay snapshot 中始终投影当前 Workspace，
并继续为真实变化发布 `workspace_changed`。

**Step 4: 镜像安全协议类型**

根协议和 vendored TUI 协议只增加读取 Workspace projection 所需的类型，不允许
客户端提交权威 Workspace metadata。若现有 protocol version 足以表达 additive
event payload，则保持 v1；若 wire message 发生 breaking change，则一次性升级并
同步两棵源码和 compatibility tests。

**Step 5: 运行聚焦测试**

Run: 使用 Step 2 的命令。

Expected: PASS。

**Step 6: 提交**

```bash
git add src/workspace src/session/conversation-session.ts \
  src/gateway/conversation-gateway-runtime.ts src/gateway/client-protocol.ts \
  planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/gateway-protocol.ts \
  tests/workspace tests/session/conversation-session.test.ts \
  tests/gateway/conversation-gateway-runtime.test.ts tests/gateway/client-protocol.test.ts
git commit -m "feat: add idempotent conversation workspace initialization"
```

## Task 3: 让 TUI 新 Conversation 使用启动目录

**Files:**

- Modify: `src/client/tui-client-launcher.ts`
- Test: `tests/client/tui-client-launcher.test.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/cli/args.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/main.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/anyfusion-client-mode.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/metawork-client-model.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/metawork-client-reducer.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/metawork-client-view.ts`
- Test: `planner/AnyFusion-Pi/packages/coding-agent/test/args.test.ts`
- Test: `planner/AnyFusion-Pi/packages/coding-agent/test/anyfusion-client-mode.test.ts`
- Test: `planner/AnyFusion-Pi/packages/coding-agent/test/metawork-client-reducer.test.ts`
- Test: `planner/AnyFusion-Pi/packages/coding-agent/test/metawork-client-view.test.ts`

**Step 1: 写失败的 launcher 测试**

断言：

- launcher 在构造时捕获一次注入的 startup cwd；
- vendored Client 收到 `--workspace-hint /repo-a`；
- `runUi` seam 收到同一 hint；
- `--conversation conv_1` 不改变 hint 的传递，但后续 controller 不应用它；
- launcher 不把 Workspace 放入 env 中作为 Runtime authority。

**Step 2: 运行根测试并确认失败**

Run:

```bash
npm test -- tests/client/tui-client-launcher.test.ts
```

Expected: FAIL，因为 launcher 尚未传递 `workspaceHint`。

**Step 3: 实现 launcher 和 CLI 参数**

`TuiClientLauncherDeps` 增加可测试的：

```ts
readonly startupWorkspacePath?: string;
```

默认值在 launcher 构造或 `start()` 入口捕获一次 `process.cwd()`。spawn 参数增加：

```text
--workspace-hint /absolute/client/startup/path
```

Pi `args.ts` 和 `main.ts` 只把该字段交给 client-only mode，不把它注入 Planner RPC
或 Pi session cwd。

**Step 4: 写失败的 controller 测试**

增加：

```ts
it('sets the startup Workspace only after creating a new Conversation', async () => {
  await controller.start();
  expect(gateway.submitSlashCommand).toHaveBeenCalledWith(
    '/workspace /repo-a',
    { mode: 'attach', conversationId: 'conv_new' },
  );
});

it('never applies the startup hint when attaching an existing Conversation', async () => {
  await attachedController.start();
  expect(gateway.submitSlashCommand).not.toHaveBeenCalled();
});
```

覆盖 rejected receipt：TUI 显示失败和手动命令提示，但保持 connected，第一条语义
输入仍由 Server 返回 `workspace_required`。

**Step 5: 运行 vendored 测试并确认失败**

Run:

```bash
npm test --prefix planner/AnyFusion-Pi/packages/coding-agent -- \
  test/args.test.ts \
  test/anyfusion-client-mode.test.ts \
  test/metawork-client-reducer.test.ts \
  test/metawork-client-view.test.ts
```

Expected: FAIL，因为 controller 尚未自动初始化。

**Step 6: 实现新建/附着分支**

- 新建：`createConversation()` 后提交自动 `/workspace`，等待 receipt 和
  `workspace_changed` projection。
- 附着：先 replay，永不提交自动 `/workspace`。
- Header 只展示 reducer 中的 Server-confirmed Workspace。
- 窄屏展示 basename 时，状态/notice 中保留完整 canonical path。
- 默认初始化失败时显示可执行的 `/workspace /absolute/path` 提示。

**Step 7: 运行根和 vendored 测试**

Run: 使用 Step 2 和 Step 5 的命令。

Expected: PASS。

**Step 8: 提交**

```bash
git add src/client/tui-client-launcher.ts tests/client/tui-client-launcher.test.ts \
  planner/AnyFusion-Pi/packages/coding-agent/src \
  planner/AnyFusion-Pi/packages/coding-agent/test/args.test.ts \
  planner/AnyFusion-Pi/packages/coding-agent/test/anyfusion-client-mode.test.ts \
  planner/AnyFusion-Pi/packages/coding-agent/test/metawork-client-reducer.test.ts \
  planner/AnyFusion-Pi/packages/coding-agent/test/metawork-client-view.test.ts
git commit -m "feat: default new TUI conversations to client cwd"
```

## Task 4: 建立安全的 Web launch context

**Files:**

- Create: `src/management/web-launch-context.ts`
- Create: `src/client/web-launch-context-client.ts`
- Modify: `src/client/web-client-launcher.ts`
- Modify: `src/gateway/protocol.ts`
- Modify: `src/gateway/server.ts`
- Modify: `src/management/web-auth.ts`
- Modify: `src/management/server.ts`
- Modify: `src/server/server-composition.ts`
- Modify: `web/src/auth.ts`
- Modify: `web/src/App.tsx`
- Test: `tests/client/web-client-launcher.test.ts`
- Add: `tests/management/web-launch-context.test.ts`
- Modify: `tests/management/web-auth.test.ts`
- Modify: `tests/management/server.test.ts`
- Modify: `tests/gateway/native-tui-gateway.test.ts`
- Modify: `web/src/auth.test.ts` if the Web package has a unit-test seam; otherwise
  cover through `tests/management/server.test.ts` and E2E

**Step 1: 写失败的 launch-context 测试**

覆盖：

- `/repo-a` 和 optional Conversation ID 注册后返回高熵 token；
- token 有短 TTL 且只能消费一次；
- consume 返回 launch context，但日志和 endpoint manifest 不包含 path/token；
- 第二次消费、过期 token、外部 HTTP 直接注册均失败；
- password/manual login 没有伪造的 startup Workspace；
- Web session cookie 绑定 launch context；
- 两个 Browser session 的 launch context 互相隔离。

**Step 2: 写失败的 Web launcher 测试**

断言 launcher：

```ts
expect(registerLaunch).toHaveBeenCalledWith({
  workspaceHint: '/repo-a',
  conversationId: 'conv_1',
});
expect(open).toHaveBeenCalledWith(
  'http://127.0.0.1:8788/#bootstrap=<opaque-token>',
);
```

明确断言 URL 不包含 `/repo-a`、`workspace=` 或 `conversation=` query。

**Step 3: 运行测试并确认失败**

Run:

```bash
npm test -- \
  tests/client/web-client-launcher.test.ts \
  tests/management/web-launch-context.test.ts \
  tests/management/web-auth.test.ts \
  tests/management/server.test.ts \
  tests/gateway/native-tui-gateway.test.ts
```

Expected: FAIL，因为 per-launch token 和 session-bound context 尚不存在。

**Step 4: 实现 mode-0600 本机注册通道**

在现有 Unix Gateway wire protocol 增加 local-only request/response：

```ts
type RegisterWebLaunchRequest = {
  type: 'register_web_launch';
  workspaceHint: string;
  conversationId?: string;
};
```

`MetaclawGatewayServer` 只在本机 mode-restricted socket 上处理该消息，并委托
`WebLaunchContextService.issue()`。它不得创建/覆盖 Conversation Workspace。

`WebClientLauncher` 使用 `web-launch-context-client.ts` 注册 context，随后打开仅含
opaque bootstrap fragment 的 URL。

**Step 5: 实现 auth exchange**

把 `WebAuthService` 从单一共享 session token 改为可撤销、内存级 per-session
token。bootstrap exchange 原子地：

1. 消费一次性 launch token；
2. 创建 HttpOnly/SameSite session cookie；
3. 把 launch context 绑定到 session；
4. 返回不含 secret 的启动状态。

`GET /api/auth/session` 返回当前 session 的安全 launch projection，供 Web App
选择 optional Conversation；Workspace path 只通过同源认证 response 返回。

**Step 6: 运行聚焦测试**

Run: 使用 Step 3 的命令。

Expected: PASS。

**Step 7: 提交**

```bash
git add src/client src/gateway/protocol.ts src/gateway/server.ts \
  src/management/web-auth.ts src/management/web-launch-context.ts \
  src/management/server.ts src/server/server-composition.ts \
  web/src/auth.ts web/src/App.tsx tests/client tests/gateway/native-tui-gateway.test.ts \
  tests/management
git commit -m "feat: add secure web client launch context"
```

## Task 5: 默认初始化 Web Conversation 并展示 Workspace

**Files:**

- Modify: `src/management/web-session-runtime-types.ts`
- Modify: `src/management/web-session-types.ts`
- Modify: `src/management/web-gateway-session-runtime.ts`
- Modify: `src/management/server.ts`
- Modify: `web/src/api/http.ts`
- Modify: `web/src/api/types.ts`
- Modify: `web/src/api/ws.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/WorkspaceHeader.tsx`
- Modify: `web/src/components/WorkspaceShell.tsx`
- Modify: `web/src/styles.css`
- Modify: `tests/management/server.test.ts`
- Modify: `tests/web/workspace-shell.test.ts`
- Modify: `tests/e2e/web-routing-identity-and-theme.test.ts`
- Modify: `tests/integration/independent-client-lifecycle.integration.test.ts`

**Step 1: 写失败的 Web Runtime 测试**

覆盖：

- Web session 初始化时存在历史 active Conversation：不应用 launch hint；
- 没有历史 Conversation：创建后通过 Gateway `/workspace /repo-a` 初始化；
- `createSession()` 创建后使用当前 Web launch context 的 `/repo-a`；
- 激活历史 Conversation `/repo-b` 时保持 `/repo-b`；
- 自动初始化失败返回清晰状态，不提交 Planner user message；
- `workspace_changed` 同时更新 active snapshot、HTTP record 和 WebSocket live event；
- restart/replay 恢复同一 Workspace。

**Step 2: 写失败的 Web UI contract test**

在 `tests/web/workspace-shell.test.ts` 断言：

```ts
expect(header).toContain('workspace');
expect(header).toContain('workspacePath');
expect(app).toContain('selectedWorkspace');
```

同时保留现有 Conversation、Trajectory、Execution、Artifact、Settings、Composer
断言，防止为增加 Workspace 而简化 Web。

**Step 3: 运行测试并确认失败**

Run:

```bash
npm test -- \
  tests/management/server.test.ts \
  tests/web/workspace-shell.test.ts \
  tests/integration/independent-client-lifecycle.integration.test.ts
```

Expected: FAIL，因为 Web projection 和 Header 尚无 Workspace。

**Step 4: 扩展 Web Server projection**

在 `WebSessionMetadata`、`WebSessionRecord` 或等价 read projection 中增加：

```ts
workspace: {
  path: string;
  selectedAt: string;
} | null;
```

该字段由 Conversation/Gateway replay 派生，不成为第二个 Workspace authority。
`WebGatewaySessionRuntime` 创建新 session 后，通过统一 Gateway slash command
初始化；attach/activate 历史 session 时只读取 replay。

HTTP catalog/read、WebSocket replay 和 live `workspace_changed` 都必须携带一致值。

**Step 5: 最小化修改 Web UI**

把 Workspace 作为 prop 传入现有 `WorkspaceHeader`。显示 canonical path，并在
未设置或初始化失败时显示 `/workspace /absolute/path` 提示。不要移动现有 tabs、
runtime identity、Composer、Conversation/Trajectory body 或 drawer。

**Step 6: 运行聚焦和 Web 回归测试**

Run:

```bash
npm test -- \
  tests/management/server.test.ts \
  tests/web/workspace-shell.test.ts \
  tests/e2e/web-routing-identity-and-theme.test.ts \
  tests/integration/independent-client-lifecycle.integration.test.ts
```

Expected: PASS。

**Step 7: 提交**

```bash
git add src/management web/src tests/management tests/web \
  tests/e2e/web-routing-identity-and-theme.test.ts \
  tests/integration/independent-client-lifecycle.integration.test.ts
git commit -m "feat: show and initialize web conversation workspace"
```

## Task 6: 补齐飞书 Workspace 确认

**Files:**

- Modify: `src/gateway/feishu-gateway-adapter.ts`
- Modify: `src/gateway/feishu-gateway-session-port.ts`
- Modify: `src/gateway/feishu-events.ts`
- Modify: `src/integrations/feishu-app.ts`
- Test: `tests/gateway/feishu-conversation-routing.test.ts`
- Test: `tests/gateway/feishu-events.test.ts`
- Test: `tests/gateway/feishu-gateway-session-port.test.ts`
- Test: `tests/integrations/feishu-app.test.ts`

**Step 1: 写失败测试**

覆盖：

- bound Conversation attach/replay 存在 Workspace 时发送一次恢复确认；
- `/workspace` 成功后发送 canonical path 确认；
- 重复 replay 不重复刷屏；
- 新 bound Conversation 没有 Workspace 时，首条语义消息得到
  `workspace_required` 和可执行命令；
- 飞书 adapter 不保存本地 Workspace，不直接访问 Conversation store。

**Step 2: 运行测试并确认失败**

Run:

```bash
npm test -- \
  tests/gateway/feishu-conversation-routing.test.ts \
  tests/gateway/feishu-events.test.ts \
  tests/gateway/feishu-gateway-session-port.test.ts \
  tests/integrations/feishu-app.test.ts
```

Expected: FAIL，因为 Workspace 确认 projection 尚未交付。

**Step 3: 实现事件驱动确认**

只消费 Server 的 Conversation snapshot / `workspace_changed`：

```text
当前 Workspace：/absolute/path
```

使用 event ID/sequence 去重。不得在 adapter 中读取 cwd、缓存全局 Workspace 或
直接修改 Conversation。

**Step 4: 运行聚焦测试**

Run: 使用 Step 2 的命令。

Expected: PASS。

**Step 5: 提交**

```bash
git add src/gateway/feishu-* src/integrations/feishu-app.ts \
  tests/gateway/feishu-* tests/integrations/feishu-app.test.ts
git commit -m "feat: confirm conversation workspace in Feishu"
```

## Task 7: 完成全链路验收与交付记录

**Files:**

- Modify: `scripts/smoke-unified-gateway.mjs`
- Modify: `tests/integration/independent-client-lifecycle.integration.test.ts`
- Modify: `docs/plans/2026-08-27-client-default-workspace-design.md`
- Modify: `docs/plans/2026-08-27-client-default-workspace-implementation-plan.md`
- Modify: `docs/README.md`

**Step 1: 增加生命周期 smoke**

自动测试两个临时仓库：

```text
start Server from /server-cwd
start TUI Client from /repo-a
create Conversation -> Workspace /repo-a
attach same Conversation from /repo-b -> still /repo-a
start Web Client from /repo-b
create Web Conversation -> Workspace /repo-b
switch first Conversation explicitly -> all clients receive workspace_changed
stop Clients -> Server remains ready
```

断言 endpoint manifest 不含任何 Workspace path。

**Step 2: 运行聚焦总门**

Run:

```bash
npm test -- \
  tests/client/tui-client-launcher.test.ts \
  tests/client/web-client-launcher.test.ts \
  tests/workspace/conversation-workspace-service.test.ts \
  tests/gateway/client-protocol.test.ts \
  tests/gateway/conversation-gateway-runtime.test.ts \
  tests/management/web-auth.test.ts \
  tests/management/web-launch-context.test.ts \
  tests/management/server.test.ts \
  tests/web/workspace-shell.test.ts \
  tests/integration/independent-client-lifecycle.integration.test.ts
```

Expected: PASS。

**Step 3: 运行 vendored TUI 门**

Run:

```bash
npm test --prefix planner/AnyFusion-Pi/packages/coding-agent -- \
  test/args.test.ts \
  test/anyfusion-client-mode.test.ts \
  test/metawork-client-reducer.test.ts \
  test/metawork-client-view.test.ts
```

Expected: PASS。

**Step 4: 运行仓库质量门**

Run:

```bash
npm run lint
npm test
npm run build
npm run smoke:gateway
npm run smoke:clients
```

Expected: 全部 PASS。若环境阻止真实 Feishu 验收，必须记录为外部验证项，不能用单元
测试冒充线上机器人验收。

**Step 5: 真实用户验收**

在两个真实仓库目录中分别执行：

```bash
metawork
metawork web
```

确认：

- 新 Conversation 无需手动设置 Workspace；
- follow 历史 Session 保留原 Workspace；
- TUI 和 Web 都持续显示 Workspace；
- Web URL 不包含 Workspace path；
- Web 既有 Conversation、Trajectory、Execution、Artifact、Settings 和 Composer
  行为不变；
- Client 退出不停止 Server。

**Step 6: 填写交付记录**

在设计和实施计划中填写：

- completion date；
- delivered behavior；
- focused/full/E2E validation；
- residual risks；
- closing commit。

把 `docs/README.md` 的条目从 Active Delivery 移到 Completed Delivery。

**Step 7: 最终提交**

```bash
git add scripts tests/integration docs
git commit -m "test: validate client default workspace lifecycle"
```

## 交付占位

> Implementation status: Not started
>
> Completion date: 待填写。
>
> Delivered behavior: 待填写。
>
> Validation: 待填写。
>
> Residual risks: 待填写。
>
> Closing commit: 待填写。
