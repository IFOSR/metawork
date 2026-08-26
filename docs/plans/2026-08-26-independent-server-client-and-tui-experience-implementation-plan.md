# Independent Server/Client And TUI Experience Implementation Plan

> **For implementation:** Execute this plan task by task with the repository TDD rules.

**Status:** Approved for implementation

**Plan date:** 2026-08-26

**Review completed:** 2026-08-26；没有遗留产品决策待确认。

**Design:** [MetaWork 独立 Server/Client 与 TUI 体验改造设计](2026-08-26-independent-server-client-and-tui-experience-design.md)

**Goal:** 把 Server Runtime 与 TUI/Web Client 的进程生命周期彻底分离，固定
Server-owned 飞书连接和 Conversation Workspace 契约，并把原生 TUI 改造成
基于 Gateway replay 的任务型交互界面。

**Architecture:** 一个 Server 进程拥有 Runtime、storage、Planner、Kernel、
Execution、Unix Gateway、loopback Web endpoint 和配置驱动的飞书 adapter。
Server 不绑定用户 Workspace；Conversation 通过统一 `/workspace <path>` command
持久化工作区上下文。TUI 和 Browser Web 是独立 Client；飞书 adapter 随 Server
自动连接。TUI 通过纯 reducer 把安全事件投影为 Turn、stage、Subtask、
permission 和 result view model。

**Tech stack:** Node 22.19+, TypeScript ESM, Unix sockets, loopback
HTTP/WebSocket, AnyFusion-Pi TUI, Vitest, native macOS launcher.

---

## 0. 实施约束

- 先批准并提交新的 ADR，再修改进程拓扑。
- 严格保留 ADR-0020 依赖方向。
- 不在 Client 中 import repository、Planner、Kernel、Execution 或 storage。
- 不新增第二套 Session/Runtime compatibility path。
- 删除旧 `gateway run`、`--connect`、foreground Web 和 script 启动路径，不做
  双轨兼容。
- `src/tui/` standby Ink UI 保留，不做迁移或删除。
- 不把 hidden reasoning、prompt、secret、raw stdout/stderr 加入 Gateway event。
- 不用 Client 侧文本解析推断 Runtime 状态。
- Web Client 是兼容基线：除连接拓扑、Workspace required 和连接状态外，不修改
  当前 Web 组件结构、交互流程、展示内容、视觉设计或信息密度。
- Server 新 contract 必须是当前 Web HTTP/WebSocket/query projection 的字段与
  行为超集。
- 生产协议需要 breaking change 时做一次明确版本升级，不长期双写。
- 每个 Task 先写失败测试，再实现最小生产代码。
- 实施完成前不修改本文档为 Completed。

## Task 1: 用 ADR 固定独立进程拓扑

**Files:**

- Create: `docs/adr/0034-independent-server-and-client-process-lifecycle.md`
- Modify: `docs/adr/README.md`
- Modify: `docs/adr/0031-account-runtime-and-unified-client-gateway.md`
- Modify: `CONTEXT.md`
- Modify: `docs/current/technical-overview.md`
- Modify: `docs/current/technical-overview.zh-CN.md`

**Step 1: 写 ADR**

ADR 必须明确：

- Server-only Runtime owner；
- Unix 与 loopback HTTP/WebSocket transport；
- TUI/Web 的独立生命周期和飞书 adapter 的 Server-owned 生命周期；
- `metawork` 的 client-only 默认语义；
- Server 不绑定 Workspace；
- Conversation 级 `/workspace <path>`、authorization 和 admission gate；
- 飞书配置有效时随 Server 自动连接且没有独立命令；
- endpoint discovery manifest；
- protocol negotiation 和 draining；
- ADR-0031 哪些 implementation evidence 被替代。

**Step 2: 更新 authority index**

把 ADR-0034 设为“进程生命周期与独立 Client”主题 owner。ADR-0031 继续拥有
AccountRuntime、Conversation 和统一 Gateway 领域模型。

**Step 3: 文档一致性检查**

```bash
rg -n "foreground surface|metawork --connect|metawork gateway run|Client disconnect" \
  CONTEXT.md docs/adr docs/current
```

Expected: 所有当前权威文档使用相同拓扑，没有同时宣称 TUI/Web 是 Server
foreground surface。

