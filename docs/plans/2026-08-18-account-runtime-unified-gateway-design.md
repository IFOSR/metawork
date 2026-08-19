# Account Runtime And Unified Gateway Design

> Status: Implemented
> Design date: 2026-08-18
> Implemented: 2026-08-19
> Governing ADR: ADR-0031

## Goal

Evolve AnyFusion from several mode-specific local interaction surfaces into one
Server architecture in which TUI, Web, Feishu and a future native App connect
through one Gateway and, after authentication, share the same AccountRuntime.

The design must preserve:

- Planner proposes, ControlKernel decides, Runtime applies;
- one active top-level Task per account;
- isolated AnyFusion-Pi Planner processes and trusted Executor boundaries;
- durable Kernel decisions, recovery, Work Graph and publication behavior;
- detailed streaming user-visible execution traces without hidden
chain-of-thought.

## Implementation Outcome

The selected AccountRuntime plus ConversationSession approach is the production
topology as of August 19, 2026. Runtime-wide Kernel, Execution and recovery
services are account-owned; Conversation mailboxes and Planner identity remain
isolated; Web, Feishu and Unix clients submit through `ClientGateway`; and the
native AnyFusion-Pi process is a Gateway-only UI while semantic Planner turns
remain server-side RPC. The pre-cutover diagnosis below is retained as the
historical input to this design.

## Current-State Diagnosis

The current composition shares a process and SQLite database, but not one
runtime ownership model:

| Surface | Current session model | Current limitation |
| --- | --- | --- |
| Native Planner TUI | one dedicated `MetaclawSession` | owns a separate direct Session path |
| Unix Socket Gateway | one new `MetaclawSession` per socket connection | reconnect loses Planner continuity; recovery/runtime services are duplicated |
| Web | one `WebSessionRuntime` with one active Web session | bypasses Gateway and cannot coexist with Gateway daemon mode |
| Feishu | all accepted events use one Gateway daemon Session | users/chats share Planner/output state and concurrent turns are not serialized |
| Future App | no contract | no account, conversation, resume or event protocol to target |

`MetaclawSession` currently combines two different lifetimes:

1. conversation lifetime: user input, Planner history, output, trace and focus;
2. account runtime lifetime: Kernel workflow, Task admission, startup recovery,
   Executor registry, attempts, publication, leases and timers.

The architecture must separate those lifetimes before adding another client.

## Approaches Considered

### Approach A: Keep One Global Session

All surfaces would attach to one `MetaclawSession`.

Advantages:

- smallest short-term change;
- all clients see the same output buffer.

Rejected because conversations, Planner history, permission presentation and
progress would leak across chats. A busy or disconnected client would also
control the lifetime of account-wide execution.

### Approach B: AccountRuntime Plus Conversation Sessions

One AccountRuntime owns shared durable and execution state. Each Conversation
owns a stable Planner session, serialized mailbox and presentation stream.
Every surface uses Gateway to attach to an account and conversation.

Advantages:

- matches the required product model;
- gives Kernel/recovery one owner;
- preserves independent conversation history;
- supports reconnect and cross-surface continuation;
- remains deployable as one Node process.

This is the selected approach.

### Approach C: Separate Runtime Service Processes Immediately

Gateway, Planner service, Kernel service and Executor service would become
networked microservices.

Rejected because it adds distributed leadership, service authentication,
network idempotency and deployment failure modes before the local ownership
boundaries are correct. The selected ports remain process-separable so a future
deployment ADR can split them later.

## Target Topology

```text
TUI adapter --------\
Web adapter ---------\
Feishu adapter --------> Client Gateway
Future App adapter ---/      |
                             v
                    Authentication + AccountResolver
                             |
                             v
                      RuntimeRegistry
                             |
                 +-----------+-----------+
                 |                       |
                 v                       v
          AccountRuntime A        AccountRuntime B
                 |
        +--------+---------+
        |                  |
        v                  v
 Conversation A1     Conversation A2
 Planner session A1  Planner session A2
        |                  |
        +--------+---------+
                 |
                 v
       Account Kernel Coordinator
                 |
                 v
      Task / Work Graph / Execution
```

The initial product loads only `local-default`, but the contracts and storage
layout use explicit account identity from the first migration.

## Domain Model

### Principal

An authenticated transport identity. Examples:

- local installation Principal;
- authenticated Web browser Principal;
- Feishu app tenant plus sender Principal;
- future native App device/user Principal.

Principal identity is not automatically an Account ID. The AccountResolver maps
it through trusted server-side policy.

### Account

The isolation and ownership namespace for:

- configuration revision and secrets;
- preferences and memory;
- Tasks, Work Graphs and Kernel facts;
- WorkUnits, attempts, workspaces and artifacts;
- Conversations and Planner session files;
- Gateway bindings and event journals.

