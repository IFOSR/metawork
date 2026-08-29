# 来源端实时展示与账号级历史同步实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Status:** Implemented (2026-08-29); awaiting final user review and commit

**Plan date:** 2026-08-29

**Design:** [来源端实时展示与账号级历史同步设计](2026-08-29-origin-scoped-realtime-account-history-design.md)

**Goal:** 让 Web、Feishu、TUI 只实时展示各自发起的当前回合，同时继续把所有入口的内容持久化到同一 Account/Conversation 历史，并在其他客户端打开、刷新、切换或重连时完整回放。

**Architecture:** 保留 AccountRuntime、WorkspaceDirectory、Conversation、Planner、Kernel、Executor 和 Feishu 原有所有权边界。为 Gateway 命令保留来源连接上下文，在内部实时订阅层按来源连接过滤详细事件；EventJournal replay 不做来源过滤，Web/Feishu/TUI attach 或历史读取时重建完整授权历史。Feishu 不新增交互协议，TUI 不做产品化重构。

**Tech Stack:** Node 22.19+, TypeScript ESM, Vitest, versioned Gateway JSONL, Unix socket Gateway, loopback HTTP/WebSocket, React/Vite, existing Feishu WebSocket/webhook adapters, file EventJournal, native Server/TUI/Web smoke tests.

---

## 0. Execution Constraints

- 先完成设计评审和 ADR/当前文档修订，再修改生产代码。
- 本计划执行时必须遵守 ADR-0020 的模块 ownership 和依赖方向。
- 不删除、重置、迁移走或覆盖已有 Conversation、Task、Result、Artifact 或
  EventJournal 数据。
- 不引入 Conversation owner、writer lease、client write lock 或单客户端写入限制。
- 不创建第二个 AccountRuntime、KernelWorkflow、Planner 或 Executor 路径。
- Feishu 继续使用现有机器人消息、卡片、回复、历史和策略逻辑；本阶段只收紧
  其详细事件的实时订阅范围。
- TUI 保持当前命令/AI turn 分离和展示逻辑，不扩展跨客户端 reducer。
- 每个行为变更都先写失败测试，确认 RED，再实现最小改动，确认 GREEN。
- 事件回放必须兼容现有日志格式；若增加持久化字段，必须先定义版本兼容和迁移
  规则。优先使用不暴露来源元数据的内部 live delivery context，避免不必要的
  public event protocol/schema bump。
- 每个独立任务完成后运行对应 focused tests，并使用 Conventional Commit；不要
  修改或提交工作树中本任务之外的用户改动。

## 1. Authority and Contract Gate

**Files:**

- Create: `docs/adr/0036-origin-scoped-live-delivery-and-replay.md`
- Modify: `docs/adr/0031-account-runtime-and-unified-client-gateway.md`
- Modify: `CONTEXT.md`
- Modify: `docs/current/account-runtime-and-gateway-operations.md`
- Modify: `docs/current/technical-overview.md`
- Modify: `docs/current/technical-overview.zh-CN.md`
- Modify: `docs/adr/README.md`
- Test/reference: `docs/plans/2026-08-29-origin-scoped-realtime-account-history-design.md`

**Step 1: Record the accepted contract**

Document these facts before production implementation:

```text
durable history = Account/Conversation journal, replay to every authorized client
live detailed events = only the originating client connection
Feishu = existing Feishu-native message/card behavior
Web = primary surface, no live foreign-client overwrite
TUI = current behavior, no new synchronization product layer
```

Explicitly state that Workspace directory activity remains a bounded summary
projection and is not the detailed Conversation stream.

**Step 2: Define the internal origin context**

Use a narrow internal value such as:

```ts
interface GatewayTurnOrigin {
  readonly connectionId: string;
  readonly surface: 'web' | 'feishu' | 'tui' | 'local' | 'unknown';
}
```

Do not expose connection IDs in public event payloads or use them as Account or
Conversation authorization.

**Step 3: Define replay/live invariants**

Write down and test the invariant:

```text
replay(account, conversation) -> all authorized journal events
subscribe(account, conversation, origin=C) -> only live events targeted at C
```

