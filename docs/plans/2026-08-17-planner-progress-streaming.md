# Planner Progress Streaming Implementation Plan

**Goal:** Stream safe Planner lifecycle and tool progress into the Web interaction
trace while showing elapsed time for the currently running turn.

**Architecture:** Extend the existing Planner runner with a presentation-only
progress observer. The RPC supervisor projects only lifecycle facts, tool names,
field names, status, and elapsed time. `MetaclawSession` appends those facts to
the existing bounded `InteractionTrace`; the current WebSocket snapshot/delta
transport remains unchanged. The Web panel renders every delta immediately and
maintains a local elapsed-time indicator while the trace is running.

**Privacy boundary:** Do not expose hidden chain-of-thought, assistant text,
thinking deltas, raw prompts, tool argument values, tool results, stdout/stderr,
credentials, or secrets.

> Status: Completed
> Plan date: 2026-08-17
> Completion date: 2026-08-17

## Completion Record

Delivered safe Planner lifecycle/tool progress forwarding through the existing
InteractionTrace and WebSocket delta path, plus a live elapsed-time indicator
for the active Web phase. No hidden reasoning, raw model text, prompt, tool
argument values, sensitive field names, raw tool results, credentials or
stdout/stderr are exposed.

Validation: focused Planner, Session, Web interaction-trace, root TypeScript
lint/build, and Web TypeScript/build checks passed.

## Tasks

1. Add a typed, bounded Planner progress contract and prove the RPC supervisor
   emits lifecycle and tool events as JSONL arrives.
2. Forward the observer through `AnyFusionPlanningAgent` and append safe progress
   events from `MetaclawSession`.
3. Add a live elapsed-time indicator to the Web interaction trace.
4. Run focused Planner, Session, management, and Web tests plus root/Web builds
   and TypeScript checks; then record completion evidence here.
