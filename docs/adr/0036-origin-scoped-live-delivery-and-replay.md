# ADR-0036: Origin-Scoped Live Delivery And Account-Scoped Replay

- **Status:** Accepted
- **Date:** 2026-08-29
- **Scope:** Gateway detailed-event live delivery, Conversation replay, Web refresh/reconnect behavior, Feishu origin delivery, and native TUI compatibility
- **Amends:** ADR-0031
- **Preserves:** ADR-0011, ADR-0015, ADR-0020, ADR-0022, ADR-0023, ADR-0024, ADR-0025, ADR-0026, ADR-0032, ADR-0033, ADR-0034, ADR-0035
- **Related design:** `docs/plans/2026-08-29-origin-scoped-realtime-account-history-design.md`
- **Implementation plan:** `docs/plans/2026-08-29-origin-scoped-realtime-account-history-implementation-plan.md`
- **Governed by:** ADR-0020

## Context

ADR-0031 established one Account/Conversation EventJournal and allowed one
Conversation to have multiple authorized ClientConnection attachments. Its
original event-routing language permitted a detailed event to be delivered live
to every currently attached connection for that Conversation.

That behavior conflates two different product contracts:

- durable Conversation history, which every authorized attached client must be
  able to replay; and
- transient detailed live delivery, which must not replace another surface's
  current turn merely because both surfaces are attached to the same
  Conversation.

Web is the primary product surface, Feishu must remain a normal Feishu bot, and
the native TUI must preserve its current Gateway-backed interaction. A Feishu
or TUI turn therefore must not overwrite a currently open Web turn, while its
safe facts must still appear when Web later attaches, refreshes, switches, or
reconnects.

## Decision

### 1. Durable history and live delivery have different scopes

MetaWork adopts **origin-scoped realtime with Account/Conversation-scoped
history**:

```text
append(account, conversation, event)
  -> one durable Account/Conversation journal

replay(authorized account, conversation)
  -> all retained authorized events, independent of origin

subscribe(authorized account, conversation, connection C)
  -> detailed live events targeted to C only
```

Origin filtering never changes journal append, compaction, sanitization, stale
cursor recovery, sequence assignment, or replay authorization. Existing event
files remain readable without migration.

### 2. Origin is internal delivery metadata

The Gateway/Application Shell owns a narrow internal value:

```ts
interface GatewayTurnOrigin {
  readonly connectionId: string;
  readonly surface: 'web' | 'feishu' | 'tui' | 'local' | 'unknown';
}
```

The Server derives it from the authenticated command envelope and transport.
It is passed through command admission, the Conversation mailbox, and event
publication only as needed for live routing. It is not added to public Gateway
event payloads or persisted solely for this behavior.

Origin does not select an Account, authorize a Conversation, establish a
Conversation owner, reject another client write, select a Planner session, or
create a separate Task/Runtime. Account and Conversation authorization remain
independent mandatory checks.

### 3. Detailed live events are origin-scoped

When associated with an originating turn, these event kinds are detailed live
events:

- `turn_started`;
- `trace_delta`;
- `task_projection`;
- `execution_delta`;
- `permission_request`;
- `artifact`;
- `result_delivery_available`;
- `result_chunk`;
- `result_completed`;
- `final_answer`;
- `terminal_error`;
- turn-scoped `delivery_status`.

A connection receives such an event live only when its authenticated
connection identity matches the internal target. A detailed event with no live
target is durable history only and is not broadcast to every Conversation
attachment. This is the default for recovery/background facts after no live
origin can be safely retained.

For the originating connection, the live target is not limited to the mailbox
command execution window. The origin of a turn remains the live target for that
turn's `trace_delta`, `task_projection` and `conversation_snapshot` projections
while background Task/Executor work continues, until a later turn supersedes it
or the connection detaches. A detached connection's subscription is removed, so
its remaining facts are durable history and reappear through origin-unfiltered
replay on reconnect.

`conversation_snapshot` and `conversation_history_page` are attach/replay/read
projections. They are delivered in response to an authorized read lifecycle,
not as an unsolicited cross-client live notification.

### 4. Workspace directory projections remain shared summaries

