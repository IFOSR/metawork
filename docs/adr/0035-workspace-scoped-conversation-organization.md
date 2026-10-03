# ADR-0035: Workspace-Scoped Conversation Organization

- **Status:** Accepted
- **Date:** 2026-08-27
- **Amended:** 2026-09-16
- **Amended by:** [ADR-0039](0039-web-workspace-creation-and-login.md)
- **Scope:** Workspace identity, Conversation organization, Client Workspace
  selection, Workspace directory projection, and Workspace/Conversation
  persistence
- **Amends:** ADR-0031, ADR-0034
- **Preserves:** ADR-0011, ADR-0015, ADR-0020, ADR-0022, ADR-0023, ADR-0024,
  ADR-0025, ADR-0026, ADR-0032, ADR-0033
- **Design:**
  `docs/plans/2026-08-27-workspace-scoped-conversation-organization-design.md`
- **Implementation plan:**
  `docs/plans/2026-08-27-workspace-scoped-conversation-organization-implementation-plan.md`
- **Governed by:** ADR-0020

## Context

ADR-0031 established Account-scoped Runtime ownership and independent
Conversations. ADR-0034 made Server startup Workspace-neutral and used a Client
startup directory to initialize a new Conversation Workspace.

That model stores a mutable path on each Conversation. It does not provide one
stable Workspace directory shared by TUI, Web and Feishu, and it overloads an
absolute path as product identity, execution binding and Conversation metadata.

Users enter MetaWork through a project Workspace and expect every authorized
Client in that Workspace to discover the same historical and running
Conversations without merging their Planner histories.

## Decision

### 1. Fixed Product Hierarchy

The product organization and query hierarchy is:

```text
ServerProcess
  -> RuntimeRegistry
    -> AccountRuntime
      -> WorkspaceDirectory
        -> Workspace
          -> ConversationRegistry references
            -> ConversationSession
              -> ClientConnection attachments
```

`AccountRuntime` remains the sole owner of Kernel, Task, Execution, recovery,
timers and durable account event publication. `WorkspaceDirectory` is an
Application-Shell organization and query service. It does not schedule work,
own a Kernel, construct an Executor or create a second Runtime boundary.

### 2. Workspace Identity

Each Account owns a Workspace Catalog. A Workspace has an immutable opaque
`workspaceId`, a display name, one current canonical local path binding,
availability, archive state and audit metadata.

The canonical path is not Workspace identity. The Server treats every path as
untrusted input, resolves and authorizes it, and ensures that one Account has at
most one active Workspace for an available canonical path. Missing historical
paths remain discoverable as unavailable Workspaces.

The product Workspace Catalog is stored under
`accounts/<account-id>/workspace-catalog/`. The existing
`accounts/<account-id>/workspace-store/` remains exclusively owned by the
Executor managed-workspace subsystem.

### 3. Conversation Binding

Every new Conversation is created inside an authorized Workspace and stores an
immutable Workspace binding:

```text
workspaceBinding:
  workspaceId
  boundAt
  boundByPrincipal
```

An empty Conversation may be rebound before its first ordinary user Query.
Admission of the first ordinary user Query locks the binding. Slash commands do
not lock it. After lock, `/workspace` never reparents, moves or silently copies
the Conversation. Explicit future migration or copy is a separate capability.

Every admitted Turn retains the authorized `workspaceId` and canonical path
that were resolved at admission. Workspace path availability changes do not
rewrite historical Turn identity.

### 4. Client Workspace Selection

Each authenticated Client connection or platform binding owns a transient
`activeWorkspaceId` and optional `activeConversationId`.

`/workspace <path>` selects the active Workspace for that Client or transport
binding. It does not mutate another Client and does not move the currently
attached Conversation. A new Conversation is created in the selected
Workspace.

Local TUI and Web startup cwd is only an untrusted Workspace selection hint.
Direct `--conversation <id>` attach restores that Conversation's Workspace and
does not apply the current cwd. Feishu has no cwd and requires an explicit or
persisted Workspace selection.

### 5. Workspace Directory And Detailed Replay

The Server exposes a bounded, paginated Workspace Conversation Directory with
title, preview, archive state, timestamps and Server-derived activity. Directory
events carry summaries only.

Conversation remains the isolation boundary for:

- one stable Planner history;
- serialized input mailbox;
- safe trace and execution projection;
- detailed replay, result chunks and live events.

A Client receives full history, trace and results only after authorized attach
to a specific Conversation. Entering a Workspace never subscribes the Client
to every Conversation's detailed stream.

### 6. Gateway And Surface Rules

TUI, Web, Feishu and future App surfaces use one Server-owned Workspace
Directory projection. They do not read Workspace Catalog or Conversation
persistence directly.

Web preserves its current Conversation, Trajectory, Execution, Artifact,
Settings and Composer information architecture. The Gateway and Web
Application-Shell projections remain a field superset of that experience.

TUI and Feishu may choose their own bounded presentation. Presentation state,
Workspace selector actions and directory events never enter Planner
transcripts.

