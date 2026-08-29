# 来源端实时展示与账号级历史同步设计

> **Status:** Accepted; implemented
> **Design date:** 2026-08-29
> **Implemented:** 2026-08-29
> **Review owner:** Product / Architecture
> **Scope:** Gateway live delivery, Conversation replay, Web refresh behavior,
> Feishu delivery boundary, and TUI compatibility
> **Related authority:** ADR-0020, ADR-0031, ADR-0034, ADR-0035
> **Implementation plan:** `2026-08-29-origin-scoped-realtime-account-history-implementation-plan.md`

## 1. Decision Summary

MetaWork adopts **origin-scoped realtime with account-scoped history**:

```text
Live execution events:
  deliver to the client connection that initiated the turn

Conversation history:
  persist once under the Account/Conversation journal
  replay all authorized history when another client opens or refreshes

Feishu:
  keep the existing Feishu bot interaction model
  reply in the originating chat/thread using Feishu messages/cards
  do not mirror the Web page or define a second Feishu UI protocol

Web:
  remain the primary product surface
  do not receive Feishu/TUI detailed events live
  load their completed and in-progress historical facts on attach/refresh/reconnect

TUI:
  preserve the current Gateway-backed behavior
  do not expand its cross-client synchronization model
```

This is a delivery-boundary change, not a new ownership model. AccountRuntime
continues to own account-wide Task, Kernel, Executor, recovery and persistence
services. Conversation continues to own Planner history, input ordering, trace
and detailed replay. No Conversation owner, writer lease, client write lock or
second execution path is introduced.

## 2. Problem

The current Gateway records events in one Account/Conversation journal, but its
live subscription hub filters only by `accountId` and `conversationId`. Every
authorized attachment to the same Conversation can therefore receive another
client's live `turn_started`, `trace_delta`, execution/result and terminal
events. A Web or TUI projection can be replaced by the latest query from a
different client even though the durable Conversation history is shared.

The required product behavior is deliberately asymmetric at the UI level:

- Web is the normal work surface and must not be disturbed by a temporary TUI
  command or a Feishu message.
- Feishu must feel like a normal Feishu bot, not like a remote Web dashboard.
- Feishu-origin work must remain visible in Feishu while it runs.
- Any authorized client must see the complete Conversation history after it
  opens, refreshes, switches to, or reconnects to that Conversation.

## 3. Product Model

### 3.1 Account and Conversation remain shared

The existing hierarchy remains authoritative:

```text
Account
  -> AccountRuntime
    -> WorkspaceDirectory
      -> Workspace
        -> Conversation
          -> ClientConnection
```

One Account may have Web, Feishu and TUI connections. They may all submit
commands to an authorized Conversation. A client connection is a transient
delivery identity, not an owner of the Conversation and not a write authority.

The existing Workspace binding and Workspace directory rules from ADR-0035 are
unchanged. This design does not reparent Conversations, change Workspace
selection, or alter the Account-scoped single-active-Task rule.

### 3.2 Turn origin is delivery metadata only

Each accepted semantic or system command must retain the initiating connection
for live delivery:

```ts
interface GatewayTurnOrigin {
  readonly connectionId: string;
  readonly surface: 'web' | 'feishu' | 'tui' | 'local' | 'unknown';
}
```

The server derives this from the authenticated Gateway command envelope and
transport. Clients may provide a connection identifier for routing, but they
cannot use origin metadata to select an Account or bypass authorization.

Origin metadata is used only to decide which live subscribers receive an event.
It is not used to:

- reject another client write;
- select a different Planner session;
- create a separate Task or Runtime;
- hide history from an authorized client;
- infer Conversation ownership.

If a fact has no live origin, such as a startup recovery projection or a
background Task fact after the originating client has gone away, it is durable
history only by default. It is not broadcast to every attached Conversation
client.

## 4. Event and History Contract

### 4.1 One durable journal

All accepted input and safe output continue to be appended to the existing
Account/Conversation EventJournal. The journal remains the source for:

