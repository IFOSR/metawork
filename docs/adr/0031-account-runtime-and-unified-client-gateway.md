# ADR-0031: Account Runtime And Unified Client Gateway

- **Status**: Accepted
- **Date**: 2026-08-18
- **Scope**: Client connectivity, account/runtime ownership, conversation identity, Gateway ingress/egress, and multi-surface session routing
- **Amends**: ADR-0011, ADR-0015, ADR-0020, ADR-0022, ADR-0023
- **Preserves**: ADR-0017, ADR-0018, ADR-0021, ADR-0024, ADR-0025, ADR-0026, ADR-0027, ADR-0028, ADR-0029, ADR-0030
- **Related design**: `docs/plans/2026-08-18-account-runtime-unified-gateway-design.md`
- **Implementation plan**: `docs/plans/2026-08-18-account-runtime-unified-gateway-implementation-plan.md`
- **Governed by**: ADR-0020

## Context

AnyFusion currently has one local composition process, one SQLite database and
one Planner Host, but its client surfaces do not share one connectivity or
runtime ownership model:

- the Unix Socket Gateway creates one `MetaclawSession` per connection;
- Web owns a separate `WebSessionRuntime` and one globally active Web session;
- Feishu sends every accepted chat and user through one independently created
  `MetaclawSession`;
- Web, TUI and Gateway daemon modes are mutually exclusive under one process
  lock;
- user and chat identifiers are access-policy inputs rather than account,
  conversation or runtime ownership identities;
- every `MetaclawSession` constructs KernelWorkflow, Execution Runtime,
  recovery and repository-backed services even though those services operate
  on shared durable Task and Kernel state.

This topology works only under an implicit local-single-user and
single-semantic-session assumption. It does not support the product target in
which TUI, Web, Feishu and a future native App connect to one Server, and the
same authenticated account observes and controls the same durable Runtime from
all of those surfaces.

The required convergence must not collapse every client into one conversation.
Task, Kernel, Executor and configuration state should be shared at the account
boundary, while Planner dialogue, user-visible trace and input ordering remain
isolated at the conversation boundary.

## Decision

### 1. Fixed Cardinality And Vocabulary

The target ownership hierarchy is:

```text
ServerProcess
  -> RuntimeRegistry
    -> AccountRuntime (one live instance per loaded Account)
      -> ConversationRegistry
        -> ConversationSession (many per AccountRuntime)
          -> ClientConnection (many attachments)
```

The terms have these meanings:

- **Principal**: an authenticated external identity presented by a client
  transport, such as a local installation identity, Web session, Feishu user or
  future App credential.
- **Account**: the durable security, configuration, memory, Task, Kernel,
  Executor and storage namespace to which a Principal is authorized.
- **AccountRuntime**: the single live application/runtime coordinator for one
  loaded Account. It owns account-wide durable recovery, Kernel sequencing,
  Task admission, execution supervision, configuration binding and event
  publication.
- **Conversation**: a durable user interaction thread inside one Account. It
  owns one stable Planner session identity and bounded user-facing conversation
  projections.
- **ConversationSession**: the live Application-Shell object for one
  Conversation. It owns input serialization, Planner turn state, focus,
  presentation output and safe trace projection. It does not own Kernel,
  scheduling, recovery or Executor services.
- **ClientConnection**: a transient authenticated transport attachment to one
  Account and optionally one Conversation. Disconnecting it does not destroy
  either the AccountRuntime or Conversation.
- **Gateway**: the sole user-message connectivity plane. It authenticates a
  Principal, resolves Account and Conversation identity, admits a versioned
  client command, and streams bounded user-visible events back to attached
  clients.

One Account may have many Conversations. One Conversation may be attached from
many client surfaces. Sharing an AccountRuntime does not imply sharing Planner
conversation history.

### 2. AccountRuntime Is The Runtime Ownership Boundary

Runtime-wide services move out of `MetaclawSession` and are constructed once per
AccountRuntime:

- account configuration and runtime-binding resolution;
- account data store and repositories;
- durable Kernel coordinator and decision/application recovery;
- Task and Work Graph runtime services;
- Executor registry, attempt supervision and WorkUnit/resource coordination;
- startup recovery, timers, publication and cancellation recovery;
- account event journal and subscription hub.

`ConversationSession` receives narrow ports from AccountRuntime. It may submit a
validated Planner proposal or deterministic command and subscribe to account
facts, but it may not construct another KernelWorkflow, recover global state,
claim work, start an Executor or write account repositories directly.

AccountRuntime startup recovery runs once when the account is activated, not
once per client connection or Conversation.

### 3. Kernel Coordination Is Account-Scoped And Single-Writer

Each AccountRuntime has one durable Kernel coordinator. It is the only
Application-layer owner allowed to claim and apply account Kernel events.