### 7. Runtime And Scheduling Boundaries

Workspace organization does not amend ADR-0011. One AccountRuntime still admits
at most one active top-level Task. Multiple Conversations in one Workspace do
not gain independent scheduling or concurrent repository-write authority.

## Persistence And Migration

Conversation metadata format advances to v3 and stores
`workspaceBinding` instead of the legacy mutable `workspace` path.

Migration groups v2 Conversations by Server-canonicalized path, creates one
stable Workspace per path, preserves null bindings, and creates unavailable
Workspaces for missing historical paths. Catalog and Conversation files switch
atomically through a recoverable migration journal. Runtime performs no
long-term v2/v3 dual read or dual write after activation.

## Consequences

- One Account has a stable `Account -> Workspace -> Conversations` navigation
  model across all Clients.
- Conversations remain isolated semantic and replay threads.
- `/workspace` changes Client selection rather than historical Conversation
  ownership.
- Workspace directory summaries can be shared safely without broadcasting
  every detailed Conversation event.
- Workspace Catalog migration and Gateway protocol changes must ship as a hard
  cut in one release.

## Rejected Alternatives

### Keep A Flat Account Conversation Catalog

Rejected because project-oriented discovery remains inconsistent across
Clients and paths continue to act as accidental identity.

### Merge A Workspace Into One Conversation

Rejected because unrelated tasks would share Planner history, mailbox and
detailed events.

### Let Clients Build Their Own Workspace Directory

Rejected because it creates multiple authorities, bypasses authorization and
cannot project reliable running state.

### Reparent Conversations With `/workspace`

Rejected because it silently changes historical execution context and makes
cross-Client replay ambiguous.

## Navigation Read-Model Amendment (2026-09-26)

The approved [navigation remediation plan](../plans/2026-09-26-navigation-performance-architecture-remediation.md)
materializes the existing read contracts; it does not transfer lifecycle
ownership. Delivery and installed-runtime acceptance remain open.

- Workspace owns the directory projection port; Storage supplies its SQLite
  adapter. AccountRuntime supplies canonical activity. SQL invalidation triggers
  record identities, never interpret Task or Kernel states.
- Directory reads use an account/Workspace-scoped indexed page. A cursor carries
  the directory revision; concurrent changes reject it explicitly instead of
  silently skipping or duplicating rows. An incomplete rebuild is unavailable,
  not permission to execute the former full-catalog scan.
- Conversation/Application Shell owns metadata and history read ports.
  Indexed terminal turns and rich presentation use stable per-stream insertion
  sequences. Updating a Turn does not move it between older-history pages.
  Web must include canonical terminal turns even if no Web client observed them.
- Client navigation is observational. Workspace selection sends a current page
  to that connection; it does not append another durable selection snapshot.
  HTTP responses must reconcile newer row events and respect navigation request
  generations, including selecting the previously active Conversation again.
- Web history remains active-attachment scoped. Restoring a remembered
  Conversation outside the first directory page must not read its history
  before attachment. The attach request can carry an expected Workspace;
  the Application Shell compares it with the canonical binding before any
  selection change, then serves one bounded history page. The expectation is
  a fail-closed navigation guard, never Workspace or Account authority.
- Legacy files remain migration/recovery inputs. There is one production
  composition, not a parallel deployment. Source composition selects a single
  segmented Gateway writer and bounded background maintenance. Installed
  deployment remains gated by real-account migration/restart and Web/TUI
  acceptance; unchanged legacy files alone do not constitute a lossless rollback
  after new-format writes.
- Gateway owns the bounded reconnect/reset contract (`bounded_replay_v1`).
  Expired, future and over-budget cursors reset explicitly to a versioned
  snapshot and indexed history; unsupported clients fail explicitly. Clients
  cannot request unbounded audit replay as a navigation fallback.
- History-page billing/timeline/artifact enrichment uses read-only set
  projections of existing facts, not a new billing or Task lifecycle owner.
- Gateway owns the historical Turn/Task trace-observation projection, committed
  atomically with the journal watermark. Exact indexed lookup retains ambiguous
  evidence across Turn changes and compaction; it does not authorize lifecycle
  actions. Workspace activity publication reads binding metadata without
  hydrating the Conversation's historical record.


## 2026-10-03 多端观察与控制修订（ADR-0043）

[ADR-0043](0043-explicit-conversation-observation-and-client-read-models.md) 接管客户端详细观察与操作契约：同 Server/Account 的 Web、单一 TUI、Feishu 同权，origin 仅记录来源；查询/命令回执定向请求连接，共享事实发给明确订阅者。浏览和恢复使用有界读模型，不经执行 attach。`cancel_turn` 保持精确 Turn 语义；后台任务使用 Task ID + execution generation 的 `cancel_task`。`permission_resolution_v2` 携带请求 revision 和 generation，经既有 Permission/KernelWorkflow 持久仲裁与恢复应用。通知目的地独立持久化，不随浏览或操作端漂移。源码实施及尚未关闭的发布门见[实施记录](../plans/2026-10-02-frontend-observation-implementation.md)。