**Suggested commit:** `docs: define independent server and client lifecycle`

## Task 2: 建立 canonical CLI 合约

**Files:**

- Modify: `src/cli/args.ts`
- Modify: `src/cli/admin-args.ts`
- Modify: `src/index.ts`
- Test: `tests/cli/args.test.ts`
- Test: `tests/cli/admin-args.test.ts`

**Step 1: 写失败测试**

覆盖：

```text
metawork server start
metawork server stop|restart|status|doctor
metawork tui
metawork tui --conversation conv_1
metawork web
metawork web --conversation conv_1
metawork
```

断言：

- bare `metawork` 解析为 `tui`；
- `tui/web` 不设置任何 server surface flag；
- `server start` 不接受 Workspace；
- `gateway run`、`--connect`、`feishu run`、script mode 和旧 Web foreground
  参数明确拒绝并指向新命令；
- 非法 Client/Server 参数 fail closed；
- help 先解释 Server，再解释 Client；
- product-facing help 不把 Runtime 称作 AnyFusion 或 MetaClaw。

**Step 2: 运行测试并确认失败**

```bash
npm test -- tests/cli/args.test.ts tests/cli/admin-args.test.ts
```

**Step 3: 实现 discriminated command model**

建议：

```ts
type CliCommand =
  | { kind: 'server'; action: ServerAction }
  | { kind: 'tui'; conversationId?: string }
  | { kind: 'web'; conversationId?: string; noOpen?: boolean }
  | { kind: 'admin'; command: AdminCommand }
  | { kind: 'help' };
```

删除依赖多个 boolean 推导 surface 的方式。

**Step 4: 运行聚焦测试**

Expected: PASS。

**Suggested commit:** `refactor: define explicit server and client commands`

## Task 3: 建立 Conversation Workspace 契约

**Files:**

- Modify: `src/session/conversation-store.ts`
- Modify: `src/session/file-conversation-store.ts`
- Modify: `src/session/conversation-registry.ts`
- Modify: `src/session/conversation-session.ts`
- Modify: `src/gateway/client-protocol.ts`
- Modify: `src/gateway/client-events.ts`
- Modify: `src/gateway/client-gateway.ts`
- Modify: `src/gateway/conversation-gateway-runtime.ts`
- Create: `src/workspace/conversation-workspace-service.ts`
- Modify: `src/account/account-runtime-composition.ts`
- Modify: `src/account/account-kernel-execution-services.ts`
- Modify: `src/account/account-runtime-execution-services.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/gateway-protocol.ts`
- Test: `tests/session/file-conversation-store.test.ts`
- Test: `tests/session/conversation-session.test.ts`
- Test: `tests/gateway/client-protocol.test.ts`
- Test: `tests/gateway/client-gateway.test.ts`
- Test: `tests/gateway/conversation-gateway-runtime.test.ts`
- Add: `tests/workspace/conversation-workspace-service.test.ts`

**Step 1: 写失败契约测试**

覆盖：

- 新 Conversation 的 `workspacePath` 为 `null`；
- `/workspace /absolute/repo` 是唯一 Workspace mutation command；
- 相对路径、缺失目录、文件路径、不可访问目录和未授权 Principal fail closed；
- `realpath` 后持久化 canonical path；
- Workspace 未设置时 user message 返回 `workspace_required`，Planner 未启动；
- active turn/Task 期间切换返回 `workspace_busy`；
- attach/replay 恢复 Workspace；
- 两个 Conversation 可以绑定不同 Workspace；
- 历史 Turn 保留提交时的 Workspace reference；
- Web/TUI/飞书提交同一个 command envelope，不存在第二个管理 mutation API；
- Web 使用现有 Composer 提交 `/workspace <path>`，不新增 Workspace selector。

**Step 2: 运行测试并确认失败**

```bash
npm test -- \
  tests/session/file-conversation-store.test.ts \
  tests/session/conversation-session.test.ts \
  tests/gateway/client-protocol.test.ts \
  tests/gateway/client-gateway.test.ts \
  tests/gateway/conversation-gateway-runtime.test.ts \
  tests/workspace/conversation-workspace-service.test.ts
```

**Step 3: 升级 Conversation format**

Conversation metadata 增加：