Kernel inbox/application claims must be scoped to the account data store and
must never be drained by a per-conversation workflow. Task-specific workflows
may retain a `taskId` filter, but their application still runs through the same
account coordinator and ownership fence.

The coordinator serializes decision issue/application for one account while
allowing the already-authorized Subtask attempt concurrency defined by
ADR-0025/0026. A Conversation may prepare a Planner proposal concurrently with
another Conversation, but all mutating proposals are revalidated against a
fresh account snapshot when admitted by the coordinator.

### 4. ADR-0011 Is Scoped Per AccountRuntime

The single-active-top-level-Task rule remains in force, but its owner is one
AccountRuntime rather than an unqualified installation-global Session.

The first implementation may support only the migrated `local-default` account,
so observable Task capacity remains unchanged. Supporting more accounts later
does not authorize multi-Task scheduling inside an account; each AccountRuntime
still admits at most one active top-level Task until the independent
multi-Task roadmap amends ADR-0011.

### 5. All User Interaction Surfaces Use Gateway

TUI, Web conversation, Feishu and the future App must submit user interaction
through the same versioned Gateway command port. No surface may directly own or
call `MetaclawSession`, Planner submission, KernelWorkflow or Executor APIs.

Allowed direct Application-Shell paths are limited to non-conversation
administration such as installer/update control, health checks and
configuration management. If such a path changes account runtime state, it
must use an explicit account administration facade rather than a client
conversation shortcut.

The Gateway is transport-neutral. Unix socket, HTTP/WebSocket, Feishu
WebSocket/webhook and future App transports normalize into the same command and
attachment contracts. Platform adapters do not contain Planner, routing,
Kernel, retry, recovery or delivery policy.

### 6. Authentication And Account Resolution

The Gateway derives `accountId` from trusted server-side identity mapping. A
client-supplied account ID is a request hint at most and never authority.

The minimum identity mappings are:

- local TUI/CLI: installation-owned local Principal to `local-default`;
- Web: authenticated Web Principal to an authorized Account;
- Feishu: app/tenant identity plus user identity to an authorized Account;
- future App: authenticated device/user Principal to an authorized Account.

An account resolver returns an authorization result before Runtime activation.
Unknown, revoked, cross-tenant or ambiguous mappings fail closed. Pairing grants
access to an Account; it does not merge conversations or make a platform user
the Account ID.

### 7. Conversation Resolution And Cross-Surface Continuity

Gateway resolves one stable `conversationId` after account authorization.
Conversation selection follows these rules:

- an explicit authorized conversation attachment resumes that Conversation;
- otherwise a transport binding may map a platform chat/thread to a stable
  Conversation inside the Account;
- otherwise Gateway creates a new Conversation;
- the same Account alone is not sufficient to merge two conversations.

Feishu group, DM and thread identities must not share Planner history unless an
explicit binding says they are the same Conversation. Web tabs may attach to the
same Conversation, while the Web session rail may browse and activate different
Conversations. TUI and future App clients may resume a Web or Feishu
Conversation only through an explicit authorized attach flow.

Each Conversation has one serialized input mailbox. Multiple connections may
observe it concurrently, but only one user turn in that Conversation may be
active at a time. Separate Conversations may run Planner turns concurrently;
their account-mutating proposals still cross the account Kernel coordinator.

### 8. Versioned Gateway Command And Event Contracts

Gateway ingress uses a versioned command envelope containing at minimum:

```text
protocolVersion
requestId
idempotencyKey
connectionId
conversationId or conversation selection request
command kind
user text and bounded attachment references
client capability set
resume cursor
```

Trusted server context adds Principal and Account identity after
authentication. Adapters may add transport metadata, but raw platform events
never enter Planning or Kernel.

Gateway egress uses an ordered account/conversation event envelope containing:

```text
protocolVersion
eventId
sequence
accountId
conversationId
requestId or turnId
event kind
sanitized payload
occurredAt
```

The event stream carries conversation output, safe interaction trace,
Task/execution projection, permission requests, artifacts, terminal replies and
structured errors. It never carries hidden chain-of-thought, raw prompts,
credentials, unrestricted tool payloads or unredacted stdout/stderr.

Command idempotency and event resume cursors are durable enough to prevent
duplicate user turns and to replay the bounded terminal/current state after
reconnect. Transport retry is not a new Planner turn or Kernel retry.

### 9. Account Data Isolation

Each Account owns a separate data root and SQLite database. The recommended
layout is:

```text
~/.anyfusion/
  accounts/
    <account-id>/
      account.json
      data/anyfusion.db
      planner/sessions/
      conversations/
      workspace-store/
      attempts/
      gateway/
```

Application release files and immutable product templates remain installation
global. Account configuration may reference shared product definitions, but
active configuration revision, secrets, generated runtime, durable Task state,
Planner sessions and workspaces are account-scoped.