- Conversation snapshots;
- user and assistant turn reconstruction;
- safe trace and execution projections;
- result delivery and completion facts;
- terminal errors;
- later client replay.

No second Web history store, Feishu history store or TUI history store is
created. Existing journal files and existing Conversation/Task data are not
deleted or reset by this change.

The public event envelope should not expose internal connection identity. The
live target is an internal delivery attribute passed to the subscription hub
or an equivalent server-side delivery context. Replay intentionally ignores
live target metadata and returns all authorized Conversation events.

### 4.2 Live delivery

For a turn initiated by connection `C`, live event delivery follows:

```text
event with origin C -> subscribers attached as C
event with another origin -> not delivered to C
event with no origin -> not delivered as a detailed live event
```

Conversation and Workspace directory projections remain separate. Workspace
directory activity may continue to update authorized directory subscribers
because it is a bounded account/workspace summary, not a detailed Conversation
trace. It must not include raw conversation output or turn content.

The following detailed event kinds are origin-scoped when they belong to a
turn:

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

Conversation snapshots and history pages are replay/read projections. They are
not cross-client live notifications. A client receives them when it attaches,
reconnects, explicitly refreshes, or requests history.

### 4.3 Replay and live race

Every attach/reconnect must preserve the existing replay-before-live safety
pattern:

1. subscribe to the origin-scoped live stream;
2. buffer matching live events while replay is read;
3. replay the complete authorized Conversation snapshot/deltas;
4. release buffered events whose sequence is newer than the replay watermark;
5. deduplicate by `eventId`.

The replay result is not filtered by origin. This is the rule that makes Feishu
and TUI history visible in Web after refresh, while preventing their live trace
from changing the current Web screen.

If the cursor is stale or compacted, the existing bounded snapshot/replay
behavior remains authoritative. The client must rebuild from the returned
snapshot rather than assume it can recover only the latest turn.

## 5. Surface Behavior

### 5.1 Web

Web remains the primary interactive surface.

When Web submits a turn:

```text
Web -> Gateway -> Conversation
Conversation -> Web connection: live trace, result and final answer
Conversation -> other detailed clients: no live turn stream
```

When Feishu or TUI submits a turn:

```text
Feishu/TUI -> Gateway -> Conversation
Conversation -> Web current screen: no live detailed event
Web attach/refresh/reconnect -> complete Conversation replay
```

The Web runtime must treat attach and refresh as a full read-model rebuild, not
as an incremental “latest query” replacement. Existing Web turns must be
retained while replayed foreign-origin turns are merged by stable turn/event
identity and sequence. A refresh must not create a new Conversation or force a
new Conversation flow.

The Web Conversation, Trajectory, Execution, Artifact, Settings and Composer
information architecture remains unchanged by this design. UI work is limited
to making the replay boundary explicit and ensuring a background foreign turn
does not mutate the current live composer/turn state before refresh.

### 5.2 Feishu

Feishu follows its normal client behavior. The Server does not try to reproduce
the Web layout in Feishu.

For a Feishu-origin command, the existing Feishu adapter and session port keep
doing the following:

- route the tenant/user/chat/thread to the bound Conversation;
- send progress through Feishu progress messages/cards when configured;
- send the final answer back to the originating chat/thread;
- preserve existing history, Conversation directory and card actions;
- use the existing Feishu access-policy and delivery audit path.

The Feishu live attachment is filtered to its own deterministic chat/thread
connection. A Web-origin or TUI-origin turn does not create an unsolicited
detailed Feishu reply. Feishu users can still use the existing `/history`,
`/conversations` and `/conversation <id>` flows to read authorized history.

This does not define a new Feishu-specific synchronization protocol. Feishu
message formatting, card behavior, chunking, retry and delivery semantics
remain owned by the existing Feishu integration.

### 5.3 TUI

The native AnyFusion-Pi TUI remains a temporary Gateway client:

- preserve current command and AI-turn separation;
- preserve current TUI-origin live rendering and reconnect behavior;
- stop receiving detailed live events originated by Web or Feishu;
- allow replay/history to include all authorized Conversation turns;
- do not add a new cross-client reducer or a TUI product information architecture.