**Step 4: Review the contract**

Run:

```bash
rg -n "origin-scoped|replay|live delivery|详细实时|来源端|Feishu|TUI" \
  CONTEXT.md docs/adr docs/current
```

Expected: current authority and design language do not describe Conversation
replay as an all-client live broadcast.

**Step 5: Commit the authority gate**

```bash
git add docs/adr CONTEXT.md docs/current
git commit -m "docs: define origin-scoped gateway live delivery"
```

## 2. Gateway Subscription Contract

**Files:**

- Modify: `src/gateway/gateway-subscriptions.ts`
- Modify: `src/gateway/client-events.ts` only if a type is required by the internal seam
- Create or modify: `tests/gateway/gateway-subscriptions.test.ts`
- Create if useful: `src/gateway/gateway-delivery-context.ts`
- Create if useful: `tests/gateway/gateway-delivery-context.test.ts`

**Step 1: Write failing subscription tests**

Cover:

- an origin-scoped subscriber receives an event targeted to its own connection;
- it does not receive an event targeted to another connection in the same
  Conversation;
- a subscriber without an origin filter keeps explicit legacy behavior only for
  non-detailed/system projections, not as the default detailed client path;
- an event with no live target is not broadcast as detailed live output;
- account and Conversation filters still work;
- one listener throwing does not affect other listeners;
- replay is independent from subscription filtering.

**Step 2: Run RED**

```bash
npx vitest run tests/gateway/gateway-subscriptions.test.ts
```

Expected: the tests fail because subscriptions currently filter only by Account
and Conversation.

**Step 3: Implement the smallest internal filter**

Extend the subscription input with an internal optional live origin, for example:

```ts
readonly liveConnectionId?: string;
```

Extend publish with an internal delivery target, for example:

```ts
publish(event: GatewayEventEnvelope, target?: GatewayTurnOrigin): void
```

Do not add filtering to `EventJournal.replay`. Do not make public events carry
an internal connection ID solely to solve this problem.

**Step 4: Run GREEN and regression tests**

```bash
npx vitest run \
  tests/gateway/gateway-subscriptions.test.ts \
  tests/gateway/client-events.test.ts \
  tests/gateway/file-event-journal.test.ts
```

Expected: PASS, with existing journal sanitization and replay behavior unchanged.

**Step 5: Commit**

```bash
git add src/gateway/gateway-subscriptions.ts src/gateway/client-events.ts \
  tests/gateway/gateway-subscriptions.test.ts tests/gateway/gateway-delivery-context.test.ts
git commit -m "feat: scope gateway live events to origin connections"
```

## 3. Propagate Origin From Command Admission To Conversation Events

**Files:**

- Modify: `src/gateway/client-gateway.ts`
- Modify: `src/session/conversation-input-mailbox.ts`
- Modify: `src/gateway/conversation-gateway-runtime.ts`
- Modify: `src/server/server-composition.ts`
- Modify: `tests/gateway/client-gateway.test.ts`
- Modify: `tests/gateway/conversation-gateway-runtime.test.ts`
- Modify: `tests/session/conversation-session.test.ts` only where mailbox command fixtures require the new context

**Step 1: Write failing propagation tests**

Prove that:

- a Web/Feishu/TUI Gateway command reaches `ConversationGatewayRuntime` with
  the authenticated connection origin;
- `turn_started`, trace, result and final/terminal events are published with
  that origin target;
- two commands in the same Conversation can be accepted from different origins
  without either command being rejected for ownership reasons;
- command idempotency and completion recovery retain their current behavior;
- a system command that finishes before unrelated background work still keeps
  its own origin context and does not broadcast the background work.

Prefer changing the existing `submitToConversation`/mailbox handoff to carry a
small context object rather than adding several positional parameters.

**Step 2: Run RED**

```bash
npx vitest run \
  tests/gateway/client-gateway.test.ts \
  tests/gateway/conversation-gateway-runtime.test.ts
```

Expected: tests fail because `connectionId` is currently retained by command
admission but is not passed into the Conversation mailbox execution path.

