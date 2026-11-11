# Long-Task Execution Visibility Plan

- Date: 2026-09-04
- Status: Delivered (core layers L1/L2/L3/L5 + Web badge), 2026-09-05.
  Validation: `tests/gateway` + `tests/integrations` + `tests/web` + focused
  session/e2e suites — 393 tests green; `npm run lint` clean; user-perspective
  E2E `tests/e2e/feishu-long-task-visibility.test.ts` covers the full Feishu
  long-task flow (20 steps + heartbeat loss + recovery → one updating card,
  milestone notices, final answer, background live card).
- Revised: 2026-09-05 — presentation split approved by user: L1 detail lives
  in the trace channel (Web) / collapsible card section (Feishu), never in the
  main conversation/chat flow. See §2.0.
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

### 2.0 Presentation split (user-approved, 2026-09-05)

Core principle: **push state, pull steps**. The main conversation/chat surface
stays clean — it only carries the heartbeat badge (L2), one-line milestones
(L3), and the final answer. Full step-by-step detail (L1) is always available
but never pushed into the main flow:

- **Web**: L1 rides the existing structured `trace_v1` stream
  (`src/management/interaction-trace.ts`) as a new `executor_step` event kind
  (step number, tool name, argument digest, elapsed). It inherits trace replay,
  origin-scoped delivery, and the collapsible trace UI for free. The main
  conversation view is untouched: L2 badge + L3 milestones only. Mental model:
  conversation = conclusions and nodes; trace = complete process.
- **Feishu**: there is no trace pane; the self-updating progress card **is**
  the trace pane. Default render is a one-line status (current subtask,
  current step digest, heartbeat age); step detail sits behind the card's
  collapsible "展开执行细节" section (last ~20 steps). Optionally append the
  full activity log to a Feishu cloud doc via the existing cloud-doc pipeline
  and link it from the card.
- **Required cleanup**: Feishu currently flattens every `trace_delta` into
  plain chat messages (`traceProgressLines` in
  `src/gateway/feishu-gateway-session-port.ts`), which floods the chat on long
  tasks — exactly the noise this plan exists to remove. Implementing L1 must
  replace that path: trace lines converge into the card instead of being
  pushed as standalone progress messages.

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
  2 minutes). Default content: current subtask title, current step digest,
  step count, elapsed, "N 秒前有活动". Step-by-step detail stays in the
  card's collapsible section (see §2.0) — it is never pushed as chat messages.
- Web rendering: emit `executor_step` events into the existing `trace_v1`
  stream; the trace panel renders them as a collapsible step list with a live
  step-counter badge. The main conversation view is not modified.

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
- Web: the trace panel already has expand/collapse affordances; the L1
  `executor_step` list renders there, collapsed by default, with a live step
  counter badge. Nothing is added to the main conversation view.

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
| L1 | executor activity projection + throttling + trace_v1 `executor_step` kind (Web) + Feishu card updates; **includes replacing the `traceProgressLines` chat-flood path** | ~2–3 days |
| L4 | Feishu collapsible card section + Web trace step timeline | ~1 day |
| P0-5 generation fix | Kernel decision-surface change, needs review | ~1 day + review |

Recommended order: L2+L3 (immediate "is it alive" answer), P0-5 (removes the
silent-block failure), L5, then L1+L4 (full step-by-step transparency).

## 5. Delivery record (2026-09-05)

Delivered:

- **Shared core**: `src/gateway/task-activity-tracker.ts` — pure reducer over
  interaction-trace events: step digest (L1), heartbeat health
  active/stale/lost (L2), milestone classification incl. recovery events (L3).
- **Feishu L1/L2/L3**: self-updating activity card. `FeishuAppClient`
  `sendMarkdownCardToChat/Thread` now return `message_id`; new
  `updateMarkdownCard` (PUT); deliveries carry `cardUpdateKey` and are
  upserted in place (`upsertMarkdownCardToFeishuTarget`) with fallback to a
  fresh card. Both the request path (`waitForTerminal` onProgress) and the
  live-attachment path converge trace floods into the card (first paint
  immediate, then throttled, default 5 s, `activityCardMinIntervalMs`).
  Milestones push immediately as one-line messages. The old
  `traceProgressLines` per-line chat flood is removed.
- **L5**: `/status` answered locally in
  `ConversationSession.executeGatewayCommand` from the live interaction trace
  via `src/session/task-status-snapshot.ts` — works on every surface through
  the mailbox fast path, never touches the Planner.
- **Web L2**: `web/src/executor-health.ts` + health badge in
  `LiveExecutionPanel` (stale > 30 s, lost > 120 s). Web L1/L4 were already
  covered by the existing trace panels (executor_progress/heartbeat rendering,
  collapsible detail drawer).

Deferred follow-ups:

- Feishu native `collapsible_panel` card schema for the step section (today
  the card inlines the last 5 steps, which already satisfies pull-not-push).
- Planner-routed natural-language status intent (`/status` works everywhere;
  "进展如何" free-text routing is Planner-side).
- During total executor silence the Feishu card health ages via incoming
  `executor_heartbeat` trace events; a pure timer-based refresh remains a
  nicety.
