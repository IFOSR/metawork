# Long-Task Execution Visibility Plan

- Date: 2026-09-04
- Status: Proposed (user-approved scope, not yet implemented)
- Trigger: repeated "任务执行到什么程度了？是死机了吗？" during 20–60 minute
  research tasks (WeChat Channels research task sat 55 minutes with no
  user-visible signal after an executor heartbeat loss).

## 1. Problem statement

Long tasks are acceptable; opaque long tasks are not. Today the user cannot
distinguish between:

1. an executor steadily working (tool calls streaming internally),
2. an executor that lost its heartbeat (the Channels task lost its work-unit
   heartbeat at 01:40 and the user saw nothing),
3. Kernel recovery in progress (retry scheduled, continuation dispatch),
4. a genuinely stuck task (the Channels retry then hit the known
   `has no workspace source` payload gap at 01:41 and the task went silent
   for 35+ minutes).

The only feedback channel is the final answer. All intermediate state exists
internally (work-unit heartbeats, kernel events, executor session logs) but
is not projected to users.

## 2. Design

Four layers, each independently shippable, ordered by value/effort.

### L1 — Executor activity stream (the "agent-like" step log)

- Source: Pi/Codex harnesses already emit per-turn/per-tool events into their
  session logs. Project them through the existing executor progress channel
  (`executor_progress` trace events already exist in the Web trace stream).
- Throttle: aggregate into one event per tool-call boundary, at most one every
  ~5 s per attempt; each event carries: step number, tool/command name,
  one-line argument digest, one-line result digest, elapsed time.
- Feishu rendering: a periodically updated progress card (update the same
  message up to Feishu's rate limits; fall back to a new short message every
  2 minutes). Content: current subtask title, current tool, step count,
  elapsed, "N 秒前有活动".
- Web rendering: extend `LiveExecutionPanel` with a collapsible executor
  step list fed by the same events.

### L2 — Heartbeat health indicator (answers "死机了吗")

- The work-unit `heartbeat_at` already exists. Project a health badge into
  both surfaces on a 15 s timer:
  - `⏱ 活跃（3 秒前）` — heartbeat age < 30 s
  - `⚠️ 执行器 {N} 秒无心跳` — 30–120 s
  - `⛔ 执行器失联，Kernel 正在恢复（重试/换执行器）` — on the
    `heartbeat_lost` kernel event, until a terminal or new attempt appears
- Feishu: the badge rides the L1 progress card. Web: badge on the attempt row.

### L3 — Milestone push (already have the events, just deliver them)

Deliver immediately (no throttling) as one-line notices:

- work graph authorized (with subtask count and ETA hint if available)
- subtask started / completed / failed (with attempt ordinal)
- verification started / finished
- publication integrated, delivery dispatched
- recovery decisions: `heartbeat_lost → retry scheduled at T`,
  `attempt failed → Kernel decision: retry/fallback/blocked`

Feishu: short system-style messages or card fields. Web: trace stream already
covers this; ensure the conversation view surfaces them when collapsed.

### L4 — Collapsible detail UI (user's explicit ask)

- Feishu interactive cards support collapsible sections natively: the
  progress card renders a one-line summary; an "展开执行细节" collapsible
  contains the L1 step timeline (last ~20 steps, older collapsed by date).
- Web: `ConversationTurn` already has expand/collapse affordances; add the
  same step timeline section, collapsed by default, with a live step counter
  badge.

### L5 — Natural-language status query

- `/status` (or any "进展如何/还在跑吗" utterance routed by the Planner as a
  status intent) returns an instant snapshot: task title, elapsed, current
  subtask, current tool, heartbeat age, last activity line, recovery state.
- Control commands are already immediate (mailbox fast path), so this works
  even mid-turn.

## 3. Known incident linkage

The Channels task exposed a second must-fix: the retry/continuation dispatch
path still synthesizes items without a workspace payload (P0-5 generation
side, tracked in the 2026-09-03 incident review). The `has no workspace
source` guard fired correctly — no corrupt execution — but the task then sat
blocked with no further retries or user notification. Fix priority:

1. P0-5 generation: continuation dispatches must carry the parent attempt's
   payload (workspacePath/goal) — removes the failure class entirely.
2. Heartbeat-loss recovery UX: when a retry fails to launch, either schedule
   the next retry with backoff or park the task with an explicit user-facing
   notice ("自动恢复失败，等待你确认重试") instead of silence.

## 4. Effort estimate

| Layer | Scope | Estimate |
|---|---|---|
| L2 + L3 | event delivery + badges (no new producers) | ~1 day |
| L5 | status snapshot command | ~0.5 day |
| L1 | executor activity projection + throttling + Feishu card updates | ~2–3 days |
| L4 | collapsible card layout (Feishu) + Web step timeline | ~1 day |
| P0-5 generation fix | Kernel decision-surface change, needs review | ~1 day + review |

Recommended order: L2+L3 (immediate "is it alive" answer), P0-5 (removes the
silent-block failure), L5, then L1+L4 (full step-by-step transparency).