```ts
interface ConversationWorkspace {
  path: string;
  selectedAt: string;
  selectedByPrincipal: string;
}
```

旧记录迁移为 `workspace: null`。Catalog、record、snapshot 和 replay 使用同一
版本化字段。

**Step 4: 实现 Server-owned Workspace service**

Service 负责：

- parse `/workspace <path>`；
- `resolve` + `realpath`；
- 目录与权限检查；
- Principal/account policy；
- active-work fence；
- 原子持久化；
- 发布 `workspace_changed` Gateway event。

Path 是 Client 的非信任输入，Client 不拥有授权结论。

**Step 5: 移除进程 cwd 的用户 Workspace 权威**

当前 `src/index.ts` 把 `startupWorkspaceRoot/process.cwd()` 注入
`userWorkspaceRoot/sourceRoot`。改为 Task/Turn admission 从 Conversation
Workspace 解析并固定 execution source root。Account 内部
`workspace-store` 仍是账户级存储根，不与用户选择的 Workspace 混淆。

**Step 6: 运行聚焦测试**

Expected: PASS。

**Suggested commit:** `feat: require conversation workspace before task admission`

## Task 4: 抽取 Server-only composition root

**Files:**

- Create: `src/server/server-application.ts`
- Create: `src/server/server-composition.ts`
- Create: `src/server/server-lifecycle.ts`
- Create: `src/server/server-endpoint-manifest.ts`
- Modify: `src/index.ts`
- Delete or repurpose: `src/session/server-application.ts`
- Delete: `src/session/scripted-session.ts`
- Delete: `src/gateway/scripted-gateway-session.ts`
- Delete: `tests/session/scripted-session.test.ts`
- Delete: `tests/gateway/scripted-gateway-session.test.ts`
- Test: `tests/server/server-application.test.ts`
- Test: `tests/server/server-endpoint-manifest.test.ts`
- Modify: `tests/architecture/current-client-runtime-topology.test.ts`

**Step 1: 写失败的生命周期测试**

证明：

- Server start 不调用 `plannerSupervisor.startInteractive` 或 browser `open()`；
- Server start 不读取 process cwd 作为用户 Workspace；
- 飞书配置有效时 Server 启动 adapter，配置缺失时保持 disabled；
- recovery 完成后才写 ready manifest；
- stop 顺序是 admission -> listeners -> drain -> Planner/Runtime -> manifest/lock；
- start 失败清理已启动资源和 stale manifest；
- 两次 start 受 `runtime.lock` 阻止；
- manifest 原子写、权限正确、不包含 Workspace、stale PID 不视为 ready；
- 所有 Client 断开后 Server 继续运行，直到显式 stop/restart。

**Step 2: 运行测试并确认失败**

```bash
npm test -- \
  tests/server/server-application.test.ts \
  tests/server/server-endpoint-manifest.test.ts \
  tests/architecture/current-client-runtime-topology.test.ts
```

**Step 3: 移动组合逻辑**

把 `src/index.ts` 中 Runtime/Account/Gateway/Management 的构造移动到
`src/server/server-composition.ts`。`src/index.ts` 只做 parse + dispatch。

Server composition 必须始终启动：

- RuntimeRegistry / AccountRuntime；
- ConversationRegistry；
- Planner Host；
- Unix Gateway；
- loopback Management HTTP/WebSocket；
- 配置驱动的 Feishu adapter；
- recovery 和 timers。

不得启动：

- interactive TUI child；
- browser；
- 任意 scripted session。

**Step 4: 实现 manifest**

实现 write/read/remove/validate，并由 status/Client 共享，不允许每个 Client
复制一份 PID/socket 判断逻辑。

**Step 5: 运行聚焦测试**

Expected: PASS。

**Suggested commit:** `refactor: extract standalone server composition`

## Task 5: 让 TUI 成为独立 Client launcher

**Files:**

- Create: `src/client/client-endpoint-resolver.ts`
- Create: `src/client/tui-client-launcher.ts`
- Modify: `src/planning/planner-process-supervisor.ts`
- Modify: `src/index.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/cli/args.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/main.ts`
- Test: `tests/client/client-endpoint-resolver.test.ts`
- Test: `tests/client/tui-client-launcher.test.ts`
- Test: `tests/planning/planner-process-supervisor.test.ts`

