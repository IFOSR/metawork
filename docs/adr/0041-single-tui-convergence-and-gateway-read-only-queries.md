# ADR-0041: Single-TUI Convergence and Gateway Read-Only Queries

- **Status:** Accepted
- **Date:** 2026-09-19
- **Scope:** One product TUI on the unified Gateway, Gateway v2 read-only capability
  extensions (`complete_command`, `get_task_view`), client forbidden dependencies
- **Amends:** ADR-0031 (adds two versioned read-only commands to the unified
  command plane and capability advertisement to the Server hello)
- **Preserves:** ADR-0015, ADR-0020, ADR-0032, ADR-0034, ADR-0035, ADR-0036,
  ADR-0037, ADR-0040
- **Supersedes:** the "preserved standby Ink module" scope rule from the
  2026-08-18 account-runtime/Gateway plan and the `AGENTS.md` Ink-retention
  working rule. Ink under `src/tui/` is retired by the single-TUI cutover phase
  of the governing design, not kept as a permanent third UI.
- **Related design:** `docs/plans/2026-09-19-unified-gateway-full-pi-tui-design.md`
- **Governed by:** ADR-0020

## Context

MetaWork converged on one Server with a unified client Gateway (ADR-0031/0034),
but the terminal surface still had two partial answers: a simplified
Gateway-backed client mode inside the vendored Pi fork, and a preserved standby
Ink UI that older plans forbade deleting. The 2026-09-19 design decides the end
state: exactly one product TUI, built from the migrated Pi presentation
components, running strictly as a Gateway Client.

That TUI needs two server-side capabilities the command plane did not expose:
command completion without a local Planner Host, and a safe per-Turn/per-Task
presentation snapshot without reconstructing business state on the client.

## Decision

1. **One product TUI.** `metawork` / `metawork tui` keep their command names
   and independent Client lifecycle (ADR-0034); what changes is the interface
   behind them. The final TUI is the Pi-based full interface running as a
   Gateway Client. The simplified client view, the legacy local-agent
   InteractiveMode, and the standby Ink UI are retired in the same release as
   the cutover — no long-lived UI switch, no `legacy-tui/` copy.
2. **The TUI never owns runtime semantics.** The client must not construct or
   import `AgentSessionRuntime`, `AgentSession`, `SessionManager`, model
   registries/authentication, tool executors, Planner Host, SQLite, Kernel,
   Executor, or AccountRuntime implementations — not even as `import type`
   façades. All business operations go through the Gateway; all business state
   is projected from Server facts.
3. **Read-only queries stay on the existing command plane.** `complete_command`
   and `get_task_view` are Gateway v2 commands, not a new transport, second
   gateway, or semantic route:
   - They are handled in a dedicated read-only branch: no semantic mailbox, no
     Planner start, no Turn creation, no business work reservation, and no
     persistent command-admission storage (completion drafts and candidates are
     never written to durable admission/audit text). A transient, bounded
     receipt cache and per-connection rate limiting apply instead.
   - `complete_command` accepts a Workspace scope (navigation/read-only
     candidates only) or a Conversation scope that explicitly attaches an
     existing Conversation; it must never implicitly create a binding.
   - `get_task_view` must validate the Account/Conversation/Turn/Task/Workspace
     association and answer unknown or mismatched targets with structured
     errors.
   - Responses are events addressed only to the requesting connection's event
     stream. The payload carries the logical target Conversation explicitly;
     the connection stream id is not a Conversation id. Response sequences come
     from the same per-connection allocator as other connection events and are
     not persisted as Conversation history.
4. **Task views reuse the existing projection owners.** The Task DTO is built
   from the ExecutionProjector / history projection path, with an
   `asOfSequence` watermark taken from the target Conversation's event stream.
   The client never infers Task state from raw output, titles, or timing.
5. **Capabilities are explicit.** The Server hello advertises
   `command_completion_v1` and `task_view_v1`. A TUI that requires them must
   fail closed with an upgrade prompt when they are absent; it must not fall
   back to a Planner Host channel or silently drop panels. Web and Feishu do
   not consume the new queries, and their existing fields and semantics stay
   compatible.
6. **The vendored protocol file is a mirror.** `gateway-protocol.ts` inside the
   Pi fork copies the authoritative contract for the isolated build; field-level
   contract tests keep both sides and the Web/Feishu consumers consistent.

## Consequences

- The September 20 review follow-up implements the existing client boundary
  with a dispatch-only `main.ts` and a lazy non-client `main-runtime.ts`.
  Static dependency traversal includes the CLI, TUI and presentation type
  dependencies. This is enforcement of this ADR, not a new Gateway contract;
  Web and Feishu handlers remain unchanged by the review fixes.

- Phase B of the 2026-09-19 design is implemented under this decision:
  protocol parsing and scope rules, hello capability advertisement, the
  read-only branch in `ClientGateway`, connection-scoped response publication,
  ephemeral connection-stream sequence reservation in the event journal, and
  the vendored client API (`getConversationHistory`, `completeCommand`,
  `getTaskView`, capability inspection, immutable-envelope resubmission).
- The Ink deletion, legacy InteractiveMode removal, and the full Pi component
  extraction remain gated on phases C–E of the governing design; this ADR
  authorizes that direction but not an unreviewed shortcut.
- Any future read-only Gateway extension follows the same rules: versioned
  capability, read-only admission branch, connection-scoped response, no
  durable draft persistence, and structured errors.


## 2026-10-03 多端观察与控制修订（ADR-0043）

[ADR-0043](0043-explicit-conversation-observation-and-client-read-models.md) 接管客户端详细观察与操作契约：同 Server/Account 的 Web、单一 TUI、Feishu 同权，origin 仅记录来源；查询/命令回执定向请求连接，共享事实发给明确订阅者。浏览和恢复使用有界读模型，不经执行 attach。`cancel_turn` 保持精确 Turn 语义；后台任务使用 Task ID + execution generation 的 `cancel_task`。`permission_resolution_v2` 携带请求 revision 和 generation，经既有 Permission/KernelWorkflow 持久仲裁与恢复应用。通知目的地独立持久化，不随浏览或操作端漂移。源码实施及尚未关闭的发布门见[实施记录](../plans/2026-10-02-frontend-observation-implementation.md)。


## 2026-10-03：Workspace 任务概览与导航修订

按用户确认，右侧 Task Dashboard 展示当前 Workspace 内已加载会话的活动任务概览，包含执行、排队、阻塞等 TaskView 阶段；不再复制选中 Turn 的执行详情。左侧保留对话与执行过程，费用属于对应 Turn。F6 聚焦任务列表，方向键选择、Enter 按 Conversation/Task 定位原 Turn，Esc 返回输入；宽屏支持点击，窄屏复用同一列表浮层。

目录与 activity 资源有界读取并持续刷新，更多会话/任务显式分页，计数明确为已加载范围。只有选中的 Conversation 保持详细观察；后台任务不因离开视图而停止。新增 Gateway `get_conversation_resource` 的 `locate` 资源复用已有授权定位 port，以 Task 身份定位旧 Turn，不执行 attach 或激活 Planner。导航、草稿与阅读位置仍是客户端本地状态。

实施与验证见 [TUI 任务概览记录](../plans/2026-10-03-tui-workspace-task-dashboard.md)。