### AccountRuntime

One live coordinator per loaded Account. It owns services that must not be
duplicated for each client:

- `AccountKernelCoordinator`;
- `TaskRuntimeService`;
- `KernelExecutionRuntime`;
- Executor and resource services;
- durable startup/recovery;
- account timers;
- `ConversationRegistry`;
- `AccountEventHub`.

### Conversation

A durable interaction thread with:

- stable `conversationId`;
- stable Planner session ID;
- account ownership;
- title and lifecycle state;
- source bindings;
- bounded terminal turn projections;
- current turn/replay cursor metadata.

A Conversation does not own Task or Executor state. It references account Tasks
by durable IDs.

### ClientConnection

A transient connection carrying:

- authenticated Principal and resolved Account;
- transport and capability metadata;
- optional attached Conversation;
- last acknowledged event cursor;
- delivery target.

Disconnecting a ClientConnection never disposes AccountRuntime.

## Runtime Components

### RuntimeRegistry

`RuntimeRegistry` is an Application-Shell service keyed by `accountId`.

Responsibilities:

- single-flight AccountRuntime activation;
- account authorization before activation;
- reference/idle lifecycle;
- shutdown ordering;
- health and diagnostics.

It does not interpret user text or perform Kernel decisions.

Suggested interface:

```ts
interface RuntimeRegistry {
  getOrActivate(account: ResolvedAccount): Promise<AccountRuntimeHandle>;
  getIfLoaded(accountId: string): AccountRuntimeHandle | null;
  shutdown(): Promise<void>;
}
```

### AccountRuntime

Suggested public facade:

```ts
interface AccountRuntime {
  readonly accountId: string;
  openConversation(selection: ConversationSelection): Promise<ConversationHandle>;
  submit(command: AccountCommand): Promise<CommandReceipt>;
  subscribe(listener: (event: AccountEvent) => void): () => void;
  getSnapshot(): AccountRuntimeSnapshot;
  closeWhenIdle(): Promise<'closed' | 'busy'>;
}
```

Only narrow facades are exposed. Gateway never receives concrete repositories,
Kernel or Executor instances.

### ConversationRegistry

Responsibilities:

- create/load durable Conversation metadata;
- maintain at most one live `ConversationSession` per Conversation;
- serialize activation and disposal;
- manage explicit transport bindings;
- enforce account ownership.

### ConversationSession

`ConversationSession` is the reduced successor to the conversation-facing part
of `MetaclawSession`.

It owns:

- one stable Planner session;
- one FIFO input mailbox;
- one current user turn;
- output and safe InteractionTrace projection;
- focused Task/reference state;
- conversation event publication.

It calls AccountRuntime through:

```ts
interface ConversationRuntimePort {
  submitPlannerProposal(input: AccountPlannerProposal): Promise<PlannerProposalResult>;
  submitCommand(input: AccountCommand): Promise<CommandReceipt>;
  queryPlanningContext(input: PlanningContextQuery): Promise<PlanningContextFacts>;
  subscribeAccountFacts(listener: (event: AccountFactEvent) => void): () => void;
}
```

It cannot construct or recover Kernel/Execution services.

### AccountKernelCoordinator

This is the single Application-layer writer for one account's durable Kernel
inbox and decision applications.

Responsibilities:

- enqueue idempotent events;
- serialize claim, decide and apply;
- rebuild a fresh snapshot for the exact claimed event;
- preserve task filters without per-conversation drainers;
- run startup recovery once;
- publish normalized decision/application events.

The pure `ControlKernel` remains unchanged in ownership.

### AccountEventHub

Publishes ordered sanitized events from:

- Conversation/Planner;
- Kernel authorization;
- Task and Work Graph changes;
- Executor progress;
- verification/publication;
- permission workflow;
- delivery.

Events are tagged with account and optional conversation/request/task identity.
The hub is presentation and integration infrastructure, not a policy engine.

## Gateway Design

### Logical Layers

```text
Transport Adapter
  -> Protocol Decoder
  -> Authenticator
  -> AccountResolver
  -> ConversationResolver
  -> Admission/Idempotency
  -> AccountRuntime Facade
  -> Event Subscription
  -> Transport Encoder/Delivery
```

### Transport Adapters

Adapters normalize platform events and render Gateway events:

- `LocalSocketGatewayAdapter`;
- `WebGatewayAdapter`;
- `FeishuGatewayAdapter`;
- future `AppGatewayAdapter`.

Adapters may handle transport authentication challenges, file upload/download
and platform formatting. They may not call Planning, Kernel or Executor
directly.

### Ingress Contract