**Step 3: Implement origin propagation**

Pass the authenticated transport-derived origin from `ClientGateway` through
`submitToConversation`, `MailboxCommand`, `ConversationGatewayRuntime.execute`
and its internal `publish` calls. Keep origin internal to Gateway/Application
Shell contracts; Planner, Kernel and Executor APIs must not gain client-origin
semantics.

For events generated without a command origin, publish with no live target so
they remain durable and replayable but are not sent as detailed live events to
all attachments.

**Step 4: Run GREEN**

```bash
npx vitest run \
  tests/gateway/client-gateway.test.ts \
  tests/gateway/conversation-gateway-runtime.test.ts \
  tests/session/conversation-session.test.ts
```

Expected: PASS, including existing command completion, recovery and background
Task projection tests.

**Step 5: Commit**

```bash
git add src/gateway/client-gateway.ts src/session/conversation-input-mailbox.ts \
  src/gateway/conversation-gateway-runtime.ts src/server/server-composition.ts \
  tests/gateway/client-gateway.test.ts tests/gateway/conversation-gateway-runtime.test.ts \
  tests/session/conversation-session.test.ts
git commit -m "feat: preserve gateway turn origin through execution"
```

## 4. Native Gateway Server and TUI Live Isolation

**Files:**

- Modify: `src/gateway/server.ts`
- Modify: `src/tui-bridge/planner-tui-bridge.ts` only if the existing client connection identity is not passed to subscriptions
- Test: `tests/gateway/server-lifecycle.test.ts`
- Test: existing `planner/AnyFusion-Pi/packages/coding-agent/test/metawork-client-reducer.test.ts` only if a replay classification regression appears

**Step 1: Write failing lifecycle tests**

Connect two native Gateway clients to one Conversation. Start a turn from
client A and assert:

- client A receives the live `turn_started`/trace/final sequence;
- client B receives no detailed live events for A's turn;
- after client B reattaches/reconnects and replays, client B receives A's
  durable history;
- events from client B follow the inverse rule;
- attachment authorization, cursor replay, event deduplication and socket
  cleanup remain unchanged.

**Step 2: Run RED**

```bash
npx vitest run \
  tests/gateway/server-lifecycle.test.ts
```

Expected: the second attached client currently receives the same live
Conversation events.

**Step 3: Implement connection-scoped subscriptions**

When a native connection binds its authenticated `connectionId`, subscribe to
the Conversation with that live origin. Keep the existing replay-before-live
buffering and `eventId` deduplication. Do not filter the journal replay.

The TUI rendering/reducer code should receive the same event sequence it
received for its own turn. Do not add cross-client history merge logic to the
TUI.

**Step 4: Run GREEN**

```bash
npx vitest run \
  tests/gateway/server-lifecycle.test.ts \
  tests/gateway/gateway-load.test.ts
```

Expected: PASS without changing the TUI system-command/AI-turn semantics.

**Step 5: Commit**

```bash
git add src/gateway/server.ts src/tui-bridge/planner-tui-bridge.ts \
  tests/gateway/server-lifecycle.test.ts
git commit -m "fix: isolate native client live conversation events"
```

## 5. Feishu Native Message Delivery Isolation

**Files:**

- Modify: `src/gateway/feishu-gateway-session-port.ts`
- Modify: `src/gateway/feishu-gateway-adapter.ts` only if origin data is needed at the adapter seam
- Modify: `src/integrations/feishu-app.ts` only if subscription registration needs a narrow type change
- Modify: `tests/gateway/feishu-gateway-session-port.test.ts`
- Modify: `tests/integrations/feishu-app.test.ts`
- Modify: `tests/gateway/feishu-conversation-routing.test.ts` if route connection assertions need coverage

**Step 1: Write failing Feishu tests**

Cover:

- a Feishu-origin task still sends progress and final replies in the originating
  chat/thread;
- a Web-origin event in the same Conversation does not trigger a Feishu
  unsolicited progress/final delivery;
- a TUI-origin event does not trigger Feishu delivery;
- two Feishu chat/thread bindings remain isolated from each other;
- `/history`, `/conversations`, `/conversation <id>` and card pagination still
  read the full durable history;
