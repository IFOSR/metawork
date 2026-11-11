# Web Turn-Task Presentation Isolation Design

> **Status:** Approved
> **Design date:** 2026-09-10

## Problem

Web currently retains the correct durable Conversation history but can project
events from an older top-level Task into the newest Turn. The Trajectory then
shows the newest Work Graph beside mixed execution events, while the
Conversation Execution Summary creates cards for Subtasks from both Tasks.

The failure is presentation ownership, not Executor scheduling. A current Task
may still contain multiple concurrent Subtasks and all of those Subtasks must
remain visible.

## Decision

The public Web projection follows this ownership hierarchy:

```text
Conversation -> Turn -> one presentation Task -> Subtasks -> Attempts
```

- A Turn binds to one presentation `taskId`. Once bound, later events cannot
  replace it with another Task.
- Public `execution` messages carry both `turnId` and `taskId`.
- Task-bound trace events are visible in a Turn only when their `taskId`
  matches the Turn's presentation Task.
- Turn-local Planner, intake, and delivery events without a Task identity
  remain visible.
- Execution cards are created from the Turn's durable execution timeline.
  Matching trace events may enrich those cards but may not create cards for a
  different Task.
- Trajectory defaults to the newest Turn. Opening a historical Turn explicitly
  selects that exact `turnId`.
- Conversation history keeps each execution summary attached to its owning
  Turn instead of aggregating historical Tasks under the newest question.

## Historical Data

No Task, trace, artifact, or audit data is deleted. Existing mixed records are
filtered at projection time so they render correctly without a destructive
migration.

## Acceptance

- A completed Task A never appears in Task B's Trajectory or Execution Summary.
- Late Task A events do not change Task B's identity, status, cards, or
  timeline.
- Refresh and reconnect preserve the same isolation.
- Multiple concurrent Subtasks inside Task B remain visible.
- Opening Task A from its historical Turn shows Task A's exact detail.