Separate databases are chosen over adding `account_id` filters to every current
table. This makes a missing query filter unable to expose another account's
Task, memory, Planner or Kernel facts.

The existing installation is migrated transactionally into a reserved
`local-default` Account without changing user-visible Task capacity or Planner
session identity. Migration must use the native update/activation safety rules
of ADR-0030 and must not leave dual-read or dual-write paths.

### 10. Event Routing And Delivery

AccountRuntime publishes normalized account and conversation events to one
Application-owned event hub. Gateway subscriptions filter these events by
authorized Account and Conversation attachment.

Final answers and progress are routed by stored origin/attachment facts, not by
reading a shared Session output buffer. A turn records the originating
Conversation and request; Gateway may deliver it to all currently attached
connections for that Conversation and to the durable origin target required by
the platform.

Feishu cards, WebSocket messages, TUI rendering and future push notifications
are projections of the same event contract. Delivery failure is recorded as a
delivery fact and does not rerun Planning, Kernel or Executor work.

### 11. Lifecycle

Server startup creates the Gateway and RuntimeRegistry before accepting user
commands. AccountRuntime activation is lazy or eager according to deployment
configuration, but activation is single-flight per Account and completes
durable recovery before commands are admitted.

Client disconnect:

- detaches the ClientConnection;
- preserves the Conversation and AccountRuntime;
- does not stop Planner turns, Executor attempts or recovery.

Conversation deactivation may release its live Planner process only when its
input mailbox and Planner turn are idle. AccountRuntime deactivation requires
zero attached clients, no active Task/runtime work and a durable idle checkpoint.
The first release may keep `local-default` loaded for the process lifetime.

### 12. Ownership And Dependency Direction

ADR-0020 remains authoritative with these additions:

```text
Client adapters
  -> Gateway
  -> Account application facade
  -> Conversation / AccountRuntime ports
  -> Planning / Kernel coordinator / Execution Runtime
```

Prohibited dependencies:

- client adapters importing or constructing `MetaclawSession`;
- Gateway importing concrete Storage repositories, ControlKernel internals or
  Executor adapters;
- ConversationSession constructing Kernel, Execution Runtime, recovery or
  repository implementations;
- AccountRuntime interpreting natural-language semantics;
- Planner, Kernel or Executor depending on Gateway protocols or platform IDs;
- platform adapters writing Task, conversation, permission or delivery state
  outside their declared ports;
- any direct Web/Feishu/TUI compatibility path remaining after cutover.

Only the composition root and RuntimeRegistry factory may bind concrete account
storage, Planner, Kernel, Runtime and Gateway adapters.

## Consequences

- TUI, Web, Feishu and future App clients can observe the same account Task and
  execution state without sharing one unsafe global conversation.
- Planner history, trace and input ordering are isolated per Conversation.
- durable recovery and Kernel application become single-owner account
  operations rather than per-client side effects.
- account data is isolated structurally through separate stores instead of
  relying on pervasive query filters.
- the current `MetaclawSession` must be split; this is a material refactor and
  cannot be delivered as a transport-only patch.
- Web and Feishu direct Session paths, per-connection Gateway Session creation,
  and mode-exclusive client composition become migration targets and are
  removed after cutover.
- the first release may expose only `local-default`, but all new contracts carry
  explicit Account and Conversation identity so future multi-account support
  does not require another control-plane rewrite.

## Rejected Alternatives

### One Global MetaclawSession

Rejected because unrelated chats would share Planner history, trace, focus and
input state. It also leaves recovery and Runtime lifetime coupled to a
presentation object.

### One MetaclawSession Per Client Connection

Rejected because reconnect loses continuity, multiple clients duplicate
Runtime/recovery services, and account-wide Kernel state has no single owner.

### Shared SQLite With Account Columns Everywhere

Rejected for the initial architecture because one missing filter could expose
another account's data and because converting every existing repository would
create a broad permanent isolation burden.

### Separate Server Process Per Client Surface

Rejected because the instance lock, Planner Host, SQLite and Task admission
state require one authority. Multiple surface-specific runtimes would recreate
the conflicting control planes this ADR removes.

### Immediate Distributed Microservices

Rejected as unnecessary. AccountRuntime, Gateway and Conversation ports must be
process-separable, but the first implementation remains one Node process with
isolated Planner/Executor child processes. Remote service decomposition requires
a later ADR.

## Not Decided Here

- public cloud tenancy, billing, organization/workspace membership or account
  administration UI;
- concrete App authentication provider, OAuth flow or device-pairing UX;
- cross-account sharing, delegation or collaborative Conversations;
- multi-top-level-Task scheduling within one AccountRuntime;
- remote Server clustering, Gateway load balancing or distributed Kernel
  leadership;
- future A2A Executor transport, which remains governed by ADR-0029.