The preserved standby Ink module is not part of this change.

## 6. Connection and Transport Rules

The canonical live origin is the same stable connection identifier already used
by the command envelope:

- Web: the Web runtime/client connection identity;
- Feishu: the existing account + chat + thread-derived connection identity;
- TUI/local: the existing Gateway client connection identity.

The server must validate that a live subscription may claim only its own
authenticated connection identity. A connection cannot subscribe as another
Web client, Feishu chat/thread, or TUI client. Account and Conversation
authorization remains checked independently during attach and replay.

For a browser reconnect, the new transport connection may rebind the same
client identity only under the existing connection lifecycle rules. It must
replay the Conversation after attach; it must not rely on an in-memory live
turn map for correctness.

## 7. Failure and Recovery

### 7.1 Origin client disconnects

Disconnecting Web, TUI or Feishu does not cancel the Conversation, Task,
Planner turn or Executor work. The existing Server/AccountRuntime lifecycle
continues. The completed and safe partial facts remain in the journal and are
visible to a later authorized replay.

### 7.2 Server restart during a turn

Existing durable command admission, Conversation journal and Runtime recovery
rules remain authoritative. If the original live origin no longer exists after
restart, the system does not broadcast recovered detailed events to all clients.
The next client attach/reconnect reads the durable snapshot/history and the
Task/Execution projection.

### 7.3 Duplicate delivery

The existing `eventId`, sequence and result assembly deduplication remains in
place. Filtering must happen before client delivery, while replay still uses
the existing deduplication and stale-cursor logic. A filtered live event must
not be treated as a missing durable event.

### 7.4 Security

All replay and live subscription paths remain Account- and Conversation-
authorized. Origin filtering is not an authorization mechanism. Sensitive
payload sanitization, bounded event size, Feishu policy checks and path-free
Web bootstrap remain unchanged.

## 8. Non-Goals

- No Conversation owner, writer lease, client write lock or single-writer rule.
- No deletion, reset or migration-away of existing Conversation/Task history.
- No separate Feishu UI specification or Web-to-Feishu page mirroring.
- No default Web-to-Feishu notification policy for every Web input.
- No account-wide detailed event broadcast.
- No Workspace-level detailed stream.
- No second Runtime, Kernel, Planner or Executor path.
- No redesign of the current TUI interaction.
- No change to AgentClass/model capability semantics or task authority.
- No change to the existing Feishu platform connection and message transport.

## 9. Required Authority Updates Before Implementation

Because ADR-0031 currently describes Conversation attachments as concurrent
observers of detailed events, implementation must first amend the current
authority documents rather than silently override them in code:

1. Add an ADR amendment or new narrowly scoped ADR for origin-scoped live
   delivery and replay-all history.
2. Amend ADR-0031's Gateway event/subscription section to distinguish durable
   replay from origin-scoped live delivery.
3. Amend `CONTEXT.md` and the current Gateway technical documentation to state
   that Web/Feishu/TUI do not receive one another's detailed live turn stream.
4. Keep ADR-0035 Workspace directory projections unchanged except for any
   cross-reference needed to distinguish summary activity from detailed replay.

No implementation should begin until these authority changes are accepted in
the same release plan.

## 10. Acceptance Criteria

The design is correctly implemented only if all of the following hold:

- Web-origin turns stream live in Web and do not appear as unsolicited detailed
  Feishu/TUI live output.
- Feishu-origin turns stream live in the originating Feishu chat/thread and do
  not overwrite the current Web view.
- TUI-origin turns retain current TUI live behavior and do not overwrite Web.
- Web refresh, attach, Conversation switch and reconnect show all authorized
  Web, Feishu and TUI history in stable order.
- Replay of a Conversation is not limited to the latest query.
- A stale cursor rebuilds from a bounded snapshot and retains terminal facts.
- A client disconnect does not stop the Task or lose later replayable facts.
- Existing Feishu history/card actions and policy checks remain functional.
- Existing TUI command/AI-turn behavior remains functional.
- No existing user data is removed, reset or made a second write authority.

