# ADR-0040: User-Initiated Turn Cancellation

- **Status:** Accepted
- **Date:** 2026-09-18
- **Scope:** Client stop control, in-flight Planner run abort, Turn status, interaction with Task cancellation
- **Amends:** ADR-0022, ADR-0031
- **Preserves:** ADR-0011, ADR-0015, ADR-0020, ADR-0025
- **Related design:** `docs/plans/2026-09-17-attachment-document-ingestion-and-paste-design.md` §15
- **Governed by:** ADR-0020

## Context

A Client could display a "stop" control while a Turn was running, but no turn
cancellation existed:

- `cancel_turn` was defined in the Gateway command union, yet no MetaWork Client
  sent it, and `ConversationSession` answered it with
  `turn cancellation is not available for completed admission`.
- The Web surface sent `/task clear all` from its stop button. That cancels
  **Tasks**. While the Planner was still planning, no Task existed yet, so the
  command reported "取消 0 个任务" and the Planner run continued to completion.
  Its later proposal was admitted, so a blocked/answered Turn appeared after the
  user believed they had stopped it.
- Aborting a Planner process was possible only through
  `PlannerProcessController.stopSession`, which also closes that session for
  good, and it was wired only to standby-TUI shutdown.

The observable consequence was a Client state (`已停止`, Composer re-enabled)
that disagreed with the durable facts: the Planner process kept running, the
proposal was still applied, and a Task could still be created.

## Decision

Turn cancellation is a first-class Client control with these semantics:

1. **The Client requests cancellation of the Turn it is showing.** The Web stop
   control sends a `cancel` frame carrying the current interaction Turn id. The
   Management surface forwards it to the Gateway as the existing
   `cancel_turn` command, so admission and ownership stay on the ordinary
   command path.
2. **Cancellation is latched in the Application Shell for that Turn.** The latch
   is what makes the cancellation a fact rather than a UI gesture: a Planner
   proposal that was already submitted, or that races the abort, is rejected with
   `turn cancelled by user` and never reaches the Kernel. A new Turn clears the
   latch.
3. **The in-flight Planner process is aborted, and the session stays usable.**
   `PlannerProcessController.abortSession` terminates the tracked process of one
   session (SIGTERM, then SIGKILL after the grace period) without adding it to
   the closed-session set, so the same Conversation session serves the next
   Turn. The aborted run is an expected consequence, not a reported failure.
4. **Work that already became a Task is cancelled too.** Cancellation reuses the
   existing Task cancellation fence (Kernel `task_cancel_requested` →
   `cancel_task` → attempt cancellation request → `Executor.abort`), so a Turn
   that had already been admitted stops its Executor as well.
5. **The Turn ends as `cancelled`.** `cancelled` joins the Turn status set
   (`running`, `completed`, `failed`, `blocked`, `cancelled`) and is projected to
   Clients as 已取消. A cancelled Task from the execution timeline keeps the same
   `cancelled` projection instead of being folded into `failed`.
6. **Cancelling a Turn never mutates Kernel policy.** No new Kernel event type is
   introduced: the latch is Application-Shell state, and the Task path uses the
   existing cancellation fence. Cancellation is therefore not a second strategic
   control plane.
7. **A stale or unknown Turn id is a no-op.** Cancellation only applies to the
   Turn the Conversation is currently handling; anything else reports that the
   Turn is no longer running.

## Consequences

- The Client's stop control now matches the durable outcome: the Planner is
  stopped, no Task is created from the cancelled Turn, and any Task already
  admitted is cancelled with its Executor.
- `/task clear all` keeps its Task meaning; it is no longer the stop control.
- Semantic continuity is preserved: the Pi session is not rotated or closed, so
  the next Turn continues the same Conversation session (and its model binding is
  reconciled through `set_model` when the configuration changed).
- Turn cancellation is process-local. If the Server restarts between the
  request and the proposal, the latch is gone; the proposal is then admitted
  normally, which is the same behavior as a Turn that was never cancelled.
- Cancellation is Cooperative for the Executor: an admitted attempt is stopped
  through the Kernel fence, and a cancelled Turn reports the failure facts it
  had, not a fabricated success.

## Validation

Focused tests cover:

- The Web stop control issuing `cancel_turn` rather than a Task command.
- Aborting the Planner run, latching the Turn, and rejecting a late proposal
  (`turn cancelled by user`) without a Kernel submission.
- A non-matching Turn id remaining a no-op.
- Cancelling the Conversation's Task when no Planner run is in flight.
- `abortSession` terminating the process while leaving the session usable for the
  next turn, in contrast with `stopSession`.