**Step 1: 写失败测试**

覆盖：

- TUI 读取并验证 manifest；
- Server 不在线时返回具体 `server start` 指令；
- protocol/version 不兼容时不 spawn；
- TUI child exit 不调用 Server shutdown；
- TUI Ctrl-C 只终止自己的 child/transport；
- conversation attach 与 new conversation 都通过 Gateway；
- Conversation 未设置 Workspace 时展示 `/workspace <path>` 引导；
- `workspace_required` 时不丢失用户草稿，设置成功后由用户重新提交。

**Step 2: 运行测试并确认失败**

```bash
npm test -- \
  tests/client/client-endpoint-resolver.test.ts \
  tests/client/tui-client-launcher.test.ts \
  tests/planning/planner-process-supervisor.test.ts
```

**Step 3: 拆分 Planner 进程职责**

`PlannerProcessSupervisor` 继续只拥有 Server 侧 semantic RPC Planner。
interactive client spawn 移入 `TuiClientLauncher`，避免 Server shutdown
误把 Client 当成 Planner child。

如果共用 launch resolution，把 process spawning 抽成无 Runtime 依赖的 helper，
不要让 Client import Server composition。

**Step 4: 更新 client-only 参数**

AnyFusion-Pi 只接收：

- socket path；
- conversation selection；
- public version/protocol facts。

不要传 database、Planner Host 或 Runtime 配置。

**Step 5: 运行聚焦测试**

Expected: PASS。

**Suggested commit:** `feat: launch native tui as an independent client`

## Task 6: 固定 Web 为独立 Browser Client

**Files:**

- Create: `src/client/web-client-launcher.ts`
- Modify: `src/management/server.ts`
- Modify: `src/index.ts`
- Modify only additively if required: `web/src/api/http.ts`
- Modify only additively if required: `web/src/api/ws.ts`
- Modify only additively if required: `web/src/api/types.ts`
- Modify only additively if required: `web/src/api/session-types.ts`
- Modify only additively if required: `web/src/api/gateway-types.ts`
- Test: `tests/client/web-client-launcher.test.ts`
- Test: `tests/management/server.test.ts`
- Test: `tests/web/gateway-contract-parity.test.ts`
- Create: `tests/web/current-web-experience-preservation.test.ts`

**Step 1: 冻结当前 Web 兼容基线**

在修改 topology 前记录并测试当前 Web 的：

- authentication；
- Session sidebar 创建、搜索、浏览、激活、删除和清空；
- Conversation/Trajectory tabs 和 Composer 可见性；
- draft、attachments 和只读历史会话；
- trace、execution cards/detail、timeline、Work Graph 和 routing；
- result streaming/certification；
- artifact preview/download；
- Settings、Provider/Model/Secret、activation/rollback；
- system/light/dark theme；
- desktop/mobile 响应式关键截图。

基线以当前 Web components、API types、现有 Web tests 和 native Chrome golden
flow 为准。本任务不能以“新设计”更新 baseline。

**Step 2: 写 topology 和 contract 失败测试**

证明：

- Server-only 启动后 Web health、static、HTTP API 和 WebSocket 都 ready；
- `metawork web` 只 health check + open URL；
- browser close 不影响 Server；
- `web --conversation` 通过授权 attach flow，不把 account authority 放到 URL；
- Web launcher 在 Server 离线时不构造 storage/Runtime；
- 多 tab attach 同一 Conversation，事件 ID 不重复；
- 现有 Composer 提交 `/workspace <path>` Gateway command，没有新 selector；
- 未设置 Workspace 时 Web 使用现有错误/blocked presentation 显示相同引导；
- 当前 `types.ts`、`session-types.ts` 和 `gateway-types.ts` 的所有字段仍由 Server
  返回；
- Server projection 允许新增字段，但不删除、改名、降精度或改变现有语义；
- session activation、replay/live merge、result streaming、execution detail 和
  artifact APIs 行为保持；
- 当前 Web components 和 `styles.css` 没有非必要结构或视觉改版。

**Step 3: 运行测试并确认失败**

```bash
npm test -- \
  tests/client/web-client-launcher.test.ts \
  tests/management/server.test.ts \
  tests/web/gateway-contract-parity.test.ts \
  tests/web/current-web-experience-preservation.test.ts
```