- existing Feishu policy, audit, chunking, retry and artifact delivery tests
  remain valid.

**Step 2: Run RED**

```bash
npx vitest run \
  tests/gateway/feishu-gateway-session-port.test.ts \
  tests/integrations/feishu-app.test.ts \
  tests/gateway/feishu-conversation-routing.test.ts
```

Expected: an attached Feishu session currently sees Conversation events without
checking their origin.

**Step 3: Implement only the subscription boundary**

Subscribe the Feishu live attachment and terminal waiter with the existing
chat/thread-derived connection ID. Keep Feishu's current formatting and send
path unchanged. Keep replay/history unfiltered so a Feishu user can still use
the existing explicit history commands to see authorized turns from other
surfaces.

Do not introduce a Web notification relay, Feishu-specific sync state machine,
or a new Feishu message protocol.

**Step 4: Run GREEN**

```bash
npx vitest run \
  tests/gateway/feishu-gateway-session-port.test.ts \
  tests/integrations/feishu-app.test.ts \
  tests/gateway/feishu-conversation-routing.test.ts \
  tests/gateway/feishu-policy.test.ts
```

Expected: PASS with unchanged Feishu-native message behavior.

**Step 5: Commit**

```bash
git add src/gateway/feishu-gateway-session-port.ts src/gateway/feishu-gateway-adapter.ts \
  src/integrations/feishu-app.ts tests/gateway/feishu-gateway-session-port.test.ts \
  tests/integrations/feishu-app.test.ts tests/gateway/feishu-conversation-routing.test.ts
git commit -m "fix: scope Feishu live delivery to its chat origin"
```

## 6. Web Replay and Refresh Rebuild

**Files:**

- Modify: `src/management/web-gateway-adapter.ts`
- Modify: `src/management/web-gateway-session-runtime.ts`
- Modify: `src/management/web-session-runtime-types.ts` only if an explicit refresh operation is needed
- Modify: `src/management/server.ts` only if a refresh endpoint/command is required by the existing API
- Modify: `web/src/api/ws.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/api/session-types.ts`
- Modify: `web/src/api/types.ts`
- Modify: `web/src/components/ConversationView.tsx`
- Modify: `web/src/components/ConversationTurn.tsx` only if stable origin/history presentation is required
- Test: `tests/management/web-gateway-session-runtime.test.ts`
- Test: `tests/management/server.test.ts`
- Test: `tests/web/conversation-view.test.ts`
- Test: `tests/web/session-selection.test.ts`

**Step 1: Write failing Web replay tests**

Build a journal with at least two turns in one Conversation, one originating
from Web and one from Feishu/TUI. Prove that:

- a newly attached Web runtime reconstructs both turns;
- the current Web live view does not receive the foreign turn before refresh;
- after refresh/re-attach, the foreign turn appears in stable journal order;
- a Conversation switch does not leave stale turns from the previous session;
- a reconnect replays from the cursor/snapshot without duplicate turns;
- a stale cursor rebuilds a complete bounded view instead of only the latest
  query;
- Composer draft and attachment state are not accidentally submitted or
  discarded by a history refresh unless the existing UI contract says so.

**Step 2: Run RED**

```bash
npx vitest run \
  tests/management/web-gateway-session-runtime.test.ts \
  tests/management/server.test.ts \
  tests/web/conversation-view.test.ts \
  tests/web/session-selection.test.ts
```

Expected: tests expose either foreign live-event consumption or incomplete
reconstruction when Web has not previously observed the other-origin turn.

**Step 3: Implement full replay semantics**

Pass the Web runtime's connection ID into its live subscription. Keep its
existing replay path unfiltered. On attach/reconnect/explicit refresh:

1. clear only the selected Conversation's derived turn/read-model state;
2. retain App-owned draft and attachment state according to the existing Web
   tab contract;
3. replay the full authorized Conversation snapshot/deltas;
4. merge by stable `turnId`/`eventId` and sequence;
5. rebuild execution/result projections from durable facts;
6. resume origin-scoped live delivery after the replay watermark.