```ts
interface GatewayCommandEnvelope {
  protocolVersion: 1;
  requestId: string;
  idempotencyKey: string;
  connectionId: string;
  conversation: {
    mode: 'attach' | 'bound' | 'new';
    conversationId?: string;
    binding?: {
      platform: string;
      channelId: string;
      threadId?: string;
    };
  };
  command:
    | { kind: 'user_message'; text: string; attachments: GatewayAttachmentRef[] }
    | { kind: 'slash_command'; text: string }
    | { kind: 'permission_resolution'; requestId: string; resolution: 'approve' | 'deny' }
    | { kind: 'cancel_turn'; turnId: string };
  resumeFromSequence?: number;
  clientCapabilities: string[];
}
```

The adapter cannot set trusted account identity. Gateway adds:

```ts
interface AuthenticatedGatewayCommand extends GatewayCommandEnvelope {
  principal: AuthenticatedPrincipal;
  accountId: string;
}
```

### Egress Contract

```ts
interface GatewayEventEnvelope {
  protocolVersion: 1;
  eventId: string;
  sequence: number;
  accountId: string;
  conversationId: string;
  requestId: string | null;
  turnId: string | null;
  kind:
    | 'conversation_snapshot'
    | 'turn_started'
    | 'trace_delta'
    | 'task_projection'
    | 'execution_delta'
    | 'permission_request'
    | 'artifact'
    | 'final_answer'
    | 'terminal_error'
    | 'delivery_status';
  payload: unknown;
  occurredAt: string;
}
```

Every payload passes the existing redaction and trace safety boundary before it
enters the event journal.

### Reconnect And Idempotency

- `requestId` identifies the client operation.
- `idempotencyKey` prevents duplicate turn creation after transport retry.
- `sequence` is monotonic within one Conversation event stream.
- reconnect presents the last acknowledged sequence;
- Gateway returns a bounded snapshot followed by missing deltas;
- an expired cursor returns a new snapshot rather than partial history.

Transport retry never creates a second Planner turn or Runtime command.

## Identity And Conversation Mapping

### Local TUI And CLI

The installed local Principal maps to the reserved `local-default` Account.
Unix peer restrictions, socket mode and an installation token protect the
connection. Each TUI launch may create a Conversation or explicitly attach to a
known Conversation.

### Web

Web authentication returns a Principal authorized for one or more Accounts.
The first local release authorizes only `local-default`. Tabs attach to the
selected Web Conversation rather than a process-global active Session.

### Feishu

Account mapping key:

```text
feishu app identity + tenant identity + sender identity
```

Conversation binding key:

```text
accountId + platform + chatId + optional threadId
```

DMs, groups and threads therefore remain separate Conversations by default.
Pairing grants Account access; it does not merge chat histories.

### Future App

The App uses the same Gateway protocol after authentication. It does not require
another Runtime or client-specific Planner path.

## Storage Layout

```text
~/.anyfusion/
  app/                         # installation-global immutable releases
  accounts/
    local-default/
      account.json
      config/
        active
        revisions/
      secrets/
      generated/
      data/
        anyfusion.db
      planner/
        sessions/
      conversations/
        catalog.json
        records/
      workspace-store/
      attempts/
      gateway/
        bindings.json
        event-journal/
```

The first migration moves or re-points existing account-owned paths into
`accounts/local-default/` through the transactional updater. No runtime
dual-read fallback is allowed.

Conversation records remain Application-Shell projections, while authoritative
Planner history remains in the Planner session file and authoritative Task/
Kernel/Execution facts remain in SQLite.

## Concurrency Model

### Per Conversation

- one FIFO mailbox;
- one active user turn;
- one active Planner writer;
- many read-only client subscriptions;
- cancel targets one explicit turn.

### Per Account

- one Kernel decision/application coordinator;
- one ADR-0011 top-level Task admission slot;
- up to the existing configured Subtask attempt concurrency;
- many Conversation Planner turns may prepare proposals;
- mutating proposals are admitted serially against fresh account facts.

### Across Accounts

AccountRuntime instances have separate databases, Planner directories,
workspaces and Kernel coordinators. The process may share immutable program
assets and bounded host resources, but no account state.

## Lifecycle And Recovery

### Server Startup

1. acquire the installation process lock;
2. verify release/configuration compatibility;
3. start Gateway listeners;
4. initialize account registry;
5. activate configured eager accounts;
6. run account recovery before opening their command admission;
7. begin accepting authenticated client commands.

### Account Activation

Activation is single-flight:

1. resolve and validate account metadata;
2. open account database and configuration;
3. construct account Runtime services;
4. recover Kernel applications, attempts, publication and cancellation;
5. start account timers;
6. mark account admission open.

### Conversation Activation

Conversation activation:

1. verify account ownership;
2. load/create metadata;
3. construct Planner/session projection ports;
4. restore stable Planner session identity;
5. attach the input mailbox and event stream.

It does not run account startup recovery.

### Shutdown