**Step 4: 移除 web foreground mode**

`ManagementServer` 作为 Server transport 固定启动。`web` command 不再经过
`startWebMode()` 构造 Runtime。

保留当前 Web-specific Application-Shell projection。内部事实可以收敛到统一
Gateway，但不能强迫 Web 直接消费信息更少的通用事件。

**Step 5: 加入 additive Server identity handshake**

Web bootstrap/session 响应增加：

- server version；
- Gateway protocol version；
- ready/draining；
- 当前 Conversation workspace 或 `workspace_required`；
- running configuration revision display。

不返回 secret 或本地绝对路径给非本机授权 Principal。

**Step 6: 运行完整 Web 回归和浏览器验收**

```bash
npm test -- tests/web tests/management/server.test.ts
```

随后运行 native Chrome golden flow，对比 topology 切换前的关键页面和操作。
除 Workspace required 与 Server connection state 外，不接受用户可见差异。

Expected: PASS。

**Suggested commit:** `feat: make web an independently launched browser client`

## Task 7: 让飞书随 Server 自动连接

**Files:**

- Modify: `src/gateway/feishu-runtime.ts`
- Modify: `src/gateway/feishu-gateway-session-port.ts`
- Modify: `src/server/server-composition.ts`
- Modify: `src/configuration/configuration-runtime-coordinator.ts`
- Modify: `tests/gateway/feishu-runtime.test.ts`
- Modify: `tests/gateway/feishu-gateway-session-port.test.ts`
- Modify: `tests/gateway/feishu-conversation-routing.test.ts`
- Modify: `tests/server/server-application.test.ts`

**Step 1: 写失败测试**

证明：

- 飞书配置完整时 `server start` 自动建立机器人连接；
- 配置缺失时 adapter 保持 disabled，但 Server 正常 ready；
- 配置 activation 后自动启动、停止或重连 adapter；
- 飞书连接断开后按有上限退避自动重连；
- 没有 `feishu run` CLI；
- 新飞书 Conversation 未设置 Workspace 时回复 `/workspace <path>` 引导；
- `/workspace <path>` 使用统一 Gateway command 和 Server authorization；
- 平台 retry 复用 idempotency key，不创建第二个 Planner turn；
- Server stop 时先停止飞书 admission/delivery，再 drain Runtime。

**Step 2: 运行测试并确认失败**

```bash
npm test -- \
  tests/gateway/feishu-runtime.test.ts \
  tests/gateway/feishu-gateway-session-port.test.ts \
  tests/gateway/feishu-conversation-routing.test.ts \
  tests/server/server-application.test.ts
```

**Step 3: 实现配置驱动生命周期**

Server composition 持有飞书 transport adapter，但所有用户消息仍通过
`ClientGateway`，所有输出仍消费统一 Gateway event。Adapter 不直接调用
ConversationSession、Planner、Kernel 或 Executor。

Configuration activation 发布 lifecycle change，adapter 根据有效配置幂等地
connect/disconnect/reconnect。用户不需要额外进程或命令。

**Step 4: 运行聚焦测试**

Expected: PASS。

**Suggested commit:** `feat: connect feishu automatically with the server`

## Task 8: 建立纯 TUI presentation model

**Files:**

- Create: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/metawork-client-model.ts`
- Create: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/metawork-client-reducer.ts`
- Create: `planner/AnyFusion-Pi/packages/coding-agent/test/metawork-client-reducer.test.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/anyfusion-client-mode.ts`
- Modify if protocol facts are missing: `src/gateway/client-events.ts`
- Modify if protocol facts are missing: `src/gateway/conversation-gateway-runtime.ts`
- Mirror if protocol changes: `planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/gateway-protocol.ts`
- Test if protocol changes: `tests/gateway/client-events.test.ts`
- Test if protocol changes: `tests/gateway/conversation-gateway-runtime.test.ts`

**Step 1: 写 reducer 失败测试**

覆盖：