Do not make Web create a new Conversation during refresh. Do not treat a
`conversation_snapshot` containing only the current output tail as the complete
history unless the journal replay contract explicitly says it is a compacted
snapshot source.

**Step 4: Run GREEN**

```bash
npx vitest run \
  tests/management/web-gateway-session-runtime.test.ts \
  tests/management/server.test.ts \
  tests/web/conversation-view.test.ts \
  tests/web/session-selection.test.ts
```

Expected: Web only receives its own live turn events, while attach/refresh
shows all replayable authorized turns.

**Step 5: Commit**

```bash
git add src/management/web-gateway-adapter.ts src/management/web-gateway-session-runtime.ts \
  src/management/web-session-runtime-types.ts src/management/server.ts web/src/api/ws.ts \
  web/src/App.tsx web/src/api/session-types.ts web/src/api/types.ts \
  web/src/components/ConversationView.tsx web/src/components/ConversationTurn.tsx \
  tests/management/web-gateway-session-runtime.test.ts tests/management/server.test.ts \
  tests/web/conversation-view.test.ts tests/web/session-selection.test.ts
git commit -m "fix: rebuild Web conversations from complete replay history"
```

## 7. End-to-End Cross-Surface Acceptance

**Files:**

- Create or modify: `tests/e2e/account-conversation-origin-delivery.test.ts`
- Modify if required: `tests/e2e/workspace-conversation-directory-browser.test.ts`
- Modify if required: `tests/e2e/web-routing-identity-and-theme.test.ts`
- Modify if required: `tests/integrations/feishu-app.test.ts`
- Modify: `docs/current/account-runtime-and-gateway-operations.md` for final behavior evidence
- Modify: `docs/current/technical-overview.md` and `docs/current/technical-overview.zh-CN.md`

**Step 1: Write the cross-surface scenario**

Use one Account, one Workspace and one Conversation:

```text
1. Open Web and attach Conversation A.
2. Submit a Web turn; verify only Web receives detailed live events.
3. Submit a Feishu turn; verify Feishu receives native progress/final messages.
4. Verify current Web does not change from Feishu's live events.
5. Refresh/reopen Web Conversation A; verify both turns and safe execution facts.
6. Submit a TUI turn; verify TUI keeps its current display and Web is unchanged live.
7. Reopen Web again; verify all three origins appear once in order.
8. Disconnect an origin during work; verify Task continues and later replay works.
```

**Step 2: Run focused E2E**

```bash
npx vitest run tests/e2e/account-conversation-origin-delivery.test.ts
```

Expected: PASS for live isolation, complete replay, no duplicate events and no
cross-client overwrite.

**Step 3: Run architecture/security regressions**

```bash
npm run lint
npx vitest run \
  tests/security/gateway-account-isolation.test.ts \
  tests/gateway/file-event-journal.test.ts \
  tests/gateway/command-admission-store.test.ts \
  tests/gateway/server-lifecycle.test.ts \
  tests/management/web-gateway-session-runtime.test.ts \
  tests/gateway/feishu-gateway-session-port.test.ts
```

Expected: PASS. If SQLite/POSIX-path coverage is required by the repository
guidelines, run the focused suite in Docker rather than repeatedly retrying the
host environment.

**Step 4: Run native Server/TUI/Web smoke**

```bash
npm run smoke:metawork
```

Expected: existing Planner/TUI smoke remains green, and the cross-client
changes do not stop Server work when a client exits.

**Step 5: Record final evidence**

Update the current technical docs with delivered behavior, validation commands,
known limitations and the completion date. Do not mark the design or plan
completed until the cross-surface scenario and required focused regressions
pass.

**Step 6: Commit documentation evidence**

```bash
git add docs/current docs/plans/2026-08-29-origin-scoped-realtime-account-history-*.md \
  tests/e2e/account-conversation-origin-delivery.test.ts
git commit -m "docs: record cross-client conversation delivery behavior"
```

## 8. Final Release Gate

The implementation may be reported complete only when:

