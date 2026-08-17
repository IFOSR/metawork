# Web Interaction Trace And Planner Socket Reliability Design

> Status: Approved
> Design date: 2026-08-17
> Approved date: 2026-08-17
> Related: ADR-0015, ADR-0020, ADR-0022, ADR-0023, ADR-0025, ADR-0026,
> [AnyFusion Web interaction design](2026-08-15-anyfusion-web-interaction-interface-design.md)

## 1. Goal

Deliver two related reliability and transparency improvements:

1. Prevent a concurrent composition process from unlinking the live Planner Host
   Unix socket and make transport failures preserve their authoritative cause.
2. Show a detailed, streaming, refresh-safe execution trace in the Web right
   pane from user input through Planner, Kernel, routing, Executor execution,
   verification, publication, and final delivery.

The trace is an Application-Shell projection over existing runtime facts. It
must not become a second planner, scheduler, recovery loop, or state authority.

## 2. Safety And Product Boundary

The UI may expose:

- the user request;
- a bounded intent summary and the structured PlanningAgentPlan fields;
- Planner MCP/tool names, statuses, durations, and redacted result summaries;
- Kernel event, decision, action, target, and reason;
- selected AgentClass, Harness, Provider, Model, fallback order, Subtask, and
  acceptance criteria;
- WorkUnit claim and attempt lifecycle;
- redacted Executor status, command/tool category, Skill progress, workspace
  delta summary, verification result, retry/fallback fact, and publication;
- the final user-visible result.

The UI must not expose:

- hidden chain-of-thought, private reasoning tokens, or reasoning signatures;
- secrets, credentials, bearer tokens, complete environment variables, or
  private runtime-home content;
- complete prompts, unbounded stdout/stderr, raw provider payloads, or internal
  session files;
- policy inference invented by the projector.

Where the user asks for "thinking", the product displays a concise process
summary derived from structured plans and actual runtime events. It does not
claim that this summary is the model's private internal reasoning.

## 3. Planner Socket Reliability

### 3.1 Root Cause

Every composition mode creates a `PlannerHostBridge` at the same default Unix
socket path. TUI, Web, and Gateway obtain `runtime.lock`, but `--script`
currently bypasses the lock. `PlannerHostBridge.start()` treats every existing
socket as stale and unlinks it without probing ownership.

A concurrent script therefore:

1. unlinks the live Web/TUI socket path;
2. binds its own server to the same pathname;
3. completes and unlinks the pathname again;
4. leaves the original process with an open listener file descriptor that no
   new client can reach.

New Planner RPC submissions then fail with `connect ENOENT`.

### 3.2 Corrected Ownership Contract

- Every mode that opens the database and creates `PlannerHostBridge`, including
  `--script`, must acquire the composition instance lock before any socket
  cleanup or bridge startup.
- Pure admin commands that do not create Session, Kernel, Runtime, or Planner
  Host remain lock-free.
- A second composition process must fail explicitly without touching the live
  socket.
- `PlannerHostBridge.start()` must probe an existing socket. A reachable
  Planner Host is active and must not be unlinked. Only a confirmed stale
  socket may be removed.
- The bridge records the device/inode identity of the socket it created.
  `stop()` removes the pathname only when it still refers to that owned socket.
- The Planner RPC supervisor preserves the latest structured proposal result
  and partial tool trace on failure. A real `transport_uncertain` result keeps
  its `turnId`, `submissionId`, replayability, and underlying redacted message.

The single-instance rule is consistent with ADR-0011 and the existing local
single-user composition model. Concurrent smoke validation must use an isolated
`ANYFUSION_INSTALL_ROOT`.

## 4. Trace Architecture

Use a hybrid model:

```text
live Session/runtime events
  -> InteractionTraceStream (bounded in-memory current-turn deltas)
  -> ManagementServer WebSocket trace_delta

existing durable facts
  -> InteractionTraceProjector (read-only reconstruction)
  -> trace_snapshot on connect/reconnect/refresh
```

No new database table is introduced. Durable reconstruction reads existing
facts owned by their current modules:

- `planner_proposal_turns` for user input and turn identity;
- `planner_runs` and `planner_tool_calls` for Planner lifecycle and tools;
- persisted `plan_proposed` Kernel events for the accepted structured plan;
- `kernel_decisions` and workflow applications for authorization;
- dispatch items, WorkUnit events, and AgentClass bindings for routing;
- attempt runtime, redacted Skill events, receipts, and workspace delta for
  execution and verification;
- publication records and interactions for delivery.

Live deltas fill the interval before those facts become durable. They are
presentation hints only. After a restart, the projector reconstructs the
authoritative trace from durable records and may omit non-authoritative
transient animation states.

## 5. Trace Contract

One user query maps to one `InteractionTrace`:

```ts
interface InteractionTrace {
  sessionId: string;
  turnId: string;
  taskId: string | null;
  status: 'running' | 'completed' | 'failed' | 'blocked';
  startedAt: string;
  completedAt: string | null;
  events: InteractionTraceEvent[];
}

interface InteractionTraceEvent {
  id: string;
  sequence: number;
  occurredAt: string;
  phase:
    | 'intake'
    | 'planning'
    | 'authorization'
    | 'routing'
    | 'execution'
    | 'verification'
    | 'delivery';
  actor: 'user' | 'planner' | 'kernel' | 'runtime' | 'executor';
  kind: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
  title: string;
  summary: string;
  details: Record<string, unknown>;
}
```

Events are ordered by durable timestamp and deterministic tie-breaker. IDs are
stable so snapshots and deltas merge idempotently.

WebSocket messages:

```ts
{ type: 'trace_snapshot', trace: InteractionTrace }
{ type: 'trace_delta', turnId: string, fromSequence: number, events: InteractionTraceEvent[] }
```

On connection the server sends `hello`, output replay, and the latest trace
snapshot. During execution it sends bounded deltas. A client detecting a
sequence gap replaces local state with the next snapshot.

## 6. Runtime Event Sources

### Intake And Planning

- Session emits `query_received` before Planner invocation.
- Planner audit emits `planner_started`.
- The RPC supervisor emits redacted tool start/end events without argument
  bodies that match secret/content/prompt keys.
- The accepted plan produces `intent_classified` and
  `planning_proposal_completed` summaries from schema fields, not assistant
  prose.
- Rejection, conflict, model failure, MCP failure, and transport uncertainty
  produce explicit terminal events.

### Authorization And Routing

- Kernel ledger produces authorization events with decision ID, action, and
  reason.
- Work Graph and dispatch items provide Subtask titles, capabilities,
  acceptance criteria, selected binding, and fallback order.
- Provider, Model, Harness, and configuration revision come from the authorized
  binding, never inferred from process environment.

### Executor, Verification, And Delivery

- WorkUnit events provide provisioning, claim, running, waiting, failure, and
  stop facts.
- Executor progress is normalized into bounded categories. Structured Skill
  events are persisted; generic logs are redacted, truncated, and sampled
  before becoming presentation events.
- Attempt runtime provides workspace preparation and delta summaries.
- Receipts provide terminal outcome and completion-contract verification.
- Publication records provide integration and delivery completion.
- The final chat answer is emitted only through the existing delivery path. The
  trace marks delivery complete immediately before or with that output.

## 7. Web Experience

The right pane becomes the primary process view:

- header: current query summary, overall status, elapsed time, Task ID when any;
- vertically ordered phases with active-stage animation;
- event cards showing actor, timestamp, title, summary, and expandable details;
- routing cards showing exact Executor binding and fallback order;
- Executor cards showing actual normalized steps and verification evidence;
- automatic scroll following the active event, disabled after manual scroll;
- completed traces remain expanded enough to audit but can be collapsed;
- mobile layout moves the process pane below chat without dropping details.

The existing compact trace inside the chat is removed or reduced to a link to
the right pane to avoid duplicating two inconsistent process views.

## 8. Error Handling

- Socket ownership conflicts fail startup with the active PID/path and never
  unlink the live path.
- Planner transport uncertainty displays its concrete redacted cause and replay
  identity.
- Trace projection errors do not affect Kernel or Runtime. The Web pane shows a
  projection warning while task execution continues.
- A malformed or oversized progress event is dropped and counted; it never
  enters the browser unbounded.
- WebSocket reconnect sends a full snapshot before further deltas.

## 9. Testing

Required focused coverage:

- live bridge cannot be replaced by a second bridge;
- bridge stop cannot unlink a socket now owned by another process;
- `--script` participates in the composition lock;
- stale sockets remain recoverable;
- transport uncertainty preserves the original result and partial tool calls;
- trace projection covers direct reply and durable Task paths;
- routing includes exact authorized binding and fallback ordering;
- progress redaction removes secret-like fields and bounds event size;
- WebSocket sends snapshot on connect and ordered deltas while running;
- reconnect is idempotent;
- right pane renders all phases, active streaming state, errors, and mobile
  layout;
- existing Kernel, execution, and publication behavior remains unchanged.

## 10. Acceptance Criteria

- Running Web/TUI cannot be broken by a concurrent script or smoke invocation.
- The warning from the reproduced incident surfaces `connect ENOENT ...` with
  the original proposal identity instead of a generic accepted-result error.
- From query submission until final answer, the right pane streams every
  available normalized phase in order.
- Refreshing or reconnecting restores the latest complete trace.
- The displayed trace identifies the selected Executor binding and actual
  verification/publication outcomes.
- No hidden chain-of-thought, secret, complete prompt, or unbounded raw process
  output reaches the Web client.
- Focused tests, root lint/build, and Web typecheck/build pass.