1. Gateway closes new command admission;
2. active commands reach durable accepted/rejected/uncertain state;
3. AccountRuntimes checkpoint and stop timers;
4. Planner and Executor child processes are fenced or drained through their
   existing lifecycle;
5. listeners and process lock close last.

## Error Handling

- authentication or account mapping ambiguity fails before Runtime activation;
- conversation ownership mismatch returns a structured authorization error;
- duplicate command returns the original receipt;
- a busy Conversation queues or rejects according to command kind, never runs
  two turns concurrently;
- stale event cursors receive a current snapshot;
- AccountRuntime activation failure quarantines that Account without taking
  healthy Accounts down;
- Kernel application uncertainty remains a durable account fact;
- delivery failure does not repeat semantic or execution work;
- a corrupt conversation projection can be rebuilt from authoritative durable
  facts where possible;
- hidden reasoning and sensitive data remain excluded from all Gateway events.

## Migration Strategy

### Phase 0: Characterize And Fence

Add tests proving current mode/session cardinality and the cross-session Kernel
queue risk. Introduce no behavior change.

### Phase 1: Identity And Protocol Contracts

Define Account, Principal, Conversation, Gateway command/event and error
contracts. Add `local-default` identity without moving data yet.

### Phase 2: Account Data Root

Add account path resolution and transactional migration of current data into
`accounts/local-default`.

### Phase 3: Extract AccountRuntime

Move Kernel, Task, Execution, recovery and timers out of `MetaclawSession`.
Keep a compatibility composition adapter only inside tests until all surfaces
move.

### Phase 4: Conversation Runtime

Add Conversation registry, stable Planner identity, FIFO mailbox and event
projection.

### Phase 5: Unified Gateway Core

Implement authentication, account/conversation resolution, idempotent command
admission, event journal and subscription/replay.

### Phase 6: Web Cutover

Move Web user input and event streaming to Gateway. Keep management/configuration
HTTP endpoints as separate Application-Shell administration.

### Phase 7: Feishu Cutover

Map Principal and chat/thread bindings, isolate Conversations, and route all
progress/final delivery from Gateway events.

### Phase 8: TUI Cutover

Make the native TUI a Gateway client. Keep AnyFusion-Pi as the server-controlled
Planner process rather than a client-owned Runtime.

### Phase 9: Remove Direct Paths

Delete per-connection Session creation, direct Feishu Session calls, Web active
Session ownership and any compatibility composition that can construct a
second Runtime.

### Phase 10: App Readiness And Hardening

Publish a stable client protocol package, run multi-surface acceptance, validate
reconnect/restart, and document the future App integration seam.

## Acceptance Criteria

The design is delivered only when:

1. TUI, Web and Feishu can be active against one Server process.
2. Every user command enters through Gateway.
3. Same-account clients observe the same Task, Kernel and Executor state.
4. Different Conversations never share Planner history or mutable trace state.
5. Feishu chats/threads map to isolated Conversations by default.
6. reconnect does not create a duplicate turn and replays current state.
7. startup recovery runs once per AccountRuntime, not per connection.
8. one account Kernel coordinator owns all decision/application drains.
9. account data is stored under an isolated account root.
10. the migrated `local-default` account retains existing Tasks, Planner
    sessions, configuration and workspaces.
11. ADR-0011 remains one active top-level Task per account.
12. direct Web/TUI/Feishu-to-Session paths are absent.
13. safe Planner/Kernel/Executor trace streaming remains available on every
    capable client.
14. no hidden chain-of-thought or sensitive runtime payload crosses Gateway.

## Delivered Outcome

The design was implemented on August 19, 2026:

- one production composition activates
  `RuntimeRegistry -> AccountRuntime -> ConversationRegistry`;
- one `ClientGateway` serves Unix, Web, Feishu, native TUI and scripted input;
- Web, Feishu and Unix adapters may coexist while foreground selection changes
  presentation only;
- native AnyFusion-Pi branches into Gateway client mode before local semantic
  model, tool or session construction; semantic Planner turns remain
  Server-owned RPC;
- account data, configuration, secrets, generated runtimes, Planner sessions,
  workspaces, attempts, Gateway admission and event journals resolve under
  `accounts/local-default`;
- native install/update/rollback switch account-scoped immutable pointers, with
  legacy global paths limited to one-time migration evidence;
- Gateway events are ordered, replayable, recursively sanitized and capped at
  64 KiB;
- architecture, integration and `smoke:gateway` gates enforce the accepted
  topology.

## Non-Goals

- multi-top-level-Task scheduling inside one account;
- cross-account collaboration or shared Conversations;
- cloud billing, organizations or enterprise tenancy;
- distributed Server clustering;
- remote A2A Executors;
- replacing SQLite or the AnyFusion-Pi Planner.
