# Web Session Workspace Redesign

> Status: Approved
> Design date: 2026-08-17

## Goal

Replace the current split chat/trace Web surface with a session-oriented Agent
workspace inspired by the DeepSeek Harness information architecture:

- persistent session navigation on the left;
- one full-width primary canvas;
- Conversation and Trajectory tabs for the selected session;
- detailed, streaming execution logic embedded in Conversation;
- dense, searchable audit data in Trajectory;
- one sticky composer shared by both views.

The redesign must preserve AnyFusion's Planner -> Kernel -> Runtime -> Executor
authority boundaries and must not expose hidden chain-of-thought, raw prompts,
credentials, raw tool payloads, or unredacted process output.

## Why The Current Layout Should Change

The current Web surface permanently divides the available width between
`ChatPane` and `InteractionTracePanel`. That works for short diagnostics but
causes two problems for normal Agent work:

1. long Markdown answers are constrained to a narrow column;
2. complex Planner/Kernel/Executor traces become tall cards in another narrow
   column, forcing the user to split attention across both sides.

The reference layout uses the full primary canvas for one cognitive task at a
time. Conversation presents the request, detailed execution milestones, and
final answer in reading order. Trajectory reprojects the same facts into a
compact diagnostic surface. This is a better fit for AnyFusion's durable agent
workflow.

## Chosen Approach

Use **one live runtime session plus a persistent Web session catalog**.

Alternatives rejected:

- A presentation-only sidebar would create fake history that cannot resume a
  Planner session.
- Multiple simultaneously live `MetaclawSession` instances would duplicate
  runtime coordination and conflict with the existing single-active-Task
  product boundary.

The chosen model allows many persisted conversation sessions, but only one
session may own the live Planner/Application-Shell runtime. Historical sessions
remain browsable without activation. Continuing a historical session first
passes a safe activation gate, then disposes the previous idle live session and
recreates `MetaclawSession` with the selected stable session ID. The existing
AnyFusion-Pi session file therefore resumes naturally.

## Information Architecture

### Left Session Rail

Desktop width is approximately 280 pixels. It contains:

1. AnyFusion identity and a collapse control.
2. A prominent `New session` action.
3. Workspace heading with search and filter controls.
4. Session groups:
   - active/recent;
   - archived or ungrouped.
5. Session rows showing title, relative update time, running indicator, and
   selected state.
6. Settings at the bottom.

The first release supports one current workspace root. Session grouping is a
presentation concern and does not create a second workspace or Task scheduler.

Session titles are derived from the first user request, normalized and
truncated. Search covers title and persisted user/final-answer text. Empty new
sessions may exist in the catalog before their first message.

### Main Header

The main header contains:

- selected session title;
- runtime mode and connection state;
- `Conversation` and `Trajectory` tabs;
- optional session export and settings actions.

The header stays visible while the main canvas scrolls.

### Sticky Composer

One composer is anchored to the bottom of the main canvas and remains stable
when switching tabs. It contains:

- multiline input;
- current execution permission/mode summary;
- active Planner model summary;
- send/stop state;
- a compact current Task/step summary above the input when work is active.

The composer is disabled when viewing a historical session that has not been
activated. A clear `Continue this session` action performs the activation gate.

## Conversation View

Conversation is the primary product surface. Each user request is rendered as
one `ConversationTurn` in chronological order:

1. user message;
2. detailed execution narrative;
3. final answer or terminal error.

### Detailed Execution Narrative

The narrative is not a generic spinner and is not hidden reasoning. It streams
safe, concrete events from the existing `InteractionTrace` and
`ExecutionTimeline`:

- Planner process start and prompt acceptance;
- Planner processing-cycle number and model response start;
- authoritative context queries and safe tool names;
- safe argument/result field names and elapsed time;
- structured action, confidence, risk, Task binding and title;
- Work Graph Subtasks, dependencies and acceptance criteria;
- Kernel decision, decision reason and Task ID;
- exact primary/fallback AgentClass, Harness, Provider and Model bindings;
- Executor claim/start, normalized progress, attempt result and artifacts;
- verification and publication outcome;
- delivery status and total elapsed time.

Events are grouped into readable sections:

- `Planner`;
- `Authorization and routing`;
- `Execution`;
- `Verification and delivery`.

The default state shows substantial summaries rather than one-line placeholders.
Users may expand individual rows for the full sanitized structured detail.
Completed sections collapse to a compact header only when the turn is long;
the currently running section remains expanded.

No assistant thinking text, reasoning delta, raw prompt, raw tool argument
value, raw result body, secret-like field name, credential, or stdout/stderr is
rendered.

### Final Answer

The final answer follows the execution narrative in the same turn. Markdown,
links, code blocks and artifact references retain the existing sanitization
boundary. The answer is visually stronger than process rows so users can scan
past execution detail when they only need the result.

## Trajectory View

Trajectory uses the same underlying trace facts, not a second execution or
logging path.

### Summary Strip

The top strip shows:

- total duration;
- Planner processing cycles;
- tool calls;
- Kernel decisions;
- Executor attempts;
- final status.

### Phase Timeline

A compact horizontal timeline projects relative duration for:

- intake;
- Planner/model;
- tools;
- Kernel;
- Executor;
- verification;
- delivery.