- the authority update and implementation are shipped together;
- all existing journal data remains readable and replayable;
- Web, Feishu and TUI have origin-scoped live detailed events;
- replay remains Account/Conversation complete and origin-unfiltered;
- Feishu retains its existing native message behavior;
- TUI behavior remains unchanged except for no longer receiving foreign live
  detailed events;
- Web attach/refresh/reconnect rebuilds the full Conversation history;
- no owner/lease/second runtime/second protocol was introduced;
- focused tests, lint and the applicable native/Docker smoke gates pass;
- the plan records delivered files, validation evidence, completion date and
  closing commit.

## 9. Delivery Evidence (2026-08-29)

Implementation was completed on the current `main` working tree at the user's
request, without creating a branch and without intermediate commits. The user
will review and commit the combined change set.

Authority updates:

- Created `docs/adr/0036-origin-scoped-live-delivery-and-replay.md` (Accepted).
- Amended `docs/adr/0031-account-runtime-and-unified-client-gateway.md`
  (live-delivery origin scoping, replay-unfiltered rule).
- Updated `CONTEXT.md`, `docs/current/account-runtime-and-gateway-operations.md`,
  `docs/current/technical-overview.md`, `docs/current/technical-overview.zh-CN.md`,
  and `docs/adr/README.md`.

Source changes:

- `src/gateway/gateway-delivery-context.ts` (new): internal `GatewayTurnOrigin`.
- `src/gateway/gateway-subscriptions.ts`: `liveConnectionId` + `publish(event, target)`;
  origin-scoped detailed kinds (`turn_started`, `trace_delta`, `task_projection`,
  `execution_delta`, `permission_request`, `artifact`, result events,
  `final_answer`, `terminal_error`, `delivery_status`, `conversation_snapshot`,
  `conversation_history_page`).
- `src/session/conversation-input-mailbox.ts`: `MailboxCommand.origin`.
- `src/gateway/conversation-gateway-runtime.ts`: origin through
  `submit -> submitOnce -> mailbox -> execute -> publish`; active-origin map for
  projection events; untargeted detailed events remain durable but are not
  broadcast live.
- `src/gateway/client-gateway.ts`: derives origin from authenticated transport and
  envelope `connectionId`, passes it to `submitToConversation`.
- `src/server/server-composition.ts`: forwards origin into the runtime.
- `src/gateway/server.ts`: native attachment claims its `connectionId`.
- `src/gateway/feishu-gateway-session-port.ts`: live attachment and terminal
  waiter claim the chat/thread connection identity.
- `src/management/web-gateway-adapter.ts` and
  `src/management/web-gateway-session-runtime.ts`: Web subscription claims the
  Web client connection identity; replay stays unfiltered.

Validation evidence:

- `npx vitest run tests/gateway` (excluding the pre-existing slow
  `conversation-gateway-runtime` oversized-chunk test, which was run separately
  and passed): 32 files / 167 tests passed.
- `tests/gateway/conversation-gateway-runtime.test.ts`: 27 tests passed,
  including three new origin-delivery tests.
- `tests/gateway/client-gateway.test.ts`: 14 tests passed, including origin
  propagation.
- `tests/gateway/feishu-gateway-session-port.test.ts` (9), `server-lifecycle.test.ts`
  (12), `scripted-gateway-session.test.ts` (3), `gateway-subscriptions.test.ts` (6)
  passed.
- `tests/management` + `tests/security`: 18 files / 108 tests passed.
- `tests/e2e/account-conversation-origin-delivery.test.ts` (new): 1 passed.
- `tests/e2e/web-image-planner-flow.test.ts`: 1 passed.
- `npm run lint` (tsc --noEmit): clean.

Known out-of-scope observations:

- `tests/session/scripted-session.test.ts` has one pre-existing failure in the
  `/task unblock` output wording. It belongs to the user's in-flight Task/Kernel
  work and is unrelated to origin-scoped delivery; it was not modified.
- `npm run smoke:metawork` (live Planner smoke) and Docker SQLite/POSIX gates
  remain for the user to run with configured provider credentials before
  committing.
- Per the user's instruction, no commits were made; the final release gate
  "closing commit" is deferred to the user's review.