- replay snapshot + deltas 与同序列 live events 得到完全相同 model；
- duplicate `eventId` / `eventKey` 不重复；
- out-of-order sequence fail closed 或进入明确 resync；
- 一次用户输入只生成一个 user message；
- phase 映射为六阶段；
- `workspace_changed` 更新 Conversation header；
- `workspace_required` 进入可操作的输入阻塞状态；
- routing 合并到 authorization；
- 同一 canonical Subtask 只有一张卡；
- heartbeat 更新 elapsed/silent 状态，不追加无限日志；
- permission lifecycle；
- result chunk 原位组装、hash/length 校验、certification；
- `conversation_snapshot`、`final_answer` 和 result stream 指向同一 result 时正文只
  保留一份；
- 当前 Turn 不吸收无关历史 Task queue projection；
- terminal error/cancel；
- unknown event 进入折叠 notice；
- sensitive/raw fields 永不进入可渲染 model。

**Step 2: 运行测试并确认失败**

```bash
cd planner/AnyFusion-Pi
npx vitest run packages/coding-agent/test/metawork-client-reducer.test.ts
```

**Step 3: 实现纯 reducer**

接口建议：

```ts
export function reduceGatewayEvent(
  state: ConversationViewModel,
  event: GatewayEventEnvelope,
): ConversationViewModel;

export function rebuildFromReplay(replay: GatewayReplay): ConversationViewModel;
```

时间显示通过 injected clock/tick action 更新，不能修改 event facts。

**Step 4: 只补必要协议事实**

优先消费现有 `trace_delta`、`task_projection` 和 result events。若缺失 terminal、
cancel 或 permission resolution，再以 Gateway protocol v2 一次性增加 typed
facts，并更新 parity tests。

**Step 5: 运行根项目与 vendored tests**

Expected: PASS。

**Suggested commit:** `feat: add deterministic tui presentation reducer`

## Task 9: 重做 TUI 组件与交互

**Files:**

- Create: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/metawork-client-view.ts`
- Create: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/metawork-turn-view.ts`
- Create: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/metawork-subtask-view.ts`
- Create: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/metawork-result-view.ts`
- Create: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/metawork-permission-view.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/anyfusion-client-mode.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/theme/theme.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/test/anyfusion-client-mode.test.ts`
- Create: `planner/AnyFusion-Pi/packages/coding-agent/test/metawork-client-view.test.ts`

**Step 1: 写失败的 view snapshot/behavior tests**

至少覆盖：

- 80x24、120x36、160x48；
- 中文宽字符和长路径；
- connected/reconnecting/offline；
- idle/busy/waiting permission；
- workspace selected/required/changing/busy；
- stage stepper；
- collapsed/expanded details；
- permission keyboard actions；
- cancel action；
- result streaming/certified/uncertified；
- 同一 result 正文只出现一次；
- 默认 Turn 时间线不显示无关历史阻塞 Task；
- terminal resize；
- 不出现 `ANYFUSION`、socket path、raw attempt ID、内部 event kind。

**Step 2: 运行测试并确认失败**

```bash
cd planner/AnyFusion-Pi
npx vitest run \
  packages/coding-agent/test/anyfusion-client-mode.test.ts \
  packages/coding-agent/test/metawork-client-view.test.ts
```

**Step 3: 实现单一 Conversation 时间线**

删除当前 `trace: string[]` / `transcript: string[]` 双 append 模型。View 只接收
`ConversationViewModel` 并渲染：

- MetaWork compact header；
- Turn blocks；
- stage stepper；
- Subtask cards；
- permission card；
- result card；
- fixed composer/status。

**Step 4: 实现 details 和 keyboard flow**

建议：

```text
d  当前 Turn 技术详情
a  批准当前权限
x  拒绝当前权限
c  取消当前 Turn
Esc 返回主时间线
```

保留 slash command 作为可发现兼容输入，但主权限交互不依赖用户记忆命令。

**Step 5: 运行测试**

Expected: PASS。

**Suggested commit:** `feat: redesign native tui around task progress and results`

## Task 10: 更新 launcher、installer 与服务管理

**Files:**

- Modify: `metawork.sh`
- Modify: `src/installation/native-launcher.ts`
- Modify: `src/installation/native-install-cli.ts`
- Modify: `scripts/install-native-macos.mjs`
- Modify: service template files discovered under `src/installation/` or `scripts/`
- Test: `tests/installation/native-install-cli.test.ts`
- Test: `tests/installation/install-cli.test.ts`
- Add focused shell/launcher tests under `tests/scripts/`

**Step 1: 写失败测试**

证明：

- `server start` 后台只运行 Server；
- PID/status 只跟踪 Server，不把 TUI Client 当 Server；
- `tui` 可以启动多个；
- `web` 不争抢 runtime.lock；
- `stop` 只停止 Server；
- stale PID/manifest 自愈；
- install/update 不在切换 revision 时误杀 Client 以外的任意进程；
- macOS launchd 服务不保存或推导用户 Workspace；
- Server 没有 Client 时仍持续运行，只有显式 stop/restart 改变其生命周期。

**Step 2: 重写 wrapper**

删除按 `dist/index.js` 模糊匹配所有进程的方式。Server identity 以 runtime lock +
manifest + health 为准。

**Step 3: 运行聚焦测试**

```bash
npm test -- \
  tests/installation/native-install-cli.test.ts \
  tests/installation/install-cli.test.ts \
  tests/scripts