The timeline is derived from event timestamps and attempt/runtime facts. It is
diagnostic only and does not influence scheduling.

### Dense Event Table

Below the timeline, events are rendered as compact rows containing:

- actor badge;
- event/tool name;
- safe summary;
- start time and elapsed time;
- status;
- expandable structured details.

The table supports text search and filters for phase, actor and status. Tool
rows show only sanitized summaries already allowed by the trace contract.

## Session Persistence

This redesign does not advance SQLite schema 30 to schema 31.

Web session metadata and completed presentation projections are stored in an
Application-Shell-owned file repository under:

```text
~/.anyfusion/data/web-sessions/
  catalog.json
  sessions/<session-id>.json
```

Writes use temporary files, fsync and atomic rename. The format is explicitly
versioned.

`WebSessionRecord` contains:

- stable session ID;
- title;
- created/updated timestamps;
- active/archived presentation status;
- ordered completed `ConversationTurn` projections;
- bounded sanitized trace events;
- Task and artifact references.

This store is a recoverable Web presentation projection, not a new source of
Task, Kernel, routing or execution authority. SQLite interactions, Planner
session files, Kernel decisions and execution repositories remain authoritative
for their existing domains.

The live turn is assembled by a `WebConversationProjector` from:

- submitted user input;
- Session output deltas;
- `InteractionTrace` snapshots/deltas;
- `ExecutionTimeline` updates.

On terminal delivery/failure/block, the projector writes one completed turn
snapshot. A crash may lose only the incomplete presentation turn; durable
Task/Kernel/Executor facts remain intact and can be projected again.

## Runtime Activation

`ManagementServer` remains an Application Shell adapter and gains a session
catalog/activation service.

Session selection has two modes:

- **Browse:** load persisted Conversation/Trajectory projections without
  changing the live runtime.
- **Activate:** continue the selected session using its stable session ID.

Activation is allowed only when the current live session reports a safe
switching state:

- no Planner turn is active;
- no input submission is in flight;
- no active Task still depends on that Session runtime.

If blocked, the UI explains the exact reason and continues streaming the live
session. It never force-disposes a running Planner or Executor.

After activation:

1. detach WebSocket adapters from the old session;
2. dispose the idle old `MetaclawSession`;
3. create and initialize a new `MetaclawSession` with the selected session ID;
4. attach output, trace and execution subscriptions;
5. broadcast the new active-session snapshot to all authenticated tabs.

Only this Application Shell path may activate sessions. The catalog cannot
mutate Task, Kernel or Executor state directly.

## Protocol Changes

HTTP endpoints:

- list/search Web sessions;
- fetch one historical session projection;
- create a new session;
- request activation of a historical session;
- archive/rename a session in later increments.

WebSocket messages:

- active session identity;
- session catalog changes;
- structured conversation snapshot/delta;
- existing trace snapshot/delta;
- existing execution timeline.

The initial implementation may retain legacy output messages internally while
the new structured conversation protocol becomes authoritative for the Web UI.
No compatibility path is added to Planner/Kernel semantics.

## Responsive Behavior

- At wide desktop widths, the rail is fixed and the main canvas is centered
  with a readable maximum width in Conversation.
- Trajectory may use the full available width for dense rows.
- At tablet widths, the rail collapses to icons or a temporary drawer.
- At mobile widths, the rail becomes a modal drawer, the header stays compact,
  and the composer remains fixed above the safe area.
- Conversation process details use stacked cards on mobile; Trajectory rows
  switch from columns to labeled key/value blocks.

## Error Handling

- Session catalog corruption isolates the invalid file and keeps the active
  runtime available.
- Failed atomic writes surface a non-blocking persistence warning; they do not
  replace the user answer.
- Activation conflicts return a structured blocked reason.
- WebSocket reconnect receives the active session snapshot and selected
  historical projection again.
- Missing Planner session files leave history browsable but disable continuation
  with an explicit explanation.
- Trace data always passes the existing redaction/sanitization boundary before
  persistence and delivery.

## Testing

Required coverage:

- file repository atomicity, recovery and path confinement;
- session catalog create/list/search/title behavior;
- activation gate and singleton live-session invariant;
- Planner session ID reuse on continuation;
- no disposal while Planner/Task work is active;
- Conversation projector ordering and terminal persistence;
- trace privacy regression tests;
- HTTP/WebSocket session snapshot and delta behavior;
- Conversation/Trajectory tab rendering;
- detailed inline Planner/Kernel/Executor steps;
- sticky composer and sidebar responsive states;
- reconnect and historical browse behavior;
- root and Web TypeScript/build gates.

## Acceptance Criteria

1. The Web surface has a persistent left session rail and one primary canvas.
2. Users can create, browse, activate and continue real persisted sessions.
3. Only one `MetaclawSession` is live at a time.
4. Conversation and Trajectory use the same trace/execution facts.
5. Conversation displays detailed execution logic before the final answer.
6. Trajectory provides dense timing, filtering and structured audit detail.
7. The composer remains stable across tab switches.
8. No hidden reasoning or sensitive raw data enters the browser or session
   projection store.
9. Existing Planner, Kernel, Runtime, Task and Executor ownership remains
   unchanged.