ADR-0035 remains authoritative for Workspace organization. Bounded Workspace
selection, directory, availability, and activity projections may continue to
update their authorized connection or directory subscribers because they are
summary facts. They must not contain detailed Conversation output, result
chunks, raw trace content, or hidden reasoning.

### 5. Attach and reconnect preserve replay-before-live safety

Every detailed client attachment follows this sequence:

1. subscribe with its authenticated live connection identity;
2. buffer matching live events;
3. replay the complete authorized Conversation snapshot and deltas without
   origin filtering;
4. record the replay watermark;
5. release only newer buffered events and deduplicate by `eventId`;
6. continue origin-scoped live delivery.

An expired/compacted cursor uses the existing bounded current/terminal snapshot
contract. A filtered foreign live event is not a missing durable event; it
becomes visible on a later authorized replay.

### 6. Surface behavior

**Web** receives its own detailed turn live. Foreign-origin turns do not mutate
its current live turn before a read lifecycle. Attach, refresh, Conversation
switch, and reconnect rebuild the selected Conversation read model from all
retained authorized origins in stable journal order. App-owned draft and
attachment state remains governed by the existing Web tab contract.

**Feishu** subscribes and waits for terminal events using its existing
account/chat/thread-derived connection identity. It sends progress and final
replies only for that origin. Existing Feishu messages, cards, chunking,
retries, artifacts, policy, audit, `/history`, `/conversations`, and
`/conversation` behavior remains unchanged and reads complete authorized
history.

**TUI/local** keeps its existing command/AI-turn separation, rendering, cursor,
and reconnect behavior for its own turns. It gains no cross-client reducer or
new product information architecture. Explicit replay/history may include all
authorized origins.

### 7. Disconnect and restart do not stop work

A ClientConnection disconnect does not cancel Planner, Task, Kernel, Executor,
or recovery work. Safe facts continue to be journaled. If restart or lost
in-memory origin context prevents exact live targeting, the event remains
history-only and appears on the next authorized replay; it is never broadcast
to all attached detailed clients as a fallback.

## Ownership And Dependency Direction

ADR-0020 remains authoritative:

```text
transport adapter
  -> Gateway authentication and connection identity
  -> Conversation Application-Shell mailbox and delivery context
  -> public EventJournal append + internal subscription target
```

Planner, ControlKernel, Execution Runtime, Executor adapters, and durable Task
policy do not depend on Gateway origin or platform identity. Gateway remains an
Application-Shell projection and does not gain direct repository, Kernel, or
Executor authority.

## ADR-0031 Amendment

ADR-0031 remains authoritative for AccountRuntime ownership, Conversation
identity, mailbox serialization, Gateway contracts, account isolation, and
client lifecycle. This ADR replaces only the rule that detailed events may be
sent live to all current attachments of one Conversation.

Multiple connections may still submit to and observe one Conversation. Their
writes remain serialized by the existing mailbox rather than an owner or
writer lease. Complete authorized observation occurs through durable replay;
detailed realtime observation is limited to the turn's origin connection.

## Consequences

- A temporary Feishu or TUI command cannot overwrite an open Web live turn.
- Every authorized surface can still recover complete Conversation history on
  attach/replay.
- Existing journal schemas and user data need no origin migration.
- Background/recovery facts without a live origin fail closed to history-only
  delivery rather than becoming an account-wide detailed broadcast.
- Platform adapters retain their native presentation and delivery behavior.
- Subscription tests must distinguish detailed, read/replay, and bounded
  Workspace summary projections.

## Rejected Alternatives

### Broadcast detailed events to every Conversation attachment

Rejected because it lets one surface unexpectedly replace another surface's
active turn and makes Feishu behave like a Web notification mirror.

### Persist origin in every public event

Rejected because replay is intentionally origin-unfiltered and public
connection identity is not required for history. It would add protocol and
migration cost without improving authority.

### Add a Conversation owner or single-writer lease

Rejected because live delivery identity is not Conversation ownership. The
existing serialized mailbox and AccountRuntime authority remain sufficient.

### Create per-surface histories or runtimes

Rejected because it creates multiple write authorities and breaks complete
cross-surface replay.