```

**Suggested commit:** `fix: manage only the standalone server process`

## Task 11: 架构与安全回归

**Files:**

- Modify: `tests/architecture/current-client-runtime-topology.test.ts`
- Modify: `tests/architecture/no-direct-client-session-paths.test.ts`
- Add: `tests/architecture/no-client-runtime-ownership.test.ts`
- Add: `tests/security/client-event-redaction.test.ts`
- Modify: `tests/security/gateway-account-isolation.test.ts`
- Modify: `tests/web/gateway-contract-parity.test.ts`

**Step 1: 加入静态架构断言**

扫描所有 `src/client/` 和 TUI fork Client：

- 不 import storage/repository；
- 不 import Planner/Kernel/Execution implementation；
- 不构造 AccountRuntime/ConversationSession；
- 不调用 Server shutdown；
- 不读取 account database path。

另外断言 Server-owned Feishu adapter 只依赖 Gateway facade，不直接 import
ConversationSession、Planner、Kernel 或 Executor。

Web contract parity 断言当前 HTTP/WebSocket/query projection 是下限：

- 当前字段和 event kind 不得消失；
- additive field 不影响旧 consumer；
- 通用 Gateway event 不得替代并删减 Web 所需 execution/work-graph/artifact/config
  projection。

**Step 2: 加入安全 payload 测试**

构造包含：

```text
reasoning, thoughts, prompt, token, apiKey, stdout, stderr,
authorization, rawOutput, signature
```

的事件，证明 Server sanitize 和 TUI reducer 两层都不会渲染。

**Step 3: 运行测试**

```bash
npm test -- \
  tests/architecture/current-client-runtime-topology.test.ts \
  tests/architecture/no-direct-client-session-paths.test.ts \
  tests/architecture/no-client-runtime-ownership.test.ts \
  tests/security/client-event-redaction.test.ts \
  tests/security/gateway-account-isolation.test.ts
```

**Suggested commit:** `test: enforce independent client boundaries`

## Task 12: 多 Client 集成与真实验收

**Files:**

- Create: `tests/integration/independent-client-lifecycle.integration.test.ts`
- Create: `scripts/smoke-independent-clients.mjs`
- Modify: `package.json`
- Modify: `scripts/smoke-unified-gateway.mjs`
- Modify: `scripts/smoke-metaclaw-real-task.mjs`

**Step 1: 自动化多 Client 场景**

在一个临时 installation/account 和两个临时 Workspace 中：

1. 启动一个 Server。
2. 启动 TUI transport client A、client B 和 WebSocket client。
3. A 创建 Conversation；未设置 Workspace 时提交任务被 `workspace_required` 拒绝。
4. A 提交 `/workspace <path-a>` 后再提交任务。
5. B/Web attach 同一 Conversation，恢复相同 Workspace。
6. 关闭 A，证明 Server PID 未变、Task 继续、B/Web 收到 terminal result。
7. 创建第二个 Conversation，通过 `/workspace <path-b>` 执行任务，证明 Server
   不绑定单一 Workspace。
8. 重启 A 并 replay，证明 Workspace、过程和结果无重复。
9. 关闭所有 Client，证明 Server 仍 ready。
10. 在有效飞书 fixture 下证明 Server 自动连接 adapter；没有 `feishu run`。
11. 显式 `server stop`，证明按顺序 drain。
12. 完成当前 Web golden flow，证明展示内容、交互、视觉和响应式行为无回归。

**Step 2: TUI real-task dogfood**

至少执行：

- 快速只读报告；
- 5 分钟以上静默/心跳任务；
- 权限请求；
- 产生 artifact 的任务；
- Executor 失败和恢复；
- Server 重启后 replay；
- Workspace required、切换和两个 Conversation 使用不同 Workspace；
- Web Session/Conversation/Trajectory/Execution/Artifact/Settings/theme 全流程；
- 中文输入、IME 和长 Markdown 结果。

记录截图或 terminal capture，验证：

- 用户在 3 秒内能识别当前阶段；
- 最终结果不被 trace 淹没；
- Client exit 不终止执行；
- 没有 raw/internal data 泄漏。

**Step 3: 运行 smoke**

```bash
npm run build
npm run lint
npm test
npm run smoke:gateway
npm run smoke:clients
npm run smoke:metawork
```

Expected: 全部 PASS。真实 Provider smoke 若因外部服务不可用，必须记录具体外部
阻塞和已通过的 provider-independent gates。

**Suggested commit:** `test: cover multi-client server continuity`

## Task 13: 文档、迁移与完成记录

**Files:**

- Modify: `README.md`
- Modify: `AGENTS.md` if entry-point navigation changed
- Modify: `docs/current/account-runtime-and-gateway-operations.md`
- Modify: `docs/current/technical-overview.md`
- Modify: `docs/current/technical-overview.zh-CN.md`
- Modify: `docs/README.md`
- Modify: this plan
- Modify: design document
- Add release/migration note if command behavior ships

**Step 1: 更新用户命令**

文档顺序固定为：

```text
metawork server start
metawork tui
metawork web

/workspace /absolute/path/to/project
```

明确：

- `metawork` 只是 TUI Client；
- Client exit 不停止 Server；
- Server 不绑定 Workspace；
- 所有 Client 使用同一个 `/workspace <path>` command；
- 飞书配置有效时随 Server 自动连接，没有独立命令；
- Script Client 和旧启动形式已删除。

**Step 2: 更新运维排障**

加入：

- server status/doctor；
- manifest/health/socket 检查；
- `workspace_required`、`workspace_busy` 和 path authorization；
- protocol mismatch；
- Client replay；
- Server draining；
- 飞书自动连接和重连。

**Step 3: 关闭计划**

实施完成后在设计和实施计划中记录：

- completion date；
- delivered behavior；
- validation commands/results；
- live dogfood evidence；
- closing commit；
- 未完成项。

**Suggested commit:** `docs: document independent server and client operations`

## 最终发布门

只有同时满足以下条件才可报告完成：

1. 新 ADR accepted。
2. Server start 不启动任何 Client。
3. 所有 Client start 不构造 Runtime。
4. Server 启动不绑定 Workspace，manifest 不包含 Workspace。
5. 所有 Client 在 Workspace 缺失时都被 `workspace_required` 阻止，并通过同一个
   `/workspace <path>` command 设置。
6. 两个 Conversation 可以在同一 Server 上使用不同 Workspace。
7. Client exit 不触发 Server shutdown。
8. 一个真实 Task 在原始 TUI Client 退出后继续，并由另一个 Client 收到结果。
9. Web、TUI、飞书都通过同一 Gateway command/event contract。
10. 飞书配置有效时随 Server 自动连接，没有独立进程命令。
11. Script Client 和旧 foreground/`gateway run`/`--connect` 路径不存在。
12. Server 返回当前 Web 展示信息的超集，当前 Web API 字段和行为没有删减。
13. Web 的 Session、Conversation、Trajectory、Execution、Work Graph、Routing、
    Result、Artifact、Settings、Authentication、Theme 和响应式体验无回归。
14. 除 Workspace required 和 Server connection state 外，Web 没有用户可见改版。
15. TUI replay/live reducer 等价、结果完整性校验通过。
16. TUI 默认界面没有 AnyFusion 主品牌、raw socket/ID 或无限 trace。
17. 安全回归证明无 hidden reasoning、prompt、secret、stdout/stderr 泄漏。
18. build、lint、full test、Web golden flow、Gateway smoke、multi-client smoke 和真实任务 smoke
    全部通过或有明确的外部阻塞记录。
